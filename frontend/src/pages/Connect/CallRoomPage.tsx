import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRoomContext,
  RoomAudioRenderer,
  ConnectionStateToast,
  useTracks,
} from '@livekit/components-react';
import { supportsScreenSharing } from '@livekit/components-core';
import {
  VideoPresets,
  ScreenSharePresets,
  Track,
  ParticipantEvent,
  RoomEvent,
  TrackEvent,
  type RoomOptions,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { MicVAD } from '@ricky0123/vad-web';
import { GtcrnNoiseCancelTrack, GTCRN_PIPELINE_LATENCY_MS } from '../../lib/audio/gtcrn/GtcrnNoiseCancelTrack';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import '@livekit/components-styles';
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Copy,
  Check,
  Volume2,
  X,
  Mic,
  MicOff,
  Video,
  VideoOff,
  PictureInPicture2,
  ScreenShare,
  MessageSquare,
  PhoneOff,
  Ellipsis,
  ChevronUp,
  ChevronRight,
  LayoutGrid,
  Maximize2,
  DoorOpen,
  Ban,
  Droplets,
  CircleDot,
  StopCircle,
  Image as ImageIcon,
  Users,
  Smile,
} from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import PreJoinScreen, { type PreJoinChoices } from '../../components/Connect/PreJoinScreen';
import MiniRoomPanel from '../../components/Connect/MiniRoomPanel';
import ParticipantsPanel from '../../components/Connect/ParticipantsPanel';
import { useConnectWaitlist } from '../../hooks/useConnectWaitlist';
import { useRoomHosts } from '../../hooks/useRoomHosts';
import MiniRoomMoveToast from '../../components/Connect/MiniRoomMoveToast';
import MiniRoomAssignDialog from '../../components/Connect/MiniRoomAssignDialog';
import { useAuth } from '../../context/AuthContext';
import { useRecording } from './useRecording';
import { useRecordingSync } from './useRecordingSync';
import { useMiniRooms, type UseMiniRoomsResult, type ReconnectTarget } from '../../hooks/useMiniRooms';
import { useDocumentPiP } from '../../hooks/useDocumentPiP';
import { useActiveSpeakerVideoPip } from '../../hooks/useActiveSpeakerVideoPip';
import { useAdvancedChat } from '../../hooks/useAdvancedChat';
import { useReactions } from '../../hooks/useReactions';
import { ReactionProvider, useReactionActions } from '../../contexts/ReactionContext';
import { ReactionPicker } from '../../components/Connect/ReactionPicker';
import { FloatingReactionsStream } from '../../components/Connect/FloatingReactionsStream';
import DocumentPipContent from './DocumentPipContent';
import { useBackgroundEffect, PRESETS } from './useBackgroundEffect';
import { isMobileDevice } from './backgroundLibrary';
import { VideoDelayPipeline, isVideoDelaySupported } from '../../lib/video/VideoDelayPipeline';
import BackgroundEffectModal from '../../components/Connect/BackgroundEffectModal';
import AdvancedChat from '../../components/Connect/AdvancedChat';
import ProfileSidebarPanel from '../../components/Connect/ProfileSidebarPanel';
import LeaveConfirmModal from '../../components/Connect/LeaveConfirmModal';
import HostLeaveWarningModal from '../../components/Connect/HostLeaveWarningModal';
import ClaimHostModal from '../../components/Connect/ClaimHostModal';
import GridLayoutView from '../../components/Connect/callLayout/GridLayoutView';
import StageLayoutView from '../../components/Connect/callLayout/StageLayoutView';
import {
  useCallLayout,
  type CallLayout,
  type LayoutMode,
} from '../../components/Connect/callLayout/useCallLayout';

/**
 * Shared look for every control-bar button (mic, camera, screen-share, chat,
 * more, leave) — icon on top, small label underneath. Wide enough for comfortable
 * clicking with generous horizontal breathing room.
 */
function controlButtonClass(active: boolean, danger = false) {
  const base =
    'flex flex-col items-center justify-center gap-0.5 min-w-[4.25rem] sm:min-w-[4.75rem] h-[52px] px-3.5 py-1.5 rounded-xl border transition-all duration-200 active:scale-95 shrink-0';
  if (danger) {
    return `${base} text-rose-400 border-rose-500/40 bg-gray-900/80 hover:bg-rose-500/10 hover:border-rose-500/60`;
  }
  return `${base} ${
    active
      ? 'bg-sky-600/90 text-white border-sky-400/50 hover:bg-sky-600'
      : 'bg-gray-900/80 text-gray-200 border-gray-700/80 hover:bg-gray-800'
  }`;
}

function ControlButtonLabel({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-bold leading-none whitespace-nowrap">{children}</span>;
}

/**
 * Tracks an element's rendered width via ResizeObserver, so layout code can react
 * to the *actual* space available (container width) rather than guessing from the
 * viewport breakpoint — the control bar can be squeezed by the chat sidebar, not
 * just by a narrow phone.
 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

// Silero's own frame-processor (see @ricky0123/vad-web/dist/frame-processor.js) calls
// onSpeechStart the instant a frame's isSpeech crosses positiveSpeechThreshold — there's no
// extra multi-frame confirmation delay before that callback fires. So the ~200-300ms of lag
// that made word-onsets sound clipped comes from frame quantization, not from waiting on the
// callback: the "legacy" Silero model only makes one decision per 1536-sample (96ms) frame, so
// speech can be underway for the better part of a frame before the model even gets to look at
// it. The "v5" model decides every 512 samples (32ms) instead — same detection logic, ~3x finer
// time resolution — which is the actual lever here. positiveSpeechThreshold is the other one:
// lower it and onSpeechStart fires with less confidence required, at the cost of triggering on
// weaker/more ambiguous sounds. Tune both together while listening to real audio.
//
// onFrameProcessed deliberately isn't used to open the gate any earlier than onSpeechStart:
// it fires on the exact same tick, one line earlier in the same function, so gating from it
// with the *same* threshold buys nothing. Gating from it with a *lower* threshold reproduces
// the bug this file already went through and out the other side of — Silero's onSpeechEnd/
// onVADMisfire only fire for a segment its own state machine decided to start (isSpeech >=
// positiveSpeechThreshold), so opening on anything below that threshold opens a gate nothing
// will ever close. It's used here purely to log the raw probability stream for tuning the two
// values above against real recordings — never to drive the gate.
// Measured from real "silero frame" logs: typing alone tops out around isSpeech=0.02, but
// typing *while talking* pulls the model's confidence for the speech itself way down too
// (the keyboard noise degrades the signal, not just adds a separate one) — peaks around
// 0.16-0.73 with lots of dips in between, well under the previous 0.25 threshold, so most of
// those utterances opened briefly then immediately misfired shut instead of staying open.
// 0.12/0.08 sits comfortably above the typing-only floor while catching that degraded range —
// for a quiet room. A noisy one needs a stricter threshold, and there's no fixed value that's
// right for both: this is a property of tonight's environment, not of the app, so it's a user
// setting (the "ノイズキャンセリングレベル" slider in the mic menu) rather than a constant.
// VAD_POSITIVE_SPEECH_THRESHOLD is that setting's default; VAD_NEGATIVE_SPEECH_THRESHOLD tracks
// whatever the user picks at a fixed gap below it — see vadNegativeThresholdFor.
const VAD_MODEL: 'v5' | 'legacy' = 'v5';
const VAD_POSITIVE_SPEECH_THRESHOLD = 0.12;
const VAD_SENSITIVITY_MIN = 0.05;
const VAD_SENSITIVITY_MAX = 0.5;
// Matches Silero's own default gap (positiveSpeechThreshold 0.3, negativeSpeechThreshold 0.25).
const VAD_NEGATIVE_THRESHOLD_GAP = 0.05;

function vadNegativeThresholdFor(positiveThreshold: number): number {
  return Math.max(0.01, positiveThreshold - VAD_NEGATIVE_THRESHOLD_GAP);
}
// onVADMisfire fires whenever a segment's *total* qualifying-frame count over its whole
// duration never reached minSpeechMs (400ms) worth — which real speech easily fails if its
// confidence dips below threshold even briefly mid-word, since Silero discards the entire
// segment rather than just the low-confidence dip. Closing the gate the instant that happens
// chops speech into stuttering fragments. Instead of closing immediately on misfire, hold the
// gate open for a short grace window: another onSpeechStart within it (very likely, if the
// speaker is mid-sentence) refreshes the window with no audible gap; only genuine silence lets
// it run out.
const VAD_HOLD_OPEN_AFTER_MISFIRE_MS = 600;
// Every Nth frame's probabilities get logged (32ms/frame on v5, so 15 ≈ every 480ms).
const VAD_LOG_FRAME_EVERY = 15;

// Thresholds and the misfire hold-timer only ever shrink *how much* of an onset gets clipped —
// a confidence-based decision can't be made before there's enough signal to be confident about,
// so some amount of lag before onSpeechStart fires is unavoidable no matter how it's tuned.
// This is the structural fix instead: route the mic through a DelayNode before it ever reaches
// the gate, and let the VAD analyze the *undelayed* signal to decide as fast as it already does.
// When onSpeechStart fires at real-clock time T, the audio actually reaching the delay line's
// output at T is still whatever was captured D ms earlier — i.e. the moment speech actually
// started, not the moment Silero became confident about it — so opening the gate at T (instead
// of trying to open it earlier) is enough to let that already-buffered onset through. As long as
// D covers the worst-case detection lag, the clipping goes away entirely, at the cost of a fixed
// D-ms delay on the whole call, always — not just at speech onset. 800ms matches Silero's own
// preSpeechPadMs default (its authors picked that for exactly this kind of lookback); tune it
// down from there once this is confirmed to actually fix the clipping.
const GATE_DELAY_MS = 200;
// Gain is ramped rather than stepped: an instant 0<->1 jump on a live signal is an audible click.
const GATE_RAMP_MS = 15;

// Whatever stage currently feeds the sender: a LiveKit processor's output when one is attached
// (the background effect, for video — nothing attaches one for audio anymore now that Krisp is
// gone), the raw capture otherwise. Deliberately NOT sender.track — once the gate graph below is
// installed that *is* our own output, and feeding it back in would loop the pipeline into itself.
function resolveUpstreamTrack(track: LocalAudioTrack | LocalVideoTrack): MediaStreamTrack {
  return track.getProcessor()?.processedTrack ?? track.mediaStreamTrack;
}

function vadLog(msg: string, data?: Record<string, unknown>) {
  console.log(`[Connect VAD] ${msg}`, data ?? '');
}

/**
 * Owns the outgoing mic pipeline: optionally cleans it up with GTCRN noise cancellation, and
 * optionally silences it entirely whenever the local participant isn't actually speaking (the
 * VAD auto-gate). Both are independently toggleable, but live in one hook/one effect — not two
 * — because both need to control the same sender, and this file already learned the hard way
 * (see the reattachUpstream/reassertSenderTrack comment below) what happens when two independent
 * pieces of code race to call sender.replaceTrack() on the same track. When VAD is off but
 * noise-cancel is on, the gate/delay stage still runs, just permanently open with zero delay —
 * a transparent pass-through around the (still active) noise-cancel stage.
 *
 * @param enabled VAD auto-gate on/off.
 * @param sensitivity positiveSpeechThreshold — how loud/clear speech has to be before the gate
 *   opens. Lower catches quieter speech but lets more background noise through; higher rejects
 *   more noise but can clip quiet speech. The right value is a property of the room the user is
 *   currently in, not something the app can know in advance, hence a live-adjustable setting
 *   rather than a constant — see the comment above VAD_POSITIVE_SPEECH_THRESHOLD.
 * @param noiseCancelEnabled GTCRN noise cancellation on/off.
 */
function useVadAutoGate(enabled: boolean, sensitivity: number, noiseCancelEnabled: boolean) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [loading, setLoading] = useState(false);
  const [trackEpoch, setTrackEpoch] = useState(0);

  // Manual mute must always win: LiveKit mutes by stopping the capture track outright, so it
  // silences things on its own, but the gate still has to stay shut so an unmute doesn't
  // resume mid-"open" and leak whatever the VAD last decided.
  const isMicrophoneEnabledRef = useRef(isMicrophoneEnabled);
  const setGateRef = useRef<((open: boolean, reason: string) => void) | null>(null);
  // Live-updated via vad.setOptions() (see the effect below) rather than rebuilding the whole
  // pipeline on every slider move — that would reload the ONNX model each time.
  const vadRef = useRef<MicVAD | null>(null);
  // Bumped once at the top of every run of the main effect below. A run's cleanup captures the
  // value it was born with and, right before its own "restore the raw mic to the sender" call,
  // checks it's still current — see the long comment at that call site for why a same-tick
  // track-id check alone isn't enough to prevent it from clobbering a newer run's own sender
  // assignment (replaceTrack() is itself async and can resolve after a faster newer run's own
  // replaceTrack() already has, even when the id check passed before either call started).
  const generationRef = useRef(0);

  useEffect(() => {
    isMicrophoneEnabledRef.current = isMicrophoneEnabled;
    if (!isMicrophoneEnabled) {
      setGateRef.current?.(false, 'manual mute');
    } else if (!enabled) {
      // With VAD running, deliberately *don't* reopen here — onSpeechStart does that once real
      // speech resumes, and reopening blind on unmute would leak whatever stale "was speaking"
      // state the gate had before the mute (see the file-level comment on this hook). But with
      // VAD off (noise-cancel-only mode) nothing else ever calls setGate(true, ...) — there's no
      // speech detector to do it — so without this branch, one manual mute/unmute cycle wedges
      // the gate shut for the rest of the call: closing on mute isn't just a VAD nicety, it's
      // load-bearing even here, since GtcrnNoiseCancelTrack processes a *clone* of the raw mic
      // track, and a clone's `.enabled` is independent of the original's — LiveKit's own mute
      // (which just flips `.enabled` on the original) never reaches it, so this gate is the only
      // thing that actually silences outgoing audio while muted in this mode.
      setGateRef.current?.(true, 'manual unmute (no VAD to reopen it)');
    }
  }, [isMicrophoneEnabled, enabled]);

  useEffect(() => {
    vadRef.current?.setOptions({
      positiveSpeechThreshold: sensitivity,
      negativeSpeechThreshold: vadNegativeThresholdFor(sensitivity),
    });
  }, [sensitivity]);

  useEffect(() => {
    // Only restart the VAD when the microphone track itself changes (e.g. device
    // switch). Camera/screen-share publish events also fire LocalTrackPublished;
    // reacting to those tore down and rebuilt the VAD on every screen share
    // start/stop, and if speech detection didn't fire right after, the mic stayed
    // gated closed even though the UI still showed it as unmuted.
    const bump = (publication: { source?: Track.Source }) => {
      if (publication?.source !== Track.Source.Microphone) return;
      setTrackEpoch((n) => n + 1);
    };
    localParticipant.on(ParticipantEvent.LocalTrackPublished, bump);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, bump);
    };
  }, [localParticipant]);

  useEffect(() => {
    if (!enabled && !noiseCancelEnabled) return;

    const myGeneration = ++generationRef.current;
    let cancelled = false;
    let vad: MicVAD | null = null;
    let vadTrack: MediaStreamTrack | null = null;
    let misfireHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let gateCtx: AudioContext | null = null;
    let delayNode: DelayNode | null = null;
    let gainNode: GainNode | null = null;
    // Seeded from the live ref, not hardcoded true: React runs every changed effect's cleanup
    // (in hook-declaration order) before running any changed effect's setup, so when `enabled`
    // itself is what's changing, the isMicrophoneEnabledRef effect above — which tries to
    // reopen the gate on unmute when VAD isn't running to do it — executes in the window after
    // this effect's *previous* run has already been torn down (nulling setGateRef.current) but
    // before *this* run has rebuilt it, so that call silently no-ops. Reading the current mic
    // state directly here instead means a fresh instance always starts correctly synced to it,
    // independent of that ordering race — confirmed live: toggling VAD off while already
    // unmuted rebuilt this effect and the gate came up wedged shut with no further "gate CLOSE"
    // ever logged, because there was nothing left here to have forced it open.
    let gateOpen = isMicrophoneEnabledRef.current;
    let gatedOutputTrack: MediaStreamTrack | null = null;
    let currentSourceNode: MediaStreamAudioSourceNode | null = null;
    let currentSourceTrack: MediaStreamTrack | null = null;
    let currentUpstreamId: string | null = null;
    let micTrack: LocalAudioTrack | null = null;
    let unusableSender: RTCRtpSender | null = null;
    let detachTrackListeners: (() => void) | null = null;
    let noiseCancelTrack: GtcrnNoiseCancelTrack | null = null;
    let selfHealInterval: ReturnType<typeof setInterval> | null = null;

    // Gates by ramping a GainNode the mic is routed through (downstream of the delay line
    // below), not by toggling MediaStreamTrack.enabled — this file went through a whole saga
    // establishing that .enabled doesn't reliably silence what a remote listener hears once
    // Krisp/other processing is in the chain (see git history), whereas a zeroed gain is
    // literal zeroed samples with nothing downstream left to disagree about.
    const setGate = (open: boolean, reason: string) => {
      if (!gainNode || !gateCtx) {
        vadLog('gate change dropped: graph not built yet', { open, reason });
        return;
      }
      // Never let VAD re-open a mic the user has manually muted.
      if (open && !isMicrophoneEnabledRef.current) {
        vadLog('gate OPEN blocked: isMicrophoneEnabled is false', { reason });
        return;
      }
      if (gateOpen === open) return;
      gateOpen = open;
      vadLog(`gate ${open ? 'OPEN' : 'CLOSE'}`, { reason });
      const now = gateCtx.currentTime;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(open ? 1 : 0, now + GATE_RAMP_MS / 1000);
    };
    setGateRef.current = setGate;

    const clearMisfireHoldTimer = () => {
      if (misfireHoldTimer !== null) {
        clearTimeout(misfireHoldTimer);
        misfireHoldTimer = null;
      }
    };

    // Krisp's own setProcessor() (async — it loads WASM) can finish well after this graph is
    // already installed, and it silently calls sender.replaceTrack() with *its* processedTrack
    // when it does — measured via "silero frame"'s senderTrackMatchesGate: this was landing
    // 100% of the time, meaning every gate decision was operating on a track nobody was
    // listening to. Reacting to that via React state (setTrackEpoch) was too slow — the
    // rebuild happened on the next render, well after Krisp had already won the sender. Both
    // fixes below run synchronously instead, no React round-trip:
    //  1. reattachUpstream swaps the graph's *input* to whatever Krisp (or the raw capture) is
    //     currently producing, without tearing down the delay/gain/destination chain.
    //  2. reassertSenderTrack points the sender back at our output if anything else has since
    //     replaced it. Called both directly from the track's own events (same tick, after
    //     Krisp's own replaceTrack has already resolved) and every VAD frame (~32ms) as a
    //     self-healing net that doesn't depend on correctly anticipating every event that could
    //     cause a hijack.
    const reattachUpstream = (track: LocalAudioTrack) => {
      if (!gateCtx || !delayNode) return;
      // Prefer the noise-cancelled output when that stage is running; resolveUpstreamTrack
      // falls back to the raw capture (no processor is ever attached to the mic track anymore
      // now that Krisp is gone, so this always resolves to track.mediaStreamTrack in practice).
      const upstream = noiseCancelTrack?.track ?? resolveUpstreamTrack(track);
      // Compared against the upstream's own id, not currentSourceTrack's — currentSourceTrack is
      // a *clone* of whatever upstream previously was, and a clone always gets a fresh id, so
      // comparing clone-to-upstream was always false and rebuilt this graph on every single call
      // (every mute/unmute, every self-heal tick), each time briefly disconnecting and
      // reconnecting the source node for no reason.
      if (currentUpstreamId === upstream.id) return;
      currentUpstreamId = upstream.id;
      currentSourceNode?.disconnect();
      currentSourceTrack?.stop();
      const clonedUpstream = upstream.clone();
      // clone() snapshots .enabled from the source at clone time and never updates it again —
      // if upstream happens to be raw mic (noise-cancel unavailable) and the mic was mid-mute
      // at that exact moment, this clone is silently disabled forever, even after the real mic
      // unmutes (confirmed live: this is what was wedging VAD's own input clone shut on slow,
      // first-time model downloads — see vadTrack below). Actual muting already goes through
      // the GainNode, not this track's .enabled, so there's no reason for this clone to ever be
      // disabled in the first place.
      clonedUpstream.enabled = true;
      currentSourceTrack = clonedUpstream;
      currentSourceNode = gateCtx.createMediaStreamSource(new MediaStream([clonedUpstream]));
      currentSourceNode.connect(delayNode);
      vadLog('gate graph source reattached', {
        upstreamTrackId: upstream.id,
        // The gate wiring alone (sender -> gatedOutputTrack) can't tell you whether the audio
        // actually flowing through it went through GTCRN or is raw mic — this can. If
        // noiseCancelEnabled is true but this says 'raw mic (noise-cancel unavailable)',
        // GtcrnNoiseCancelTrack.create() failed (see the '[Connect] GTCRN' logs for why) and
        // everything downstream is silently working exactly as designed, just unprocessed.
        upstreamSource: noiseCancelTrack ? 'GTCRN-processed' : 'raw mic (noise-cancel unavailable)',
      });
    };

    const reassertSenderTrack = (track: LocalAudioTrack) => {
      if (!gatedOutputTrack) return;
      const sender = track.sender;
      if (!sender || sender === unusableSender || sender.track?.id === gatedOutputTrack.id) return;
      // Leaving the room closes the peer connection while this per-frame loop is still running,
      // and replaceTrack() throws once it is. Latched per sender object rather than outright, so
      // a reconnect (which brings a new sender) starts clean.
      if (sender.transport?.state === 'closed') {
        unusableSender = sender;
        return;
      }
      const hijackedId = sender.track?.id ?? null;
      // A bare track id doesn't say much on its own — name it against every candidate this
      // closure actually knows about, so a hijack log is diagnostic instead of just alarming.
      const hijackedByKnownTrack =
        hijackedId === null
          ? '(none — sender.track is null)'
          : hijackedId === track.mediaStreamTrack.id
            ? 'raw mic (track.mediaStreamTrack)'
            : hijackedId === noiseCancelTrack?.track.id
              ? "GTCRN output (this run's noiseCancelTrack)"
              : hijackedId === currentSourceTrack?.id
                ? 'gate input clone (currentSourceTrack)'
                : '(unrecognized — not raw mic, this GTCRN instance, or the gate input clone)';
      vadLog('gate reasserted onto sender (was hijacked)', {
        hijackedByTrackId: hijackedId ?? '(none)',
        hijackedByKnownTrack,
      });
      sender.replaceTrack(gatedOutputTrack).catch((e) => {
        unusableSender = sender;
        console.error('[Connect] failed to reassert audio gate onto sender:', e);
      });
    };

    // Builds the persistent delay+gain+destination chain once; reattachUpstream feeds it and
    // can be called again later without rebuilding this part.
    const buildGateGraph = async (track: LocalAudioTrack) => {
      gateCtx = new AudioContext();
      // A freshly constructed AudioContext can start life 'suspended' under the browsers'
      // autoplay policy — and since this whole pipeline is built from a useEffect (async, well
      // removed from the click that joined the call), it sometimes never gets the implicit
      // resume a same-tick user gesture would have given it. Suspended means every node
      // downstream, including the GainNode feeding the sender, produces silence — the mic
      // *looks* published and unmuted but nothing is actually flowing. Toggling the auto-gate/
      // noise-cancel switch (a fresh click, i.e. a fresh gesture) rebuilds this from scratch and
      // "fixes" it, which is what made this so confusing to reproduce. Resuming explicitly here
      // removes the guesswork.
      if (gateCtx.state === 'suspended') {
        await gateCtx.resume().catch((e) => console.error('[Connect] failed to resume gate AudioContext:', e));
      }
      // The delay only exists to preserve onset audio for the VAD gate (see GATE_DELAY_MS's
      // comment) — with VAD off there's nothing to preserve it for, so skip straight to a
      // (still gate-controlled, just permanently-open) pass-through instead of adding latency
      // for no reason.
      const activeDelayMs = enabled ? GATE_DELAY_MS : 0;
      delayNode = gateCtx.createDelay(Math.max(activeDelayMs, 1) / 1000 + 0.1);
      delayNode.delayTime.value = activeDelayMs / 1000;
      gainNode = gateCtx.createGain();
      gainNode.gain.value = gateOpen ? 1 : 0;
      const destination = gateCtx.createMediaStreamDestination();
      delayNode.connect(gainNode);
      gainNode.connect(destination);
      gatedOutputTrack = destination.stream.getAudioTracks()[0];
      reattachUpstream(track);
      await track.sender?.replaceTrack(gatedOutputTrack);
      vadLog('gate graph installed', {
        delayMs: activeDelayMs,
        noiseCancelEnabled,
        gatedOutputTrackId: gatedOutputTrack.id,
        senderTrackId: track.sender?.track?.id ?? '(no sender)',
        gateCtxState: gateCtx.state,
        isMicrophoneEnabled: isMicrophoneEnabledRef.current,
      });
    };

    const start = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track as LocalAudioTrack | undefined;
      if (!track) return;
      micTrack = track;

      // Only a genuine device switch (a new LocalAudioTrack object, via LocalTrackPublished —
      // handled by the effect above) needs a full restart. Krisp attaching/detaching and a
      // manual mute/unmute cycle just change what feeds the *same* track's sender, which
      // reattachUpstream + reassertSenderTrack handle immediately without tearing anything down.
      const onUpstreamChange = (eventName: string) => () => {
        vadLog('track event fired', { eventName });
        reattachUpstream(track);
        reassertSenderTrack(track);
      };
      const onTrackProcessorUpdate = onUpstreamChange('TrackProcessorUpdate');
      const onRestarted = onUpstreamChange('Restarted');
      const onUnmuted = onUpstreamChange('Unmuted');
      track.on(TrackEvent.TrackProcessorUpdate, onTrackProcessorUpdate);
      track.on(TrackEvent.Restarted, onRestarted);
      track.on(TrackEvent.Unmuted, onUnmuted);
      detachTrackListeners = () => {
        track.off(TrackEvent.TrackProcessorUpdate, onTrackProcessorUpdate);
        track.off(TrackEvent.Restarted, onRestarted);
        track.off(TrackEvent.Unmuted, onUnmuted);
      };
      // Belt-and-suspenders self-heal that runs regardless of whether VAD is enabled: VAD's own
      // onFrameProcessed callback already reasserts every ~32ms while it's running, but with VAD
      // off (noise-cancel-only mode) nothing else does, so a hijack from a source we haven't
      // even identified yet — see the 'gate reasserted onto sender' log — could otherwise sit
      // silently forever, same as the bug the noise-cancel-only case has already hit twice.
      selfHealInterval = setInterval(() => reassertSenderTrack(track), 500);

      if (noiseCancelEnabled) {
        try {
          noiseCancelTrack = await GtcrnNoiseCancelTrack.create(track.mediaStreamTrack);
        } catch (e) {
          console.error('[Connect] failed to start noise cancellation, falling back to raw mic:', e);
          noiseCancelTrack = null;
        }
        if (cancelled) {
          noiseCancelTrack?.stop();
          return;
        }
      }

      await buildGateGraph(track);
      if (cancelled) return;

      if (!enabled) {
        // Noise-cancel-only: the gate graph above is already a permanently-open, zero-delay
        // pass-through around whatever noiseCancelTrack produced — nothing further to set up.
        setLoading(false);
        return;
      }

      // VAD listens on the raw capture — undelayed, pre-gate, pre-noise-cancel — so its
      // decision timing is exactly what it already was; only the *output* passes through the
      // gate (and optionally noise-cancel), not the analysis.
      vadTrack = track.mediaStreamTrack.clone();
      // clone() snapshots .enabled from the source at clone time and never updates it again — if
      // the raw mic happens to be mid-mute (.enabled false) at this exact moment, this clone is
      // silently disabled forever, even once the real mic unmutes right after. Confirmed live:
      // on a slow, first-time model download, VAD's peakAmplitude sat at literal 0.0000 for the
      // entire call, root cause traced to exactly this ('vad track health' log showed vadTrack
      // stuck enabled=false while rawMicTrack read enabled=true moments later). VAD's decision
      // should never depend on LiveKit's mute state anyway — actual muting already goes through
      // the GainNode downstream, not this track's .enabled — so just force it live.
      vadTrack.enabled = true;
      const vadStream = new MediaStream([vadTrack]);

      setLoading(true);
      let frameCount = 0;
      try {
        vad = await MicVAD.new({
          // Reuse the gate's own context (already explicitly resumed above) instead of letting
          // vad-web create a second, unmanaged one of its own — vad-web never calls .resume()
          // on whichever AudioContext it ends up with, so a self-created one is just as exposed
          // to the same "stuck suspended" failure mode this whole comment block is about.
          audioContext: gateCtx ?? undefined,
          model: VAD_MODEL,
          // Initial value only — the effect above pushes changes live via setOptions() once
          // vadRef.current is set below, so the slider doesn't rebuild this whole pipeline.
          positiveSpeechThreshold: sensitivity,
          negativeSpeechThreshold: vadNegativeThresholdFor(sensitivity),
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          ortConfig: (ort) => {
            ort.env.logLevel = 'error';
            ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
          },
          getStream: async () => vadStream,
          pauseStream: async () => {},
          resumeStream: async () => vadStream,
          // Diagnostics only — never gates. See the comment above this hook for why gating
          // from this callback (rather than onSpeechStart) would be a bad idea.
          onFrameProcessed: (probabilities, frame) => {
            frameCount += 1;
            // Self-healing net independent of the track event listeners above: runs every
            // frame (~32ms) regardless of which specific event caused a hijack, or whether one
            // fired at all.
            if (micTrack) reassertSenderTrack(micTrack);
            if (frameCount % VAD_LOG_FRAME_EVERY === 0) {
              // peakAmplitude is the raw signal Silero actually saw for this frame (post-
              // resample, pre-model), independent of what the model made of it. If this stays
              // ~0 during clear speech, nothing's reaching the model at all — a capture/
              // plumbing problem, not a threshold one. Typical speech peaks land >0.1-0.3.
              let peakAmplitude = 0;
              for (let i = 0; i < frame.length; i++) {
                const abs = Math.abs(frame[i]);
                if (abs > peakAmplitude) peakAmplitude = abs;
              }
              const liveSenderTrackId = micTrack?.sender?.track?.id ?? '(no sender)';
              const hijacked = liveSenderTrackId !== (gatedOutputTrack?.id ?? null);
              // Plain string, not an object, so it survives being copy-pasted from a collapsed
              // console line (nested-object previews keep getting truncated with '…' — this
              // can't be). Targets one specific open question: when peakAmplitude sits at
              // literal 0 the whole call, is VAD's own input clone reporting itself healthy
              // (live, unmuted) while still producing silence — a Web Audio graph problem — or
              // does the clone (or the raw mic track it was cloned from) show muted/ended itself,
              // which would point at the underlying hardware capture instead, upstream of
              // anything this file controls.
              console.log(
                `[Connect VAD] vad track health: vadTrack(readyState=${vadTrack?.readyState}, muted=${vadTrack?.muted}, enabled=${vadTrack?.enabled}) rawMicTrack(readyState=${track.mediaStreamTrack.readyState}, muted=${track.mediaStreamTrack.muted}, enabled=${track.mediaStreamTrack.enabled})`,
              );
              vadLog('silero frame', {
                isSpeech: probabilities.isSpeech.toFixed(3),
                notSpeech: probabilities.notSpeech.toFixed(3),
                peakAmplitude: peakAmplitude.toFixed(4),
                gateOpen,
                gateCtxState: gateCtx?.state ?? '(no context)',
                isMicrophoneEnabled: isMicrophoneEnabledRef.current,
                senderTrackMatchesGate: !hijacked,
                ...(hijacked ? { liveSenderTrackId, expectedGatedTrackId: gatedOutputTrack?.id } : {}),
              });
            }
          },
          onSpeechStart: () => {
            clearMisfireHoldTimer();
            setGate(true, 'silero onSpeechStart');
          },
          onSpeechEnd: () => {
            // A real, confirmed end of speech — no reason to wait any further.
            clearMisfireHoldTimer();
            setGate(false, 'silero onSpeechEnd');
          },
          onVADMisfire: () => {
            // Don't slam the gate shut here — see VAD_HOLD_OPEN_AFTER_MISFIRE_MS above. If
            // speech resumes before the timer fires, onSpeechStart above clears it and the
            // gate never audibly closed at all.
            clearMisfireHoldTimer();
            misfireHoldTimer = setTimeout(() => {
              misfireHoldTimer = null;
              setGate(false, `hold-open timeout after misfire (${VAD_HOLD_OPEN_AFTER_MISFIRE_MS}ms)`);
            }, VAD_HOLD_OPEN_AFTER_MISFIRE_MS);
          },
        });
        if (cancelled) {
          await vad.destroy();
          vad = null;
          return;
        }
        vadRef.current = vad;
        setGate(false, 'vad ready, initial close');
      } catch (e) {
        console.error('[Connect] failed to start VAD auto-gate:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // start()'s own try/catch only covers VAD startup; the gate graph is built before it, and
    // its replaceTrack throws outright if the peer connection went away mid-setup.
    void start().catch((e) => console.error('[Connect] failed to set up audio gate:', e));

    return () => {
      cancelled = true;
      setLoading(false);
      clearMisfireHoldTimer();
      if (selfHealInterval !== null) clearInterval(selfHealInterval);
      setGateRef.current = null;
      vadRef.current = null;
      detachTrackListeners?.();
      // Stopped immediately, before the slow `await vad?.destroy()` below, so a new run's own
      // GTCRN instance (built right away if noiseCancelEnabled stays true) doesn't spend that
      // whole window running ONNX inference twice over — observed live as inference time
      // spiking from ~6ms to 35-125ms right as a new run started, easing back down over the
      // following seconds as this old instance's stop() finally landed.
      noiseCancelTrack?.stop();
      void (async () => {
        try {
          await vad?.destroy();
        } catch (e) {
          console.error('[Connect] failed to destroy VAD:', e);
        }
        vadTrack?.stop();
        // Hand the sender back the track it would have had without the gate, or the mic goes
        // permanently silent the moment auto-gate is switched off. Skipped once the peer
        // connection is gone — there's nothing to restore onto, and that's the normal case
        // here, since leaving the room is what tore this down.
        //
        // This whole cleanup runs as an un-awaited async IIFE (React doesn't wait out a
        // cleanup's returned promise before mounting the next effect run), and the await above
        // — tearing down the AudioWorklet — is slow enough that the *next* run's start() (e.g.
        // toggling this same switch back on, or noiseCancelEnabled flipping) routinely finishes
        // building its own gate graph and calling replaceTrack() before we get here.
        //
        // An id check alone ("is the sender still pointing at what I installed?") isn't enough:
        // it can pass and then still lose, because replaceTrack() is itself async — a newer run
        // can start *and finish* its own replaceTrack() while this call is in flight, so this
        // one resolves last and clobbers it anyway (confirmed live: 'gate reasserted onto sender
        // (was hijacked)' logs showing the hijacker as the raw mic track, landing right after a
        // fresh 'gate graph installed'). generationRef is bumped synchronously at the top of
        // every run, well before any run's own awaits — so checking it immediately before
        // *initiating* replaceTrack (not just before deciding to) means a newer run is always
        // already reflected here, and this call never gets sent to race it in the first place.
        const micSender = micTrack?.sender;
        if (
          micTrack &&
          micSender &&
          micSender.transport?.state !== 'closed' &&
          micSender.track?.id === gatedOutputTrack?.id &&
          // Intentional: reading the *current*, possibly-newer value here (not a snapshot) is
          // the entire point of this check, not a bug the lint rule's DOM-ref-in-cleanup
          // heuristic applies to.
          // eslint-disable-next-line react-hooks/exhaustive-deps
          generationRef.current === myGeneration
        ) {
          try {
            await micSender.replaceTrack(resolveUpstreamTrack(micTrack));
          } catch (e) {
            console.error('[Connect] failed to restore ungated mic track:', e);
          }
        }
        currentSourceTrack?.stop();
        gatedOutputTrack?.stop();
        void gateCtx?.close().catch(() => {});
      })();
    };
  }, [enabled, localParticipant, trackEpoch, noiseCancelEnabled]);

  return loading;
}

/**
 * Delays outgoing camera video to stay level with however much the audio pipeline is currently
 * delaying audio (the VAD gate's GATE_DELAY_MS, GTCRN's own capture-buffering latency, or both
 * added together — see the caller), so a remote viewer gets both on one timeline instead of
 * hearing a voice trail its own lips (and so composited recordings don't bake that offset in).
 * `delayMs <= 0` means neither audio stage is currently adding delay, so this is a no-op.
 *
 * Structured deliberately like useVadAutoGate: the delay is spliced in at the *sender*, not
 * through LiveKit's single processor slot, because the background effect owns that slot and
 * its swap sequencing is load-bearing (see useBackgroundEffect.applyEffect). That means
 * competing with the background processor's own replaceTrack() calls exactly the way the audio
 * gate competes with Krisp's — same fix, same reasons: re-derive from the current upstream and
 * take the sender back, synchronously on the track's events plus a per-frame self-heal.
 */
function useVideoDelay(delayMs: number) {
  const { localParticipant } = useLocalParticipant();
  const [trackEpoch, setTrackEpoch] = useState(0);
  // Same race, same fix as useVadAutoGate's generationRef — see the long comment at its
  // cleanup's replaceTrack() call for why an id check alone isn't sufficient.
  const generationRef = useRef(0);

  useEffect(() => {
    const bump = (publication: { source?: Track.Source }) => {
      if (publication?.source !== Track.Source.Camera) return;
      setTrackEpoch((n) => n + 1);
    };
    localParticipant.on(ParticipantEvent.LocalTrackPublished, bump);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, bump);
    };
  }, [localParticipant]);

  useEffect(() => {
    if (delayMs <= 0) return;
    // Safari and Firefox have no insertable streams. Video just stays undelayed there — the
    // audio side still works, it's only lip-sync that goes back to being delayMs off.
    if (!isVideoDelaySupported()) {
      vadLog('video delay unsupported on this browser, leaving video undelayed');
      return;
    }
    // Buffering ~10 full video frames plus, when the background effect is on, running that
    // *in addition to* Mediapipe's own segmentation pipeline is real, untested extra load on
    // top of an already CPU/battery-constrained device. The audio gate's ONNX inference is
    // comparatively cheap and stays on everywhere — this is specifically the video half.
    // Lip-sync just goes back to being GATE_DELAY_MS off, same as the unsupported-browser case.
    if (isMobileDevice()) {
      vadLog('video delay skipped on mobile, leaving video undelayed');
      return;
    }

    const myGeneration = ++generationRef.current;
    let pipeline: VideoDelayPipeline | null = null;
    let currentUpstreamId: string | null = null;
    let unusableSender: RTCRtpSender | null = null;

    const reassertSenderTrack = (track: LocalVideoTrack) => {
      const delayedTrack = pipeline?.track;
      if (!delayedTrack) return;
      const sender = track.sender;
      if (!sender || sender === unusableSender || sender.track?.id === delayedTrack.id) return;
      // Leaving the room closes the peer connection while this per-frame loop is still running,
      // and replaceTrack() throws once it is. Latched per sender object rather than outright, so
      // a reconnect (which brings a new sender) starts clean.
      if (sender.transport?.state === 'closed') {
        unusableSender = sender;
        return;
      }
      vadLog('video delay reasserted onto sender (was hijacked)', {
        hijackedByTrackId: sender.track?.id ?? '(none)',
      });
      sender.replaceTrack(delayedTrack).catch((e) => {
        unusableSender = sender;
        console.error('[Connect] failed to reassert video delay onto sender:', e);
      });
    };

    // A new upstream track means a whole new pipeline: MediaStreamTrackProcessor is bound to
    // the track it was constructed with, and its readable is already piped, so there's nothing
    // to re-point the way the audio graph re-points its source node.
    const syncToUpstream = (track: LocalVideoTrack) => {
      const upstream = resolveUpstreamTrack(track);
      if (currentUpstreamId === upstream.id) {
        reassertSenderTrack(track);
        return;
      }
      currentUpstreamId = upstream.id;
      // Build and hand over the replacement before retiring the old pipeline: stopping it
      // first would leave the sender holding an ended track for the length of a round trip.
      const previous = pipeline;
      pipeline = new VideoDelayPipeline(upstream, delayMs, () => reassertSenderTrack(track));
      const installed = pipeline;
      vadLog('video delay pipeline installed', {
        delayMs,
        upstreamTrackId: upstream.id,
        delayedTrackId: installed.track.id,
      });
      void Promise.resolve(track.sender?.replaceTrack(installed.track))
        .catch((e) => console.error('[Connect] failed to install video delay onto sender:', e))
        .finally(() => previous?.stop());
    };

    const pub = localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return;

    const onUpstreamChange = () => syncToUpstream(track);
    track.on(TrackEvent.TrackProcessorUpdate, onUpstreamChange);
    track.on(TrackEvent.Restarted, onUpstreamChange);
    track.on(TrackEvent.Unmuted, onUpstreamChange);

    syncToUpstream(track);

    return () => {
      track.off(TrackEvent.TrackProcessorUpdate, onUpstreamChange);
      track.off(TrackEvent.Restarted, onUpstreamChange);
      track.off(TrackEvent.Unmuted, onUpstreamChange);
      void (async () => {
        // Hand the sender back what it would have carried without the delay, before tearing
        // the pipeline down — otherwise outgoing video freezes on the last delayed frame.
        // Skipped once the peer connection is gone, same as the audio gate's teardown.
        //
        // Also skipped if the sender no longer points at *this* pipeline's own output, or if a
        // newer effect run has already started (checked right before the call, not just before
        // deciding to make it — replaceTrack() is itself async, so an id check alone can pass
        // and still lose to a faster newer run's own replaceTrack() finishing after this one).
        // Same race, same fix as the audio gate's teardown — see its long comment.
        const sender = track.sender;
        if (
          sender &&
          sender.transport?.state !== 'closed' &&
          sender.track?.id === pipeline?.track.id &&
          // Intentional, see the audio gate's identical check for why reading the live value
          // here is the point, not a bug.
          // eslint-disable-next-line react-hooks/exhaustive-deps
          generationRef.current === myGeneration
        ) {
          try {
            await sender.replaceTrack(resolveUpstreamTrack(track));
          } catch (e) {
            console.error('[Connect] failed to restore undelayed camera track:', e);
          }
        }
        pipeline?.stop();
      })();
    };
  }, [delayMs, localParticipant, trackEpoch]);
}

/**
 * Renders dropdown content into `document.body` via a portal, positioned against
 * `anchorRef`'s on-screen position, instead of as an `absolute` child of the trigger
 * button. On some mobile browsers (notably iOS Safari) `<video>` elements composite in
 * their own layer and ignore the page's normal z-index stacking entirely.
 */
function DropdownPortal({
  anchorRef,
  onClose,
  children,
  align = 'left',
  direction = 'up',
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = direction === 'up' ? rect.top - 8 : rect.bottom + 8;
      setPos(
        align === 'right'
          ? { top, right: window.innerWidth - rect.right }
          : { top, left: rect.left },
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, align, direction]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[999]" onClick={onClose} />
      <div
        className={`fixed z-[1000] animate-in fade-in ${
          direction === 'up' ? 'slide-in-from-bottom-3' : 'slide-in-from-top-3'
        } duration-200`}
        style={{
          top: pos.top,
          left: pos.left,
          right: pos.right,
          transform: direction === 'up' ? 'translateY(-100%)' : 'none',
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * Owns the noise-cancel/background/VAD toggle state. Krisp (paid, cloud-auth-dependent, and
 * broken in this environment — see git history) is gone; GTCRN noise cancellation replaces it,
 * running entirely client-side with no per-participant server cost and no external auth call.
 * Unlike Krisp, it doesn't go through LiveKit's setProcessor() slot at all — it's a stage inside
 * useVadAutoGate's own audio graph (see that hook's doc comment) — so there's no separate
 * apply/sync effect here: the two booleans below just flow straight into that hook's params,
 * and it owns the entire lifecycle reactively.
 */
function useMediaEnhancementsState() {
  const background = useBackgroundEffect();
  const [autoGateEnabled, setAutoGateEnabled] = useState(false);
  const [vadSensitivity, setVadSensitivity] = useState(VAD_POSITIVE_SPEECH_THRESHOLD);
  const [noiseCancelEnabled, setNoiseCancelEnabled] = useState(true);
  const autoGateLoading = useVadAutoGate(autoGateEnabled, vadSensitivity, noiseCancelEnabled);
  // Video is only delayed to stay level with however much the audio side is currently delaying
  // audio — zero, one, or both of these stages may be contributing at any given moment.
  useVideoDelay(
    (autoGateEnabled ? GATE_DELAY_MS : 0) + (noiseCancelEnabled ? GTCRN_PIPELINE_LATENCY_MS : 0),
  );

  return {
    background,
    autoGateEnabled,
    setAutoGateEnabled,
    autoGateLoading,
    vadSensitivity,
    setVadSensitivity,
    noiseCancelEnabled,
    setNoiseCancelEnabled,
  };
}

type MediaEnhancementsState = ReturnType<typeof useMediaEnhancementsState>;

/**
 * Device menu for Audio Input (Microphone), Audio Output (Speaker), and Noise Suppression
 */
function MicMenuDropdown({
  anchorRef,
  onClose,
  mediaEnhancements,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  mediaEnhancements: MediaEnhancementsState;
}) {
  const {
    devices: audioInputs,
    activeDeviceId: activeInputId,
    setActiveMediaDevice: setActiveInput,
  } = useMediaDeviceSelect({ kind: 'audioinput' });

  const {
    devices: audioOutputs,
    activeDeviceId: activeOutputId,
    setActiveMediaDevice: setActiveOutput,
  } = useMediaDeviceSelect({ kind: 'audiooutput' });

  const {
    autoGateEnabled,
    setAutoGateEnabled,
    autoGateLoading,
    vadSensitivity,
    setVadSensitivity,
    noiseCancelEnabled,
    setNoiseCancelEnabled,
  } = mediaEnhancements;

  return (
    <DropdownPortal anchorRef={anchorRef} onClose={onClose} align="left">
      <div className="w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-3.5 text-white space-y-3">
        <div className="flex items-center justify-between border-b border-gray-800 pb-2 px-1">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-sky-400" />
            <h3 className="font-bold text-xs text-gray-100">マイク・スピーカー設定</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Microphones (Audio Input) */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">マイク（入力）</p>
          <div className="space-y-0.5 max-h-32 overflow-y-auto no-scrollbar">
            {audioInputs.map((device) => {
              const isSelected = device.deviceId === activeInputId;
              return (
                <button
                  key={device.deviceId}
                  onClick={async () => {
                    await setActiveInput(device.deviceId);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-sky-600/30 text-sky-300 font-bold border border-sky-500/40'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <span className="truncate">{device.label || `マイク (${device.deviceId.slice(0, 5)}...)`}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                </button>
              );
            })}
            {audioInputs.length === 0 && (
              <p className="text-[11px] text-gray-500 py-1 px-1">利用可能なマイクがありません</p>
            )}
          </div>
        </div>

        {/* Speakers (Audio Output) if available */}
        {audioOutputs.length > 0 && (
          <div className="space-y-1 border-t border-gray-800/80 pt-2">
            <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">スピーカー（出力）</p>
            <div className="space-y-0.5 max-h-28 overflow-y-auto no-scrollbar">
              {audioOutputs.map((device) => {
                const isSelected = device.deviceId === activeOutputId;
                return (
                  <button
                    key={device.deviceId}
                    onClick={async () => {
                      await setActiveOutput(device.deviceId);
                      onClose();
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                      isSelected
                        ? 'bg-sky-600/30 text-sky-300 font-bold border border-sky-500/40'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    }`}
                  >
                    <span className="truncate">{device.label || `スピーカー (${device.deviceId.slice(0, 5)}...)`}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* GTCRN Noise Cancellation */}
        <div className="space-y-1.5 border-t border-gray-800/80 pt-2.5 px-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-sky-400" />
              <div>
                <p className="text-xs font-bold text-gray-200">ノイズキャンセリング</p>
                <p className="text-[10px] text-gray-400">マイクの周囲の雑音を除去</p>
              </div>
            </div>

            <button
              onClick={() => setNoiseCancelEnabled((prev) => !prev)}
              className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                noiseCancelEnabled ? 'bg-sky-500' : 'bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                  noiseCancelEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* VAD Auto-Gate */}
        <div className="space-y-1.5 border-t border-gray-800/80 pt-2.5 px-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MicOff className="w-4 h-4 text-sky-400" />
              <div>
                <p className="text-xs font-bold text-gray-200">自動ミュート（発話検知）</p>
                <p className="text-[10px] text-gray-400">話していない間は送信しない</p>
              </div>
            </div>

            <button
              onClick={() => setAutoGateEnabled((prev) => !prev)}
              disabled={autoGateLoading}
              className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                autoGateEnabled ? 'bg-sky-500' : 'bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                  autoGateEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              >
                {autoGateLoading && <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-600" />}
              </span>
            </button>
          </div>

          {autoGateEnabled && (
            <div className="pl-6 pt-1 space-y-1">
              <div className="flex items-center justify-between text-[10px] text-gray-400">
                <span>ノイズキャンセリングレベル</span>
                <span className="text-gray-300 tabular-nums">
                  {Math.round(
                    ((vadSensitivity - VAD_SENSITIVITY_MIN) / (VAD_SENSITIVITY_MAX - VAD_SENSITIVITY_MIN)) * 100,
                  )}
                  %
                </span>
              </div>
              <input
                type="range"
                min={VAD_SENSITIVITY_MIN}
                max={VAD_SENSITIVITY_MAX}
                step={0.01}
                value={vadSensitivity}
                onChange={(e) => setVadSensitivity(Number(e.target.value))}
                className="w-full accent-sky-500"
              />
              <div className="flex items-center justify-between text-[9px] text-gray-500">
                <span>小さい声も拾う</span>
                <span>うるさい環境向け</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </DropdownPortal>
  );
}

/**
 * Device menu for Video Input (Camera) and Background Blur
 */
function CameraMenuDropdown({
  anchorRef,
  onClose,
  mediaEnhancements,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  mediaEnhancements: MediaEnhancementsState;
}) {
  const {
    devices: videoInputs,
    activeDeviceId: activeVideoId,
    setActiveMediaDevice: setActiveVideo,
  } = useMediaDeviceSelect({ kind: 'videoinput' });

  const { background } = mediaEnhancements;
  const [showBackgroundModal, setShowBackgroundModal] = useState(false);

  const currentBackgroundLabel =
    background.mode === 'off'
      ? 'オフ'
      : background.mode === 'blur'
        ? 'ぼかし'
        : PRESETS.find((p) => p.id === background.imageId)?.label ?? 'アップロード画像';
  const currentBackgroundThumb = background.mode === 'image' ? background.imageUrlFor(background.imageId) : undefined;
  const CurrentBackgroundIcon = background.mode === 'off' ? Ban : background.mode === 'blur' ? Droplets : ImageIcon;

  return (
    <DropdownPortal anchorRef={anchorRef} onClose={onClose} align="left">
      <div className="w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-3.5 text-white space-y-3">
        <div className="flex items-center justify-between border-b border-gray-800 pb-2 px-1">
          <div className="flex items-center gap-1.5">
            <Video className="w-3.5 h-3.5 text-sky-400" />
            <h3 className="font-bold text-xs text-gray-100">カメラ設定</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Video Devices List */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">カメラ（映像入力）</p>
          <div className="space-y-0.5 max-h-44 overflow-y-auto no-scrollbar">
            {videoInputs.map((device) => {
              const isSelected = device.deviceId === activeVideoId;
              return (
                <button
                  key={device.deviceId}
                  onClick={async () => {
                    await setActiveVideo(device.deviceId);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-sky-600/30 text-sky-300 font-bold border border-sky-500/40'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <span className="truncate">{device.label || `カメラ (${device.deviceId.slice(0, 5)}...)`}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
                </button>
              );
            })}
            {videoInputs.length === 0 && (
              <p className="text-[11px] text-gray-500 py-1 px-1">利用可能なカメラがありません</p>
            )}
          </div>
        </div>

        {/* Background effect — summary row, opens the picker in a popup */}
        <div className="px-1">
          <button
            onClick={() => setShowBackgroundModal(true)}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border border-gray-800/80 bg-gray-800/40 hover:bg-gray-800 transition-colors text-left"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {currentBackgroundThumb ? (
                <img
                  src={currentBackgroundThumb}
                  alt=""
                  className="w-8 h-6 rounded-md object-cover border border-gray-700 shrink-0"
                />
              ) : (
                <div className="w-8 h-6 rounded-md bg-gray-900 border border-gray-700 flex items-center justify-center shrink-0">
                  <CurrentBackgroundIcon className="w-3.5 h-3.5 text-sky-400" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-xs font-bold text-gray-200">背景を変更</p>
                <p className="text-[10px] text-gray-400 truncate">現在: {currentBackgroundLabel}</p>
              </div>
            </div>
            <ChevronRight className="w-3.5 h-3.5 text-gray-500 shrink-0" />
          </button>
        </div>
      </div>

      <BackgroundEffectModal
        isOpen={showBackgroundModal}
        onClose={() => setShowBackgroundModal(false)}
        state={background}
      />
    </DropdownPortal>
  );
}

function MicButton({ mediaEnhancements }: { mediaEnhancements: MediaEnhancementsState }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleMic = useCallback(async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (e) {
      console.error('Failed to toggle mic:', e);
    }
  }, [localParticipant, isMicrophoneEnabled]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-stretch h-[52px] rounded-xl border transition-all duration-200 shrink-0 ${
        isMicrophoneEnabled
          ? 'bg-sky-600/90 border-sky-400/50 text-white'
          : 'bg-gray-900/80 border-gray-700/80 text-gray-200'
      }`}
    >
      <button
        onClick={toggleMic}
        title={isMicrophoneEnabled ? 'マイクをミュート' : 'マイクをミュート解除'}
        className="flex flex-col items-center justify-center gap-0.5 min-w-[3.5rem] sm:min-w-[4rem] px-3 py-1.5 transition-colors hover:brightness-110 active:scale-95 rounded-l-xl"
      >
        {isMicrophoneEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-rose-400" />}
        <ControlButtonLabel>マイク</ControlButtonLabel>
      </button>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        title="マイク・スピーカー設定"
        className={`flex items-center justify-center px-2 border-l transition-colors rounded-r-xl ${
          isMicrophoneEnabled
            ? 'border-sky-400/40 hover:bg-sky-700/60 text-white/90'
            : 'border-gray-700/80 hover:bg-gray-800 text-gray-400 hover:text-white'
        }`}
      >
        <ChevronUp className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <MicMenuDropdown anchorRef={containerRef} onClose={() => setIsOpen(false)} mediaEnhancements={mediaEnhancements} />
      )}
    </div>
  );
}

function CameraButton({ mediaEnhancements }: { mediaEnhancements: MediaEnhancementsState }) {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const syncRecording = useRecordingSync();

  const toggleCam = useCallback(async () => {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
      // Camera mute is invisible to the server — see useRecordingSync. No-op when the room
      // isn't being recorded, so this doesn't need to know whether it is.
      syncRecording();
    } catch (e) {
      console.error('Failed to toggle camera:', e);
    }
  }, [localParticipant, isCameraEnabled, syncRecording]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-stretch h-[52px] rounded-xl border transition-all duration-200 shrink-0 ${
        isCameraEnabled
          ? 'bg-sky-600/90 border-sky-400/50 text-white'
          : 'bg-gray-900/80 border-gray-700/80 text-gray-200'
      }`}
    >
      <button
        onClick={toggleCam}
        title={isCameraEnabled ? 'カメラをオフ' : 'カメラをオン'}
        className="flex flex-col items-center justify-center gap-0.5 min-w-[3.5rem] sm:min-w-[4rem] px-3 py-1.5 transition-colors hover:brightness-110 active:scale-95 rounded-l-xl"
      >
        {isCameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5 text-rose-400" />}
        <ControlButtonLabel>カメラ</ControlButtonLabel>
      </button>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        title="カメラ設定"
        className={`flex items-center justify-center px-2 border-l transition-colors rounded-r-xl ${
          isCameraEnabled
            ? 'border-sky-400/40 hover:bg-sky-700/60 text-white/90'
            : 'border-gray-700/80 hover:bg-gray-800 text-gray-400 hover:text-white'
        }`}
      >
        <ChevronUp className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <CameraMenuDropdown anchorRef={containerRef} onClose={() => setIsOpen(false)} mediaEnhancements={mediaEnhancements} />
      )}
    </div>
  );
}

function useScreenShareToggle() {
  const isSupported = useMemo(() => supportsScreenSharing(), []);
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();

  const toggleShare = useCallback(async () => {
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, {
        // Capped at 1080p rather than captured at the display's native size
        // (`ScreenSharePresets.original`, which is literally "don't resize"). Capping makes
        // small text *sharper*, not softer: a Retina panel hands over something like
        // 3174x2410, and spreading `screenShareEncoding.maxBitrate` across 7.6 megapixels
        // leaves about 0.05 bits per pixel — nowhere near enough for legible glyphs. The
        // same stream at 1920x1080 gets roughly 2.5x that, and no viewer displays the share
        // wider than this anyway (the recording composites it into 960px — see
        // recording-compositor/src/layout.ts). It also drops the sharer's own encoder from
        // 7.6 to 2.1 megapixels per frame, which is what makes laptops audible mid-share.
        resolution: ScreenSharePresets.h1080fps15.resolution,
        // Tells the encoder to spend bits on sharpness over motion — the right trade for
        // slides and code, and the reason a static share stays readable at 15fps.
        contentHint: 'detail',
      });
    } catch (e) {
      console.error('Failed to toggle screen share:', e);
    }
  }, [localParticipant, isScreenShareEnabled]);

  return { isSupported, isScreenShareEnabled, toggleShare };
}

function ScreenShareButton() {
  const { isSupported, isScreenShareEnabled, toggleShare } = useScreenShareToggle();

  if (!isSupported) return null;

  return (
    <button onClick={toggleShare} title="画面共有" className={controlButtonClass(isScreenShareEnabled)}>
      <ScreenShare className="w-5 h-5" />
      <ControlButtonLabel>共有</ControlButtonLabel>
    </button>
  );
}

/** Same screen-share toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ScreenShareMenuItem({ onSelect }: { onSelect: () => void }) {
  const { isSupported, isScreenShareEnabled, toggleShare } = useScreenShareToggle();

  if (!isSupported) return null;

  return (
    <button
      onClick={() => {
        toggleShare();
        onSelect();
      }}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <ScreenShare className="w-4 h-4 text-sky-400" />
      <span>{isScreenShareEnabled ? '画面共有を停止' : '画面共有'}</span>
    </button>
  );
}

function LeaveButton({ isHost, mainRoomId }: { isHost?: boolean; mainRoomId?: string }) {
  const room = useRoomContext();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showHostLeaveWarning, setShowHostLeaveWarning] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  const handleConfirmLeave = async () => {
    // ホストであり、かつ自分以外の参加者が通話内にいる場合、ホスト不在警告APIでチェック
    const otherParticipantsCount = room.remoteParticipants?.size ?? 0;
    if (isHost && otherParticipantsCount > 0 && mainRoomId) {
      setIsChecking(true);
      try {
        const res = await apiClient.post(`/api/connect/rooms/${encodeURIComponent(mainRoomId)}/check-host-leave`, {});
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.shouldWarn) {
            setShowConfirm(false);
            setShowHostLeaveWarning(true);
            return;
          }
        }
      } catch (e) {
        console.warn('[CallRoomPage] check-host-leave failed:', e);
      } finally {
        setIsChecking(false);
      }
    }

    setShowConfirm(false);
    room.disconnect();
  };

  const handleForceLeave = () => {
    setShowHostLeaveWarning(false);
    room.disconnect();
  };

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        title="通話を終了"
        className={controlButtonClass(false, true)}
      >
        <PhoneOff className="w-5 h-5" />
        <ControlButtonLabel>退出</ControlButtonLabel>
      </button>

      <LeaveConfirmModal
        isOpen={showConfirm}
        loading={isChecking}
        onClose={() => {
          if (!isChecking) setShowConfirm(false);
        }}
        onConfirm={handleConfirmLeave}
      />

      <HostLeaveWarningModal
        isOpen={showHostLeaveWarning}
        onClose={() => setShowHostLeaveWarning(false)}
        onConfirm={handleForceLeave}
      />
    </>
  );
}

/**
 * Chat open/close toggle. Deliberately NOT LiveKit's built-in <ControlBar chat> button:
 * that button drives `showChat` through LiveKit's internal layout-context widget state,
 * which only the ControlBar's own click handler ever updates. AdvancedChat's "back to
 * video" button sets `showChat` directly instead, so the two ended up as two different
 * sources of truth for the same boolean — closing chat via the back button didn't update
 * the widget state, so the next LiveKit-driven render could silently put it back to `true`.
 * Routing every toggle through this one button (and the same `setShowChat` the back button
 * uses) keeps `showChat` single-owned.
 */
function ChatToggleButton({
  isOpen,
  unreadCount,
  onClick,
}: {
  isOpen: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} title="チャット" className={`relative ${controlButtonClass(isOpen)}`}>
      <MessageSquare className="w-5 h-5" />
      <ControlButtonLabel>チャット</ControlButtonLabel>
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

/** Same chat toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ChatMenuItem({
  isOpen,
  unreadCount,
  onClick,
}: {
  isOpen: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <MessageSquare className="w-4 h-4 text-sky-400" />
      <span>{isOpen ? 'チャットを閉じる' : 'チャット'}</span>
      {unreadCount > 0 && (
        <span className="ml-auto min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

/** Toggles the reaction picker popup. */
function ReactionButton({
  isOpen,
  onClick,
  buttonRef,
}: {
  isOpen: boolean;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      title="リアクション"
      className={controlButtonClass(isOpen)}
    >
      <Smile className="w-5 h-5" />
      <ControlButtonLabel>リアクション</ControlButtonLabel>
    </button>
  );
}

/** Same reaction picker entry, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ReactionMenuItem({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <Smile className="w-4 h-4 text-sky-400" />
      <span>リアクション</span>
    </button>
  );
}

/** Toggles the Participants panel. `pendingCount` (host-only — always 0 for non-hosts, see
 *  useConnectWaitlist) drives the same red-dot badge style as ChatToggleButton's unread count. */
function ParticipantsButton({
  isOpen,
  pendingCount,
  onClick,
}: {
  isOpen: boolean;
  pendingCount: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} title="参加者" className={`relative ${controlButtonClass(isOpen)}`}>
      <Users className="w-5 h-5" />
      <ControlButtonLabel>参加者</ControlButtonLabel>
      {pendingCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
          {pendingCount}
        </span>
      )}
    </button>
  );
}

/** Same participants toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ParticipantsMenuItem({
  isOpen,
  pendingCount,
  onClick,
}: {
  isOpen: boolean;
  pendingCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <Users className="w-4 h-4 text-sky-400" />
      <span>{isOpen ? '参加者一覧を閉じる' : '参加者'}</span>
      {pendingCount > 0 && (
        <span className="ml-auto min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
          {pendingCount}
        </span>
      )}
    </button>
  );
}

/** Opens the mini-room (breakout room) creation dialog. */
function MiniRoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="ミニルーム" className={controlButtonClass(false)}>
      <DoorOpen className="w-5 h-5" />
      <ControlButtonLabel>ミニルーム</ControlButtonLabel>
    </button>
  );
}

/** Same mini-room entry point, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function MiniRoomMenuItem({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <DoorOpen className="w-4 h-4 text-sky-400" />
      <span>ミニルーム</span>
    </button>
  );
}

/** Starts/stops recording the call. Only rendered for users with the recording permission. */
function RecordingButton({
  isRecording,
  busy,
  onClick,
}: {
  isRecording: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={isRecording ? '録画を停止' : '録画を開始'}
      className={
        isRecording
          ? 'flex flex-col items-center justify-center gap-0.5 min-w-[4.25rem] sm:min-w-[4.75rem] h-[52px] px-3.5 py-1.5 rounded-xl border transition-all duration-200 active:scale-95 shrink-0 bg-rose-950/80 text-rose-200 border-rose-500/50 hover:bg-rose-900/80 shadow-lg shadow-rose-950/30'
          : controlButtonClass(false)
      }
    >
      {busy ? (
        <Loader2 className="w-5 h-5 animate-spin" />
      ) : isRecording ? (
        <StopCircle className="w-5 h-5 text-rose-400 animate-pulse fill-rose-500/20" />
      ) : (
        <CircleDot className="w-5 h-5" />
      )}
      <ControlButtonLabel>{isRecording ? '録画停止' : '録画'}</ControlButtonLabel>
    </button>
  );
}

/** Same recording toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function RecordingMenuItem({
  isRecording,
  busy,
  onClick,
}: {
  isRecording: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
      ) : isRecording ? (
        <StopCircle className="w-4 h-4 text-rose-400 animate-pulse" />
      ) : (
        <CircleDot className="w-4 h-4 text-sky-400" />
      )}
      <span>{isRecording ? '録画を停止' : '録画を開始'}</span>
    </button>
  );
}

/**
 * One entry in the control bar's overflow system: rendered as a pill button in
 * the bar when there's room, or as a row inside `MoreMenu` when there isn't.
 * `priority` decides collapse order — the LOWEST priority item collapses first
 * as the bar gets narrower. To add a new control-bar feature (screen recording,
 * AI chat, participant list, ...), just add one more entry to the `overflowItems`
 * array built in `CustomVideoConference` — the width measurement and collapsing
 * below are generic and don't need to change.
 */
interface OverflowBarItem {
  key: string;
  priority: number;
  badgeCount?: number;
  renderBar: () => ReactNode;
  renderMenuItem: (close: () => void) => ReactNode;
}

/** Estimated rendered width (pill + gap) of one `controlButtonClass` button, used to decide how many overflow items fit. */
const OVERFLOW_ITEM_WIDTH_PX = 84;

/** PiP open/close toggle for the control bar. */
function PipButton({
  isPipActive,
  onClick,
}: {
  isPipActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={isPipActive ? 'PiPを閉じる' : 'PiPで開く'}
      className={controlButtonClass(isPipActive)}
    >
      <PictureInPicture2 className="w-5 h-5" />
      <ControlButtonLabel>PiP</ControlButtonLabel>
    </button>
  );
}

/** Same PiP toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function PipMenuItem({
  isPipActive,
  onClick,
}: {
  isPipActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <PictureInPicture2 className="w-4 h-4 text-sky-400" />
      <span>{isPipActive ? 'PiP表示中' : 'PiPで開く'}</span>
    </button>
  );
}

/**
 * Dropdown menu for control-bar items that didn't fit on screen, driven by
 * the collapsing logic in `CustomVideoConference`.
 */
function MoreMenu({
  collapsedItems,
}: {
  collapsedItems: OverflowBarItem[];
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const badgeTotal = collapsedItems.reduce((sum, item) => sum + (item.badgeCount ?? 0), 0);

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen((prev) => !prev)}
        title="その他のメニュー"
        className={`relative ${controlButtonClass(isOpen)}`}
      >
        <Ellipsis className="w-5 h-5" />
        <ControlButtonLabel>その他</ControlButtonLabel>
        {badgeTotal > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
            {badgeTotal}
          </span>
        )}
      </button>

      {isOpen && (
        <DropdownPortal anchorRef={triggerRef} onClose={() => setIsOpen(false)} align="left">
          <div className="w-56 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-2 text-white">
            {collapsedItems.map((item) => (
              <div key={item.key}>{item.renderMenuItem(close)}</div>
            ))}
          </div>
        </DropdownPortal>
      )}
    </div>
  );
}

const LAYOUT_MODE_OPTIONS: { mode: LayoutMode; label: string; icon: typeof LayoutGrid }[] = [
  { mode: 'grid', label: 'グリッド', icon: LayoutGrid },
  { mode: 'speaker', label: 'スピーカー', icon: Maximize2 },
];

/**
 * Switches between grid / speaker. Structured like `MoreMenu` so it inherits
 * `DropdownPortal`'s iOS-Safari z-index workaround.
 *
 * There is no "pin" entry here: pinning is a per-tile action (the pin button on each
 * tile), orthogonal to which of these two layouts is showing. See `useCallLayout`.
 *
 * Unlike `ScreenShareButton` this is *not* hidden on small screens: escaping a
 * 20-tile grid matters most on a phone.
 */
function LayoutModeButton({
  mode,
  onSelect,
}: {
  mode: LayoutMode;
  onSelect: (mode: LayoutMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const activeOption = LAYOUT_MODE_OPTIONS.find((o) => o.mode === mode);
  const ActiveIcon = activeOption?.icon ?? LayoutGrid;
  const activeLabel = activeOption?.label ?? '表示';

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen((prev) => !prev)}
        title="表示レイアウトを変更"
        className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-900/90 hover:bg-gray-800 border border-gray-700/80 hover:border-gray-600 rounded-md text-xs font-semibold text-gray-200 hover:text-white transition-all active:scale-95 shrink-0"
      >
        <ActiveIcon className="w-3.5 h-3.5 text-sky-400" />
        <span>{activeLabel}</span>
      </button>

      {isOpen && (
        <DropdownPortal anchorRef={triggerRef} onClose={() => setIsOpen(false)} align="right" direction="down">
          <div className="w-52 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-2 text-white">
            <div className="px-2.5 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">表示レイアウト</div>
            {LAYOUT_MODE_OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => {
              const isActive = optionMode === mode;
              return (
                <button
                  key={optionMode}
                  onClick={() => {
                    onSelect(optionMode);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                    isActive ? 'bg-sky-600/25 text-white' : 'text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-sky-300' : 'text-sky-400'}`} />
                  <span>{label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 ml-auto text-sky-300" />}
                </button>
              );
            })}
          </div>
        </DropdownPortal>
      )}
    </div>
  );
}

/**
 * Custom VideoConference with side-docked AdvancedChat and auto-PiP handling
 */
function CustomVideoConference({
  layout,
  onOpenPip,
  onClosePip,
  isPipSupported,
  isPipActive,
  chat,
  showChat,
  setShowChat,
  showParticipants,
  setShowParticipants,
  isMiniRoomHost,
  onRequestClaimHost,
  onRequestGrantHost,
  mainRoomId,
  miniRooms,
  recording,
  isInternalMeeting,
  selectedProfileUserId,
  setSelectedProfileUserId,
  onOpenProfile,
}: {
  layout: CallLayout;
  onOpenPip: () => void;
  onClosePip: () => void;
  isPipSupported: boolean;
  isPipActive: boolean;
  chat: ReturnType<typeof useAdvancedChat>;
  showChat: boolean;
  setShowChat: (val: boolean | ((prev: boolean) => boolean)) => void;
  showParticipants: boolean;
  setShowParticipants: (val: boolean | ((prev: boolean) => boolean)) => void;
  isMiniRoomHost: boolean;
  onRequestClaimHost?: () => void;
  onRequestGrantHost?: (targetUserId: string, targetName: string) => void;
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
  recording: ReturnType<typeof useRecording>;
  isInternalMeeting?: boolean;
  selectedProfileUserId?: string | null;
  setSelectedProfileUserId?: (val: string | null) => void;
  onOpenProfile?: (userId: string) => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const mediaEnhancements = useMediaEnhancementsState();
  // Prefer the authenticated user id (matches useAdvancedChat's selfIdentity and the
  // backend's LiveKit identity for logged-in joiners; localParticipant.identity is empty
  // until the connection completes — see useAdvancedChat's comment). Anonymous guests have
  // no user.id, so they fall back to localParticipant.identity (their guest_* identity).
  const { user } = useAuth();
  const selfIdentity = user?.id || localParticipant.identity;

  // Forces exactly one remount of the grid/stage layout the moment the local
  // camera's publication first appears. Under investigation: the local camera
  // tile sometimes never re-renders after `localParticipant.publishTrack()`
  // succeeds — the underlying `tracks` data is confirmed correct by then, but
  // something in the grid's own memoization (`CustomParticipantTile`'s
  // `tilePropsEqual`) intermittently keeps showing the pre-publish placeholder.
  // A one-time remount sidesteps that regardless of which layer is stale, at the
  // cost of a harmless reset of scroll/hover state in an otherwise near-empty grid
  // this early in the call.
  const hasLocalCameraPublication = layout.gridTracks
    .concat(layout.stageTracks, layout.stripTracks)
    .some(
      (t) =>
        t.participant.isLocal &&
        t.source === Track.Source.Camera &&
        'publication' in t &&
        !!(t as { publication?: unknown }).publication,
    );
  const layoutKey = hasLocalCameraPublication ? 'camera-live' : 'camera-pending';

  // Mini-room panel, opened by the control-bar button. Visible/openable by everyone —
  // MiniRoomPanel itself branches host vs. non-host content.
  const [showMiniRoomPanel, setShowMiniRoomPanel] = useState(false);

  // Reaction picker state & ref
  const reactionButtonRef = useRef<HTMLButtonElement>(null);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const reactionActions = useReactionActions();

  // Starting/stopping is host-only, but the recording *state* is read by everyone:
  // participants who can't touch the controls still need to see that they're being recorded.
  const canRecord = isMiniRoomHost;

  // Host-only pending waiting-room requests — see the DB flag design: waitlist.pending is
  // always empty for non-hosts (the backend 403s these routes for them, this just skips
  // firing the requests), so the badge/panel below need no extra isMiniRoomHost checks.
  const waitlist = useConnectWaitlist(mainRoomId, isMiniRoomHost);

  // Who to badge as host in the Participants panel — see useRoomHosts.
  const hostUserIds = useRoomHosts(mainRoomId);

  // Chat and Participants are docked on opposite sides but only one makes sense open at a
  // time on mobile (each goes full-screen there — see the "hidden below sm" comment further
  // down), so opening one closes the other.
  const handleToggleChat = useCallback(() => {
    setShowChat((prev) => {
      const next = !prev;
      if (next) {
        setShowParticipants(false);
        setSelectedProfileUserId?.(null);
      }
      return next;
    });
  }, [setShowChat, setShowParticipants, setSelectedProfileUserId]);

  const handleToggleParticipants = useCallback(() => {
    setShowParticipants((prev) => {
      const next = !prev;
      if (next) {
        setShowChat(false);
        setSelectedProfileUserId?.(null);
      }
      return next;
    });
  }, [setShowChat, setShowParticipants, setSelectedProfileUserId]);

  // Center control-bar items (Screen Share, Chat, and any future additions) fold into
  // the "..." menu once they don't fit. `centerWidth` is the actual box width flexbox
  // already assigned to the center `flex-1` slot — i.e. exactly the room available
  // after Mic/Camera (left) and Leave (right) take their space — so this keeps working
  // automatically if those change size too, not just when the viewport is narrow.
  const { ref: centerRef, width: centerWidth } = useElementWidth<HTMLDivElement>();

  const overflowItems: OverflowBarItem[] = [
    // 左端（共有の左側）— 参加者一覧・待機室の承認/拒否
    {
      key: 'participants',
      priority: 1,
      badgeCount: waitlist.pending.length,
      renderBar: () => (
        <ParticipantsButton
          isOpen={showParticipants}
          pendingCount={waitlist.pending.length}
          onClick={handleToggleParticipants}
        />
      ),
      renderMenuItem: (close) => (
        <ParticipantsMenuItem
          isOpen={showParticipants}
          pendingCount={waitlist.pending.length}
          onClick={() => {
            handleToggleParticipants();
            close();
          }}
        />
      ),
    },
    {
      key: 'screenshare',
      priority: 1,
      renderBar: () => <ScreenShareButton />,
      renderMenuItem: (close) => <ScreenShareMenuItem onSelect={close} />,
    },
    {
      key: 'chat',
      priority: 2,
      badgeCount: chat.totalUnreadCount,
      renderBar: () => (
        <ChatToggleButton isOpen={showChat} unreadCount={chat.totalUnreadCount} onClick={handleToggleChat} />
      ),
      renderMenuItem: (close) => (
        <ChatMenuItem
          isOpen={showChat}
          unreadCount={chat.totalUnreadCount}
          onClick={() => {
            handleToggleChat();
            close();
          }}
        />
      ),
    },
    {
      key: 'reaction',
      priority: 1.5,
      renderBar: () => (
        <ReactionButton
          isOpen={showReactionPicker}
          buttonRef={reactionButtonRef}
          onClick={() => setShowReactionPicker((prev) => !prev)}
        />
      ),
      renderMenuItem: (close) => (
        <ReactionMenuItem
          onClick={() => {
            setShowReactionPicker(true);
            close();
          }}
        />
      ),
    },
    {
      key: 'miniroom',
      priority: 0,
      renderBar: () => <MiniRoomButton onClick={() => setShowMiniRoomPanel(true)} />,
      renderMenuItem: (close) => (
        <MiniRoomMenuItem
          onClick={() => {
            setShowMiniRoomPanel(true);
            close();
          }}
        />
      ),
    },
    // Add future control-bar features here (AI chat, participant list, ...) with a
    // `priority` — lower numbers collapse into "..." first as the bar narrows. No other
    // change needed; the fit/collapse logic below is generic.
  ];

  if (canRecord) {
    overflowItems.push({
      key: 'recording',
      priority: 3,
      renderBar: () => (
        <RecordingButton
          isRecording={recording.isRecording}
          busy={recording.busy}
          onClick={recording.isRecording ? recording.stop : recording.start}
        />
      ),
      renderMenuItem: (close) => (
        <RecordingMenuItem
          isRecording={recording.isRecording}
          busy={recording.busy}
          onClick={() => {
            if (recording.isRecording) recording.stop();
            else recording.start();
            close();
          }}
        />
      ),
    });
  }

  if (isPipSupported) {
    overflowItems.push({
      key: 'pip',
      priority: 0.5,
      renderBar: () => (
        <PipButton
          isPipActive={isPipActive}
          onClick={isPipActive ? onClosePip : onOpenPip}
        />
      ),
      renderMenuItem: (close) => (
        <PipMenuItem
          isPipActive={isPipActive}
          onClick={() => {
            if (isPipActive) onClosePip();
            else onOpenPip();
            close();
          }}
        />
      ),
    });
  }

  // Reserve room for the "More" button only when items actually overflow.
  // If everything fits, we do not reserve the More button width so all buttons can be shown directly.
  const totalCount = overflowItems.length;
  const canFitAll = centerWidth !== null && centerWidth >= totalCount * OVERFLOW_ITEM_WIDTH_PX;
  const availableForItems = centerWidth === null || canFitAll ? Infinity : centerWidth - OVERFLOW_ITEM_WIDTH_PX;
  const fitCount =
    availableForItems === Infinity ? totalCount : Math.max(0, Math.floor(availableForItems / OVERFLOW_ITEM_WIDTH_PX));
  const visibleKeys = new Set(
    [...overflowItems]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, fitCount)
      .map((item) => item.key),
  );
  const visibleItems = overflowItems.filter((item) => visibleKeys.has(item.key));
  const collapsedItems = overflowItems.filter((item) => !visibleKeys.has(item.key));

  // Detect whether the local user (myself) is sharing screen
  const isLocalScreenSharing = localParticipant?.isScreenShareEnabled ?? false;

  // Automatically open Document PiP only when the local user starts screen sharing, and close on stop
  const prevLocalScreenShareRef = useRef(false);
  useEffect(() => {
    if (isLocalScreenSharing && !prevLocalScreenShareRef.current && isPipSupported && !isPipActive) {
      onOpenPip();
    } else if (!isLocalScreenSharing && prevLocalScreenShareRef.current && isPipActive) {
      onClosePip();
    }
    prevLocalScreenShareRef.current = isLocalScreenSharing;
  }, [isLocalScreenSharing, isPipSupported, isPipActive, onOpenPip, onClosePip]);

  return (
    <div className="lk-video-conference relative flex flex-row h-full w-full overflow-hidden">


      {recording.error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50">
          <div className="px-4 py-2 bg-rose-950/90 border border-rose-500/50 backdrop-blur-md rounded-xl text-xs font-semibold text-white shadow-2xl">
            {recording.error}
          </div>
        </div>
      )}

      {/* Screen Share PiP Suggestion Banner (Only for local screen share) */}
      {isLocalScreenSharing && isPipSupported && !isPipActive && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 px-4 py-2 bg-sky-950/90 hover:bg-sky-900/90 border border-sky-500/50 backdrop-blur-md rounded-2xl shadow-2xl text-white">
            <div className="flex items-center gap-2">
              <ScreenShare className="w-4 h-4 text-sky-400 animate-pulse" />
              <span className="text-xs font-semibold">画面共有中：PiPを開くと参加者の顔を確認できます</span>
            </div>
            <button
              onClick={onOpenPip}
              className="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs rounded-xl transition-all shadow-md active:scale-95 flex items-center gap-1.5"
            >
              <PictureInPicture2 className="w-3.5 h-3.5" />
              <span>PiPで開く</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Conference Area — hidden below `sm` while chat or participants is open (phones
          can't fit a 320px+ sidebar next to the video grid without squeezing the control bar
          off screen), so it becomes a full-screen page you switch to and back from instead,
          matching the PiP window's video/chat tab behavior. */}
      <div
        className={`flex-1 h-full min-w-0 relative overflow-hidden ${
          showChat || showParticipants || !!selectedProfileUserId ? 'hidden sm:flex sm:flex-col' : 'flex flex-col'
        }`}
      >
        {/* `lk-video-conference-inner` supplies the flex column. The old
            `lk-grid-layout-wrapper` / `lk-focus-layout-wrapper` classes are gone on
            purpose: they hardcode `height: calc(100% - var(--lk-control-bar-height))`
            with a 69px control bar, while ours is ~57px, so they left 12px unused. */}
        <div className="lk-video-conference-inner h-full min-h-0">
          <div className="flex-1 min-h-0 relative">
            {layout.mode === 'grid' ? (
              <GridLayoutView
                key={layoutKey}
                tracks={layout.gridTracks}
                pinned={layout.pinned}
                onTogglePin={layout.togglePin}
                isHost={isMiniRoomHost}
                onRequestClaimHost={onRequestClaimHost}
                onRequestGrantHost={onRequestGrantHost}
                isInternalMeeting={isInternalMeeting}
                onOpenProfile={onOpenProfile}
              />
            ) : (
              <StageLayoutView
                key={layoutKey}
                stageTracks={layout.stageTracks}
                stripTracks={layout.stripTracks}
                pinned={layout.pinned}
                onTogglePin={layout.togglePin}
                isHost={isMiniRoomHost}
                onRequestClaimHost={onRequestClaimHost}
                onRequestGrantHost={onRequestGrantHost}
                isInternalMeeting={isInternalMeeting}
                onOpenProfile={onOpenProfile}
              />
            )}
          </div>
          {/* Control bar: Left (Mic & Camera), Center (overflow items + More), Right (Leave).
              Center items collapse into the "..." menu by priority once the bar is too
              narrow to fit everything (measured via ResizeObserver, not a viewport
              breakpoint, since the chat sidebar can squeeze this even on wide screens). */}
          <div className="shrink-0 px-3 sm:px-6 py-2.5 border-t border-gray-800/80 bg-gray-950/80 backdrop-blur-md">
            <div className="flex items-center justify-between w-full gap-2">
              {/* Left: Mic & Camera */}
              <div className="flex items-center gap-2 shrink-0">
                <MicButton mediaEnhancements={mediaEnhancements} />
                <CameraButton mediaEnhancements={mediaEnhancements} />
              </div>

              {/* Center: overflow items (Screen Share, Chat, ...) + More (PiP + collapsed items) */}
              <div ref={centerRef} className="flex items-center justify-center gap-2 flex-1 min-w-0">
                {visibleItems.map((item) => (
                  <Fragment key={item.key}>{item.renderBar()}</Fragment>
                ))}
                {collapsedItems.length > 0 && (
                  <MoreMenu
                    collapsedItems={collapsedItems}
                  />
                )}
              </div>

              {/* Right: Leave */}
              <div className="flex items-center gap-2 shrink-0">
                <LeaveButton isHost={isMiniRoomHost} mainRoomId={mainRoomId} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Participants: docked sidebar on sm+ screens, full-screen page (with a back-to-video
          button) below `sm` — same right-hand dock as Chat below (Chat/Participants/Profile are
          mutually exclusive, so only one of the three asides here is ever showing at once). */}
      {showParticipants && (
        <aside className="w-full sm:w-80 md:w-96 h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <ParticipantsPanel
            isHost={isMiniRoomHost}
            selfIdentity={selfIdentity}
            getParticipantInfo={chat.getParticipantInfo}
            waitlist={waitlist}
            miniRooms={miniRooms}
            hostUserIds={hostUserIds}
            onBackToVideo={() => setShowParticipants(false)}
            isInternalMeeting={isInternalMeeting}
            onOpenProfile={onOpenProfile}
            onRequestClaimHost={onRequestClaimHost}
            onRequestGrantHost={onRequestGrantHost}
            onTogglePin={layout.togglePin}
            pinnedIds={layout.pinned}
          />
        </aside>
      )}

      {/* Chat: docked sidebar on sm+ screens, full-screen page (with a back-to-video
          button) below `sm` — see the comment on the main conference area above. */}
      {showChat && (
        <aside className="w-full sm:w-80 md:w-96 h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <AdvancedChat chat={chat} onBackToVideo={() => setShowChat(false)} />
        </aside>
      )}

      {/* Profile: docked sidebar on sm+ screens, full-screen page below `sm` */}
      {selectedProfileUserId && (
        <aside className="w-full sm:w-80 md:w-96 h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <ProfileSidebarPanel
            userId={selectedProfileUserId}
            onClose={() => setSelectedProfileUserId?.(null)}
          />
        </aside>
      )}

      <RoomAudioRenderer />
      <ConnectionStateToast />

      <MiniRoomPanel
        isOpen={showMiniRoomPanel}
        onClose={() => setShowMiniRoomPanel(false)}
        isHost={isMiniRoomHost}
        mainRoomId={mainRoomId}
        miniRooms={miniRooms}
      />

      <ReactionPicker
        anchorRef={reactionButtonRef}
        isOpen={showReactionPicker}
        onClose={() => setShowReactionPicker(false)}
        onSelect={(emojiId) => {
          reactionActions?.sendReaction(emojiId);
        }}
      />
    </div>
  );
}

/**
 * Inner Component rendered INSIDE <LiveKitRoom>
 * Safely accesses LiveKit context for useAdvancedChat, DocumentPiP, and Header controls.
 */
function CallRoomInner({
  roomId,
  roomTitle,
  isHost,
  onClaimHostSuccess,
  onReconnect,
  onBeforeReconnectDisconnect,
  pendingVideoTrack,
  pendingAudioTrack,
  initialMediaChoices,
  isInternalMeeting,
}: {
  roomId: string;
  roomTitle: string;
  /** Whether this user holds host privileges for this specific room (fixed-meeting
   *  host/creator, or first joiner of an instant room) — decided server-side at token
   *  issuance. Gates mini-room creation and screen recording. */
  isHost: boolean;
  onClaimHostSuccess?: () => void;
  onReconnect: (target: ReconnectTarget) => void;
  onBeforeReconnectDisconnect: () => void;
  /** The pre-join camera/mic tracks (background processor already attached, if
   *  any) — published here instead of letting <LiveKitRoom> auto-capture fresh
   *  ones, so the call never re-does getUserMedia() or shows an unprocessed frame.
   *  Null once already published; see the publish effect below. */
  pendingVideoTrack: LocalVideoTrack | null;
  pendingAudioTrack: LocalAudioTrack | null;
  initialMediaChoices?: PreJoinChoices | null;
  isInternalMeeting?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [selectedProfileUserId, setSelectedProfileUserId] = useState<string | null>(null);
  const [showClaimHostModal, setShowClaimHostModal] = useState(false);
  const { user } = useAuth();

  const isMiniRoomHost = isHost;

  const handleOpenProfile = useCallback((targetUserId: string) => {
    setShowChat(false);
    setShowParticipants(false);
    setSelectedProfileUserId(targetUserId);
  }, []);

  const miniRooms = useMiniRooms({
    mainRoomId: roomId,
    selfIdentity: user?.id || '',
    isHost: isMiniRoomHost,
    onReconnect,
    onBeforeReconnectDisconnect,
  });

  const handleClaimHost = async (code: string) => {
    const res = await apiClient.post(`/api/connect/rooms/${encodeURIComponent(roomId)}/claim-host`, {
      host_code: code,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'ホスト権限の取得に失敗しました');
    }
    onClaimHostSuccess?.();
  };

  const handleGrantHost = useCallback(
    async (targetUserId: string, targetName: string) => {
      const ok = window.confirm(`${targetName} さんに一時ホスト権限を付与しますか？`);
      if (!ok) return;

      try {
        const res = await apiClient.post(`/api/connect/rooms/${encodeURIComponent(roomId)}/grant-host`, {
          targetUserId,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'ホスト権限の付与に失敗しました');
        }
        alert(`${targetName} さんに一時ホスト権限を付与しました`);
      } catch (e: any) {
        alert(e.message || 'ホスト権限の付与に失敗しました');
      }
    },
    [roomId],
  );

  const recording = useRecording(roomId);

  // Safe to call inside <LiveKitRoom>. selfIdentity comes from the authenticated user id
  // (same value the backend issues as the LiveKit participant identity) rather than
  // localParticipant.identity, which is empty until the LiveKit connection completes.
  // Keyed off the *current* room (main or mini room) so each mini room gets its own
  const chat = useAdvancedChat({
    roomId: miniRooms.currentRoomId,
    selfIdentity: user?.id || '',
    isOpen: showChat,
  });

  const { localParticipant } = useLocalParticipant();
  const reactions = useReactions({ selfIdentity: user?.id || localParticipant?.identity || '' });
  const room = useRoomContext();

  // Listen for host_granted message via LiveKit data channel
  useEffect(() => {
    const handleDataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (topic !== 'host_granted') return;
      try {
        const str = new TextDecoder().decode(payload);
        const data = JSON.parse(str);
        if (data.type === 'host_granted' && data.targetUserId === user?.id) {
          onClaimHostSuccess?.();
          alert('ホストから一時ホスト権限が付与されました');
        }
      } catch (e) {
        console.warn('[CallRoomPage] Failed to parse host_granted message:', e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, user?.id, onClaimHostSuccess]);

  const mediaChoicesRef = useRef(initialMediaChoices);
  useEffect(() => {
    mediaChoicesRef.current = initialMediaChoices;
  }, [initialMediaChoices]);

  // Publishes the pre-join camera/mic tracks once the room is actually connected
  // — the initial join, and again after every mini-room switch (`useMiniRooms`'
  // `applyReconnect` disconnects-then-reconnects this same <LiveKitRoom>, keeping
  // these tracks alive via `room.disconnect(false)` rather than stopping them, so
  // there's no re-capture and no processor re-attach between rooms either).
  const videoPublishInFlightRef = useRef(false);
  const audioPublishInFlightRef = useRef(false);
  // Forces a re-render after a successful publish, independent of whichever SDK
  // event(s) `useTracks()` reacts to — a defensive backstop for the (still
  // unconfirmed) possibility that `RoomEvent.LocalTrackPublished` is sometimes
  // missed by its subscription, which would otherwise leave the local camera tile
  // showing the pre-publish placeholder indefinitely (until some unrelated event,
  // e.g. another participant joining, forces a recompute).
  const [, forcePublishRerender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    const publishPending = () => {
      void (async () => {
        try {
          if (
            pendingVideoTrack &&
            !videoPublishInFlightRef.current &&
            !localParticipant.getTrackPublication(Track.Source.Camera)
          ) {
            videoPublishInFlightRef.current = true;
            try {
              await localParticipant.publishTrack(pendingVideoTrack);
              if (mediaChoicesRef.current?.videoEnabled === false) {
                await localParticipant.setCameraEnabled(false);
              }
              forcePublishRerender();
              // DIAGNOSTIC: an immediate re-render alone didn't fix this (confirmed by
              // the previous test round) — useTracks() apparently needs its own
              // internal (RxJS) pipeline to finish processing LocalTrackPublished
              // first. Retry on a short delay to see whether this is a timing gap
              // rather than a genuinely missed/broken update.
              setTimeout(() => forcePublishRerender(), 300);
              setTimeout(() => forcePublishRerender(), 1000);
            } finally {
              videoPublishInFlightRef.current = false;
            }
          }
          if (
            pendingAudioTrack &&
            !audioPublishInFlightRef.current &&
            !localParticipant.getTrackPublication(Track.Source.Microphone)
          ) {
            audioPublishInFlightRef.current = true;
            try {
              await localParticipant.publishTrack(pendingAudioTrack);
              if (mediaChoicesRef.current?.audioEnabled === false) {
                await localParticipant.setMicrophoneEnabled(false);
              }
              forcePublishRerender();
            } finally {
              audioPublishInFlightRef.current = false;
            }
          }
        } catch (e) {
          console.error('[CallRoomPage] failed to publish pre-join tracks:', e);
          videoPublishInFlightRef.current = false;
          audioPublishInFlightRef.current = false;
        }
      })();
    };

    const handleDisconnected = () => {
      console.log('[CallRoomPage] room disconnected: resetting publish in-flight flags');
      videoPublishInFlightRef.current = false;
      audioPublishInFlightRef.current = false;
    };

    room.on(RoomEvent.Connected, publishPending);
    room.on(RoomEvent.Disconnected, handleDisconnected);
    publishPending(); // covers the initial connect if it already fired before this effect attached
    return () => {
      room.off(RoomEvent.Connected, publishPending);
      room.off(RoomEvent.Disconnected, handleDisconnected);
    };
  }, [room, localParticipant, pendingVideoTrack, pendingAudioTrack]);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    // No `updateOnlyOn`: it *replaces* the default `allParticipantRoomEvents`, which
    // already contains ActiveSpeakersChanged along with TrackMuted/TrackUnmuted.
    // Narrowing it to ActiveSpeakersChanged alone therefore gained nothing and
    // silently dropped mute/unmute refreshes.
    { onlySubscribed: false },
  );

  // Owns layout mode, pins, speaker tracking and screen-share auto-focus. Replaces
  // LiveKit's single-track `LayoutContext` pin entirely. Lifted up to this level
  // (rather than inside `CustomVideoConference`) so the PiP window — a sibling, not a
  // descendant — can read the same pin state and show the same pinned people the
  // main window is showing.
  const layout = useCallLayout(tracks, localParticipant?.identity);

  // Document Picture-in-Picture Hook (Desktop Chrome etc.)
  const {
    isSupported: isDocumentPipSupported,
    isPipActive: isDocumentPipActive,
    pipWindow,
    openPip: openDocumentPip,
    closePip: closeDocumentPip,
  } = useDocumentPiP();

  // Active Speaker Video Picture-in-Picture Hook (Mobile / Video PiP fallback).
  // Native auto-PiP-on-tab-switch is only enabled where Document PiP isn't
  // available (mobile/Safari) — on desktop it would otherwise fight with the
  // manual PiP button, popping a mismatched raw-video window instead of the
  // custom DocumentPipContent UI.
  const {
    isVideoPipSupported,
    isVideoPipActive,
    requestVideoPip,
    exitVideoPip,
  } = useActiveSpeakerVideoPip({ enableAutoPip: !isDocumentPipSupported });

  const isPipSupported = isDocumentPipSupported || isVideoPipSupported;
  const isPipActive = isDocumentPipActive || isVideoPipActive;

  const handleOpenPip = useCallback(() => {
    if (isDocumentPipSupported) {
      openDocumentPip({ width: 380, height: 620 });
    } else if (isVideoPipSupported) {
      requestVideoPip();
    }
  }, [isDocumentPipSupported, openDocumentPip, isVideoPipSupported, requestVideoPip]);

  const handleClosePip = useCallback(() => {
    if (isDocumentPipActive) {
      closeDocumentPip();
    } else if (isVideoPipActive) {
      exitVideoPip();
    }
  }, [isDocumentPipActive, closeDocumentPip, isVideoPipActive, exitVideoPip]);

  const copyRoomUrl = async () => {
    if (!roomId) return;
    try {
      const url = `${window.location.origin}/connect/call/${roomId}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return (
    <div className="h-full w-full flex flex-col overflow-hidden select-none">
      {/* Custom Slim In-Room Header */}
      <header className="h-11 shrink-0 bg-gray-950/90 border-b border-gray-800/80 backdrop-blur-md px-4 md:px-6 flex items-center justify-between z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          {recording.isRecording ? (
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-rose-500/15 border border-rose-500/30 rounded-md text-xs font-bold text-rose-400 animate-pulse shrink-0">
              <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
              <span>録画中</span>
            </div>
          ) : (
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          )}
          <h2 className="font-bold text-sm text-gray-100 truncate max-w-[180px] sm:max-w-xs md:max-w-md">
            {roomTitle || 'ミーティング'}
          </h2>

          {/* Room Code Badge with Copy */}
          <button
            onClick={copyRoomUrl}
            className="flex items-center gap-1.5 px-2 py-0.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700/80 hover:border-gray-600 rounded-md text-xs font-mono text-gray-300 hover:text-white transition-all active:scale-95 shrink-0"
            title="招待URLをコピー"
          >
            <span>{roomId}</span>
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3 text-gray-400" />
            )}
          </button>

          {/* Current mini room indicator — the badge above always stays the shareable
              main-room invite code, this just supplements it while inside a mini room. */}
          {!miniRooms.isInMainRoom && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-sky-500/15 border border-sky-500/30 rounded-md text-xs font-bold text-sky-300 shrink-0">
              現在: {miniRooms.rooms.find((r) => r.id === miniRooms.currentRoomId)?.name ?? 'ミニルーム'}
            </span>
          )}
        </div>

        {/* Right: Layout Mode Selector */}
        <div className="flex items-center gap-2">
          <LayoutModeButton mode={layout.mode} onSelect={layout.setMode} />
        </div>
      </header>

      {/* Main Video Conference Area */}
      <div className="flex-1 relative overflow-hidden">
        <ReactionProvider value={reactions}>
          <CustomVideoConference
            layout={layout}
            onOpenPip={handleOpenPip}
            onClosePip={handleClosePip}
            isPipSupported={isPipSupported}
            isPipActive={isPipActive}
            chat={chat}
            showChat={showChat}
            setShowChat={setShowChat}
            showParticipants={showParticipants}
            setShowParticipants={setShowParticipants}
            isMiniRoomHost={isMiniRoomHost}
            onRequestClaimHost={() => setShowClaimHostModal(true)}
            onRequestGrantHost={handleGrantHost}
            mainRoomId={roomId}
            miniRooms={miniRooms}
            recording={recording}
            isInternalMeeting={isInternalMeeting}
            selectedProfileUserId={selectedProfileUserId}
            setSelectedProfileUserId={setSelectedProfileUserId}
            onOpenProfile={handleOpenProfile}
          />

          <MiniRoomMoveToast pendingMove={miniRooms.pendingMove} />

          <MiniRoomAssignDialog
            invite={miniRooms.assignedInvite}
            onAccept={miniRooms.acceptAssignedInvite}
            onDismiss={miniRooms.dismissAssignedInvite}
          />

          <ClaimHostModal
            isOpen={showClaimHostModal}
            onClose={() => setShowClaimHostModal(false)}
            onSubmit={handleClaimHost}
            roomTitle={roomTitle}
          />

          {/* Render Document PiP Portal when active */}
          {isDocumentPipActive &&
            pipWindow &&
            createPortal(
              <DocumentPipContent
                roomTitle={roomTitle}
                onClose={closeDocumentPip}
                chat={chat}
                pinnedIds={layout.pinned}
                isRecording={recording.isRecording}
              />,
              pipWindow.document.body,
            )}

          {/* Floating Reaction Stream in bottom-left */}
          <FloatingReactionsStream />
        </ReactionProvider>
      </div>
    </div>
  );
}

/**
 * The pre-join lobby: profile/room-title chrome around `PreJoinScreen`. Used to be
 * its own route+tab (`ConnectRoomPage`, opened via `window.open`) with the call
 * itself living at a separate URL — that let `/connect/call/:roomId` be hit
 * directly, skipping the lobby entirely. Now it's just the first stage of
 * `CallRoomPage`, so there is no call-only URL to skip to.
 */
function PreJoinStage({
  roomId,
  onJoin,
  onError,
  onBack,
  anonymous = false,
  roomTitleOverride,
  statusMessage,
  submitDisabled = false,
  submitDisabledLabel,
}: {
  roomId: string;
  onJoin: (
    choices: PreJoinChoices,
    videoTrack: LocalVideoTrack | null,
    audioTrack: LocalAudioTrack | null,
  ) => void;
  onError: (message: string) => void;
  /** 「戻る」ボタンの遷移先を呼び出し元に委ねたいとき（例: 待機室では実際には遷移させず、
   *  カメラ/マイクを解放してPreJoin状態に戻すだけにしたい）。未指定なら anonymous=false の
   *  ときだけデフォルトの /connect に戻るボタンを出す。 */
  onBack?: () => void;
  /** 招待URL経由の完全外部ユーザー（DBアカウントなし）向け。表示名を必須にし、
   *  ログイン前提のプロフィール/ルーム一覧取得をスキップする。 */
  anonymous?: boolean;
  /** anonymous=true のとき、認証必須の /api/connect/rooms が使えない代わりに呼び出し元から渡すルーム名。 */
  roomTitleOverride?: string;
  /** カード上部に出すステータス文言（例: 入室リクエスト送信中・ホストの承認待ち）。 */
  statusMessage?: string;
  /** 参加ボタンを無効化する（入室リクエスト送信済みで結果待ちのとき）。カメラ・マイク・
   *  背景の調整はこの画面のまま引き続き行える。 */
  submitDisabled?: boolean;
  submitDisabledLabel?: string;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [roomTitle, setRoomTitle] = useState(roomTitleOverride ?? '');
  const [copied, setCopied] = useState(false);
  const [defaultDisplayName, setDefaultDisplayName] = useState('');
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(!anonymous);

  const userEmail = user?.email;
  useEffect(() => {
    if (anonymous) return; // 完全外部ユーザーはプロフィールを持たない・表示名は自分で入力する
    let isMounted = true;
    apiClient
      .get('/api/basic_profile_info/me')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const nameEn = data.name_english?.trim();
          const nameJp = data.name_kanji?.trim();
          const fallback = userEmail?.split('@')[0] ?? 'guest';
          if (isMounted) {
            setDefaultDisplayName(nameEn || nameJp || fallback);
            if (data.avatar_link) setMyAvatarUrl(data.avatar_link);
          }
        } else if (isMounted) {
          setDefaultDisplayName(userEmail?.split('@')[0] ?? 'guest');
        }
      })
      .catch(() => {
        if (isMounted) setDefaultDisplayName(userEmail?.split('@')[0] ?? 'guest');
      })
      .finally(() => {
        if (isMounted) setProfileLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [user?.id, userEmail, anonymous]);

  useEffect(() => {
    if (anonymous) return; // ルーム名は呼び出し元(招待URLの解決結果)から渡される
    apiClient
      .get('/api/connect/rooms')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const found = data.rooms?.find((r: { room_id: string; room_title?: string }) => r.room_id === roomId);
          if (found?.room_title) setRoomTitle(found.room_title);
        }
      })
      .catch(() => {});
  }, [roomId, anonymous]);

  const copyRoomUrl = async () => {
    try {
      const url = `${window.location.origin}/connect/call/${roomId}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return (
    <div className="h-dvh w-screen overflow-y-auto bg-slate-50/30 p-6 md:p-10 relative">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />

      <div className="max-w-3xl mx-auto relative z-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2 text-sky-600 font-bold text-sm tracking-wide uppercase">
              <Video className="w-4 h-4" />
              <span>SmiRing Connect</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-gray-900 tracking-tight">
              {roomTitle ? roomTitle : 'ミーティングに参加'}
            </h1>
            {!anonymous && (
              <button
                onClick={copyRoomUrl}
                className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 hover:border-sky-300 rounded-lg text-sm font-bold text-gray-600 transition-all active:scale-95"
                title="招待URLをコピー"
              >
                <span className="text-sky-600">ルームコード:</span>
                <span className="font-mono">{roomId}</span>
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4 text-slate-400" />
                )}
              </button>
            )}
          </div>

          {(onBack || !anonymous) && (
            <button
              onClick={onBack ?? (() => navigate('/connect'))}
              className="self-start flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>戻る</span>
            </button>
          )}
        </div>

        <div className="bg-white border border-slate-100 rounded-3xl p-4 md:p-6 shadow-sm">
          {statusMessage && (
            <div className="mb-4 flex items-center gap-2.5 px-4 py-3 bg-sky-50 border border-sky-100 rounded-2xl text-sky-700">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <p className="text-xs font-bold">{statusMessage}</p>
            </div>
          )}
          {profileLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-sky-500" />
              <p className="text-xs font-semibold">プロフィール情報を読み込み中...</p>
            </div>
          ) : (
            <PreJoinScreen
              defaultUsername={defaultDisplayName}
              avatarUrl={myAvatarUrl}
              joinLabel="このルームに参加"
              requireUsername={anonymous}
              submitDisabled={submitDisabled}
              submitDisabledLabel={submitDisabledLabel}
              onSubmit={onJoin}
              onError={(e) => onError(e.message)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** DBアカウントを持たない招待URL経由の参加者向け情報。渡された場合、CallRoomPageは
 *  ログイン前提のAPI呼び出し（プロフィール取得・/api/connect/token）を避け、代わりに
 *  invite_tokenで認可された匿名向けエンドポイント（join-request → 待機室 → anonymous-token）
 *  を使う。待機室は外部ミーティングで常にON（切り替えUIは未実装）なので、admitted になる
 *  手段が無い今のバックエンド実装では 'waiting' で止まり続ける想定。 */
export interface AnonymousInvite {
  token: string;
  roomId: string;
  roomTitle: string;
}

export default function CallRoomPage({
  anonymousInvite,
}: {
  anonymousInvite?: AnonymousInvite;
} = {}) {
  const navigate = useNavigate();
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const roomId = anonymousInvite?.roomId ?? routeRoomId;
  const { user } = useAuth();

  const [stage, setStage] = useState<'prejoin' | 'connecting' | 'waiting' | 'in-call'>('prejoin');
  const [token, setToken] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [roomTitle, setRoomTitle] = useState(anonymousInvite?.roomTitle ?? '');
  const [meetingType, setMeetingType] = useState<'fixed' | 'external'>(anonymousInvite ? 'external' : 'fixed');
  const [isHost, setIsHost] = useState(false);
  const [choices, setChoices] = useState<PreJoinChoices | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [waitlistId, setWaitlistId] = useState<string | null>(null);

  // Warn user with native browser dialog when trying to close the tab or leave during active call
  useEffect(() => {
    if (isDisconnected || !token || !serverUrl) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDisconnected, token, serverUrl]);

  // The pre-join tracks (with any background processor already attached) captured
  // in PreJoinStage. Handed to <CallRoomInner> to publish once connected (see its
  // publish effect) instead of letting <LiveKitRoom> auto-capture fresh ones.
  const [pendingVideoTrack, setPendingVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [pendingAudioTrack, setPendingAudioTrack] = useState<LocalAudioTrack | null>(null);

  const handlePreJoinSubmit = useCallback(
    (preJoinChoices: PreJoinChoices, videoTrack: LocalVideoTrack | null, audioTrack: LocalAudioTrack | null) => {
      setPendingVideoTrack(videoTrack);
      setPendingAudioTrack(audioTrack);
      setChoices(preJoinChoices);
      setStage('connecting');
    },
    [],
  );

  const handlePreJoinError = useCallback((message: string) => {
    setErrorMsg(message);
  }, []);

  // "戻る" from the connecting/waiting status banner: just resets the join-request
  // bookkeeping and steps back to 'prejoin' — NOT a navigation, and deliberately does
  // NOT touch pendingVideoTrack/pendingAudioTrack. Those are the exact same live tracks
  // the still-mounted PreJoinScreen preview is displaying (see the merged
  // prejoin/connecting/waiting render below — PreJoinStage never unmounts across those
  // three stages), so stopping them here would black out the camera the user is looking
  // at. PreJoinScreen keeps owning/stopping them for its own lifetime; if the user
  // resubmits, handlePreJoinSubmit re-adopts the same track objects, not fresh ones.
  const handleCancelJoin = useCallback(() => {
    // Best-effort: withdraw the pending waitlist row so it doesn't sit there forever with
    // no admission UI (yet) to ever resolve it. Not awaited — this is cleanup, not something
    // that should delay stepping back to prejoin.
    if (waitlistId && roomId) {
      void apiClient.delete(`/api/connect/rooms/${roomId}/join-request/${waitlistId}`).catch(() => {});
    }
    setPendingVideoTrack(null);
    setPendingAudioTrack(null);
    setWaitlistId(null);
    setErrorMsg('');
    setStage('prejoin');
  }, [waitlistId, roomId]);

  // Claims a LiveKit token for an admitted (or waiting-room-exempt) anonymous invite-link
  // visitor. Shared by the immediate "no wait needed" path and the waiting-room poll below.
  const claimAnonymousToken = useCallback(
    async (waitlistIdForClaim: string | null) => {
      if (!anonymousInvite || !roomId) return;
      try {
        const res = await apiClient.post(`/api/connect/rooms/${roomId}/anonymous-token`, {
          invite_token: anonymousInvite.token,
          username: choices?.username || 'guest',
          waitlist_id: waitlistIdForClaim,
        });

        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(
            body.detail ||
              '通話サーバー（LiveKit）がまだ準備中です。カメラ・マイクの確認まではできています。',
          );
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || `トークンの取得に失敗しました (${res.status})`);
          return;
        }

        const data = await res.json();
        setToken(data.token);
        setServerUrl(data.url);
        if (data.roomTitle) setRoomTitle(data.roomTitle);
        setIsHost(!!data.is_host);
        setMeetingType('external');
        setStage('in-call');
      } catch (e: any) {
        setErrorMsg(e?.message || '接続中にエラーが発生しました');
      }
    },
    [anonymousInvite, roomId, choices?.username],
  );

  // Fetch token and connect to room, once the pre-join stage has been completed.
  useEffect(() => {
    if (!roomId || stage !== 'connecting') return;
    let isMounted = true;

    const initConnection = async () => {
      try {
        const displayName = choices?.username || user?.email?.split('@')[0] || 'guest';

        // 招待URL経由の完全外部ユーザー: いきなりトークンは発行せず、まず入室リクエストを
        // 登録して待機室へ（外部ミーティングは待機室が常にONのため）。
        if (anonymousInvite) {
          const res = await apiClient.post(`/api/connect/rooms/${roomId}/join-request`, {
            invite_token: anonymousInvite.token,
            username: displayName,
          });
          if (!isMounted) return;
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setErrorMsg(body.error || `入室リクエストに失敗しました (${res.status})`);
            return;
          }
          const data = await res.json();
          setWaitlistId(data.waitlist_id ?? null);
          setStage('waiting');
          return;
        }

        const res = await apiClient.post('/api/connect/token', {
          room: roomId,
          username: displayName,
        });

        if (!isMounted) return;

        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(
            body.detail ||
              '通話サーバー（LiveKit）がまだ準備中です。カメラ・マイクの確認まではできています。',
          );
          return;
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || `トークンの取得に失敗しました (${res.status})`);
          return;
        }

        const data = await res.json();
        setToken(data.token);
        setServerUrl(data.url);
        if (data.roomTitle) {
          setRoomTitle(data.roomTitle);
        }
        setIsHost(!!data.is_host);
        if (data.meeting_type) {
          setMeetingType(data.meeting_type);
        }
        setStage('in-call');
      } catch (e: any) {
        if (isMounted) {
          setErrorMsg(e?.message || '接続中にエラーが発生しました');
        }
      }
    };

    initConnection();

    return () => {
      isMounted = false;
    };
  }, [roomId, stage, user?.id, choices?.username, anonymousInvite]);

  // Waiting-room heartbeat: pings every 5s while sitting in the waitlist so the host's
  // Participants panel can tell "still actually waiting" apart from "closed the tab /
  // lost network without saying so" — see the 20s staleness check in the backend's
  // GET .../waitlist (connectRoutes.ts), which is what actually flips a quiet row to
  // 'left'. Best-effort, not awaited: a missed beat or two just means a slightly late
  // flip, not a broken poll loop.
  useEffect(() => {
    if (stage !== 'waiting' || !waitlistId || !roomId) return;

    const beat = () => {
      void apiClient
        .post(`/api/connect/rooms/${roomId}/join-request/${waitlistId}/heartbeat`)
        .catch(() => {});
    };

    beat();
    const interval = setInterval(beat, 5000);
    return () => clearInterval(interval);
  }, [stage, waitlistId, roomId]);

  // Fast-path cancel: closing the tab (or navigating away entirely) while waiting should
  // withdraw the waitlist row roughly immediately rather than waiting out the heartbeat
  // timeout above. `beforeunload`/`pagehide` are the only events guaranteed to still fire
  // in that moment, and a plain fetch gets killed mid-flight when the page actually
  // unloads — `keepalive: true` is what lets it survive long enough to land. Same DELETE
  // endpoint handleCancelJoin's "戻る" button uses; harmless if it ends up firing twice
  // (deleting an already-gone row is a no-op) or if the row was never created.
  useEffect(() => {
    if (stage !== 'waiting' || !waitlistId || !roomId) return;

    const cancelBeacon = () => {
      void apiClient
        .delete(`/api/connect/rooms/${roomId}/join-request/${waitlistId}`, { keepalive: true })
        .catch(() => {});
    };

    window.addEventListener('pagehide', cancelBeacon);
    window.addEventListener('beforeunload', cancelBeacon);
    return () => {
      window.removeEventListener('pagehide', cancelBeacon);
      window.removeEventListener('beforeunload', cancelBeacon);
    };
  }, [stage, waitlistId, roomId]);

  // Waiting-room poll: waits for a 'connect_room_waitlist' row to be flipped out of
  // 'pending' by a host action (admit/deny) or by the heartbeat-staleness check above.
  useEffect(() => {
    if (stage !== 'waiting' || !anonymousInvite || !waitlistId || !roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await apiClient.get(`/api/connect/rooms/${roomId}/join-request/${waitlistId}`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'admitted') {
            await claimAnonymousToken(waitlistId);
            return;
          }
          if (data.status === 'denied') {
            setErrorMsg('入室が許可されませんでした');
            return;
          }
        }
      } catch {
        // Keep polling through transient network errors.
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };

    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stage, anonymousInvite, waitlistId, roomId, claimAnonymousToken]);

  // No videoCaptureDefaults/audioCaptureDefaults here any more: <LiveKitRoom>
  // below no longer auto-captures (video/audio are false) — the camera/mic are
  // captured once in PreJoinScreen and published manually (see CallRoomInner's
  // publish effect), so there's nothing for capture defaults to configure.
  // publishDefaults still applies to that manual publishTrack() call, since it's
  // a Room-level default, not just for auto-publish.
  const roomOptions: RoomOptions = useMemo(
    () => ({
      adaptiveStream: {
        pixelDensity: 'screen',
      },
      dynacast: true,
      publishDefaults: {
        // Simulcast means encoding the *same* camera frame at multiple resolutions
        // simultaneously — real, well-documented CPU/battery cost on top of whatever the
        // resolution itself costs. Desktop keeps three layers so a grid view of many
        // participants isn't decoding full 720p per tile; a phone gets one layer at the
        // resolution PreJoinScreen already captures it at (see VIDEO_CAPTURE_CONSTRAINTS)
        // — encoding 720p there just to immediately encode it back down to 360p would waste
        // exactly the budget this is meant to save. The tradeoff: anyone who pins or
        // fullscreens a phone participant sees 360p blown up, not switchable-to-720p.
        videoEncoding: isMobileDevice() ? VideoPresets.h360.encoding : VideoPresets.h720.encoding,
        simulcast: !isMobileDevice(),
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        // LiveKit's own default here is 'balanced', which — per Chromium's
        // BalancedDegradationSettings table — responds to CPU/bandwidth overuse by cutting
        // framerate first while holding resolution steady, only dropping resolution once fps
        // is already low. That's exactly the "stays 720p, framerate craters" pattern reported
        // when the tab is backgrounded: Chromium lowers a hidden tab's whole renderer-process
        // OS scheduling priority (not something a page can opt out of), the encoder thread gets
        // starved, and 'balanced' reads that as CPU overuse. 'maintain-framerate' instead lets
        // resolution drop to keep motion smooth, which reads better for a talking-head call than
        // stutter — the actual amount of degradation is unchanged, only which axis absorbs it.
        degradationPreference: 'maintain-framerate',
        screenShareEncoding: {
          // 4 Mbps over a 1080p-capped capture is a little over twice the bits per pixel the
          // old 6 Mbps had to spread across a native Retina surface, so this is a quality
          // increase and a bandwidth cut at once (see the resolution note in
          // `useScreenShareToggle`).
          maxBitrate: 4_000_000,
          maxFramerate: 15,
          priority: 'high',
        },
        // One fallback layer, not two: with the main encoding capped at 1080p, the old
        // `h1080fps15` layer duplicated it. Dropping it means the sharer's machine encodes
        // the screen twice instead of three times. `h720fps5` stays for anyone viewing the
        // share in a small tile.
        screenShareSimulcastLayers: [ScreenSharePresets.h720fps5],
        audioPreset: { maxBitrate: 32_000 },
        dtx: true,
        red: true,
      },
      disconnectOnPageLeave: false,
    }),
    [],
  );

  // A mini-room switch intentionally disconnects the current LiveKit connection before
  // reconnecting to the destination room (see useMiniRooms' applyReconnect — required
  // because livekit-client's Room.connect() silently no-ops while already connected).
  // That disconnect fires the same RoomEvent.Disconnected / onDisconnected as a real
  // "the user left the call", so without this flag handleLeave would treat every mini-
  // room move as the participant leaving and end the call before the reconnect happens.
  const isSwitchingRoomsRef = useRef(false);
  const switchingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBeforeReconnectDisconnect = useCallback(() => {
    isSwitchingRoomsRef.current = true;
    if (switchingTimeoutRef.current) clearTimeout(switchingTimeoutRef.current);
    // ルーム切替中の不意の切断誤判定を防ぐ（8秒間のセーフティガード）
    switchingTimeoutRef.current = setTimeout(() => {
      isSwitchingRoomsRef.current = false;
    }, 8000);
  }, []);

  const handleConnected = useCallback(() => {
    if (switchingTimeoutRef.current) {
      clearTimeout(switchingTimeoutRef.current);
      switchingTimeoutRef.current = null;
    }
    isSwitchingRoomsRef.current = false;
  }, []);

  const handleLeave = () => {
    if (isSwitchingRoomsRef.current) {
      console.log('[CallRoomPage] handleLeave: ignoring disconnect caused by mini-room switch');
      return;
    }
    setIsDisconnected(true);
  };

  // Applies a mini-room switch: updates the token/url that <LiveKitRoom> is rendered
  // with (it reconnects on token/serverUrl prop changes — see useLiveKitRoom), and
  // carries over the participant's *current* mic/camera enabled state so muting isn't
  // silently undone by the reconnect (video/audio below otherwise only reflect the
  // original pre-join choice, not anything toggled mid-call).
  const handleReconnect = useCallback((target: ReconnectTarget) => {
    console.log('[CallRoomPage] handleReconnect: setting new token/url', { url: target.url });
    setToken(target.token);
    setServerUrl(target.url);
    setChoices((prev) => (prev ? { ...prev, audioEnabled: target.audio, videoEnabled: target.video } : prev));
  }, []);

  const postCallPath = anonymousInvite ? '/' : '/connect';

  const handleCloseWindow = () => {
    window.close();
    navigate(postCallPath);
  };

  if (isDisconnected) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
        <div className="w-16 h-16 rounded-3xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center mb-4">
          <Check className="w-8 h-8 text-sky-400" />
        </div>
        <h1 className="text-2xl font-black mb-2">通話を終了しました</h1>
        <p className="text-sm text-gray-400 mb-8 max-w-sm">
          このタブを閉じるか、SmiRingConnectのトップページに戻ることができます。
        </p>
        <div className="flex gap-3">
          <button
            onClick={handleCloseWindow}
            className="px-6 py-3 bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-sky-900/30 transition-all active:scale-95"
          >
            タブを閉じる
          </button>
          <button
            onClick={() => navigate(postCallPath)}
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 font-bold text-sm rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            ルーム一覧に戻る
          </button>
        </div>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
        <div className="w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mb-4">
          <AlertTriangle className="w-8 h-8 text-rose-500" />
        </div>
        <h1 className="text-2xl font-black mb-2">接続できませんでした</h1>
        <p className="text-sm text-gray-400 mb-8 max-w-md">{errorMsg}</p>
        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-sky-900/30 transition-all active:scale-95"
          >
            再試行
          </button>
          <button
            onClick={() => navigate(postCallPath)}
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 font-bold text-sm rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  // 招待URL経由の匿名参加は、prejoin → connecting(入室リクエスト送信) → waiting(承認待ち) の
  // 間ずっと同じ PreJoinStage インスタンスを表示し続ける（カメラ・マイク・背景の調整をそのまま
  // 続けられるようにするため、途中で画面を切り替えたり getUserMedia を撮り直したりしない）。
  // 通常の内部ログイン経由の参加は待機室を通らないので、'connecting' は一瞬で終わる想定の
  // ままシンプルなスピナーで十分。
  if (stage === 'prejoin' || (anonymousInvite && (stage === 'connecting' || stage === 'waiting'))) {
    const statusMessage = !anonymousInvite
      ? undefined
      : stage === 'connecting'
        ? '入室をリクエストしています...'
        : stage === 'waiting'
          ? 'ホストの承認をお待ちください。この画面でカメラ・マイク・背景を調整できます。'
          : undefined;

    return (
      <PreJoinStage
        roomId={roomId!}
        onJoin={handlePreJoinSubmit}
        onError={handlePreJoinError}
        onBack={stage !== 'prejoin' ? handleCancelJoin : undefined}
        anonymous={!!anonymousInvite}
        roomTitleOverride={anonymousInvite?.roomTitle}
        statusMessage={statusMessage}
        submitDisabled={stage !== 'prejoin'}
        submitDisabledLabel={stage === 'connecting' ? 'リクエスト送信中...' : '承認待ち...'}
      />
    );
  }

  if (stage === 'connecting' || !token || !serverUrl) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center gap-4 text-white">
        <Loader2 className="w-10 h-10 animate-spin text-sky-500" />
        <p className="font-bold text-sm text-gray-300">ルームに接続しています...</p>
      </div>
    );
  }

  return (
    <div className="h-dvh w-screen bg-[#0f1115] flex flex-col overflow-hidden select-none" data-lk-theme="default">
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect
        video={false}
        audio={false}
        options={roomOptions}
        onConnected={handleConnected}
        onDisconnected={handleLeave}
        onError={(e) => {
          setErrorMsg(e.message);
        }}
        style={{ height: '100%' }}
      >
        <CallRoomInner
          roomId={roomId!}
          roomTitle={roomTitle}
          isHost={isHost}
          onClaimHostSuccess={() => setIsHost(true)}
          onReconnect={handleReconnect}
          onBeforeReconnectDisconnect={handleBeforeReconnectDisconnect}
          pendingVideoTrack={pendingVideoTrack}
          pendingAudioTrack={pendingAudioTrack}
          initialMediaChoices={choices}
          isInternalMeeting={meetingType !== 'external' && !anonymousInvite}
        />
      </LiveKitRoom>
    </div>
  );
}
