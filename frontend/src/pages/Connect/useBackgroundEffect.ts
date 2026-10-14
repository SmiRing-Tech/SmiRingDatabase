import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { ParticipantEvent, Track, type LocalVideoTrack } from 'livekit-client';
import {
  supportsMediapipeBackground,
  type SegmentationQuality,
  type SlowFrameMeasure,
} from '../../lib/video/MediapipeBackgroundProcessor';
import {
  canSwapQualityInPlace,
  createBackgroundProcessor,
  isBackgroundProcessor,
  isFailedProcessor,
  removeBackgroundProcessor,
  type BackgroundProcessor,
} from '../../lib/video/backgroundProcessor';
import { BlankFrameProcessor } from '../../lib/video/BlankFrameProcessor';
import { diagEvent, diagState } from '../../lib/connectDiagnostics';
import {
  useBackgroundLibrary,
  readStoredChoice,
  writeStoredChoice,
  detectSegmentationQuality,
  detectSegmentationFps,
  qualityWithinLoadDeadline,
  HIGH_MODEL_FALLBACK_MESSAGE,
  type BackgroundMode,
} from './backgroundLibrary';

export { PRESETS } from './backgroundLibrary';

/**
 * Background effect for the published camera track: off / blur / still image,
 * applied to either the background or the subject.
 *
 * Split in two on purpose. This hook owns the processor and must be called
 * somewhere that stays mounted for the whole call — the saved effect has to be
 * restored on join, not on the first time someone opens a settings panel, and
 * unmounting would drop the processor reference and force a rebuild.
 * `BackgroundControls` is the panel UI and can come and go freely.
 *
 * The picture library and the remembered choice live in `backgroundLibrary`,
 * shared with the pre-join preview so the two cannot drift apart.
 */
export function useBackgroundEffect(isGuest = false) {
  const { localParticipant } = useLocalParticipant();
  const processorRef = useRef<BackgroundProcessor | null>(null);
  // Guards the automatic high -> balanced fallback (see handlePerfSlow) so
  // it fires at most once per "high" attempt; setQuality resets it whenever the
  // user picks 'high' again themselves, so a later attempt gets its own chance.
  const autoDowngradedRef = useRef(false);
  // setQuality closes over applyEffect, and handlePerfSlow needs to call
  // setQuality — but handlePerfSlow is handed to applyEffect as a
  // constructor option, so it has to exist before setQuality does. A ref sidesteps
  // the circular dependency: handlePerfSlow is only ever invoked later, from
  // inside a running processor, well after this effect has populated it.
  const setQualityRef = useRef<
    ((q: SegmentationQuality, opts?: { auto?: boolean }) => Promise<boolean>) | undefined
  >(undefined);
  // Re-applies the current choice from scratch; see handlePipelineFailure.
  const reapplyRef = useRef<(() => Promise<unknown>) | undefined>(undefined);
  // Segmentation rate set by the load governor (null = the device default); see setPerformanceProfile.
  const perfProfileRef = useRef<PerformanceProfile | null>(null);

  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(() => readStoredChoice(isGuest), [isGuest]);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  // Starts at whatever the track already has attached (e.g. PreJoin already
  // picked a quality before publish) so this hook doesn't rebuild the
  // processor at a different quality the moment it takes over. Otherwise the
  // stored manual override, or a fresh capability-based guess — see
  // detectSegmentationQuality(). There is no automatic upgrade path (see handlePerfSlow).
  const [quality, setQualityState] = useState<SegmentationQuality>(() => {
    const publication = localParticipant.getTrackPublication(Track.Source.Camera);
    const existing = (publication?.track as LocalVideoTrack | undefined)?.getProcessor();
    if (isBackgroundProcessor(existing)) return existing.quality;
    return stored.quality ?? detectSegmentationQuality();
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported);

  const getCameraTrack = useCallback(() => {
    const publication = localParticipant.getTrackPublication(Track.Source.Camera);
    return publication?.track as LocalVideoTrack | undefined;
  }, [localParticipant]);

  /**
   * Wired into every processor as onSustainedSlowFrames, which fires once the effect is
   * measurably too heavy for the machine *as it is right now* — a weak CPU, or a strong one busy
   * with other apps; judged from what's measured live, never from the hardware's spec.
   *
   * 'high' falls back to 'balanced', for this call only (not written to the remembered choice,
   * so the next join starts from what the person actually picked). 'balanced' is as far as this
   * hook goes on its own: some people won't show their room without an effect, so switching it
   * off is never automatic here — the measurement is only recorded, for whatever decides the
   * call's overall load budget to act on (lighter video first; turning the camera off with an
   * explanation only as a last resort).
   *
   * There's deliberately no automatic *upgrade* to 'high' any more. On the main-thread processor
   * every quality swap rebuilds the segmenter — a blank-video gap while the model loads, and a
   * main-thread freeze on slower machines (7s twice in a measured call) — and an upgrade that
   * later proves too heavy swaps straight back, which is the "video goes black every ~20s" loop
   * that was reported. The worker processor swaps without either, but an upgrade that doesn't
   * hold is still churn for nothing. 'high' is only ever the person's own choice (the HD toggle).
   */
  const handlePerfSlow = useCallback((processorQuality: SegmentationQuality, measure: SlowFrameMeasure) => {
    console.warn('[Connect] background effect running slow', processorQuality, measure);
    if (processorQuality === 'high') {
      if (autoDowngradedRef.current) return;
      autoDowngradedRef.current = true;
      diagEvent('background-auto-downgrade', { ...measure });
      void setQualityRef.current?.('balanced', { auto: true }).then((ok) => {
        if (ok) setError('処理が重かったため、背景エフェクトを標準画質に切り替えました。');
      });
      return;
    }
    diagEvent('background-slow', { quality: processorQuality, ...measure });
  }, []);

  /**
   * The worker pipeline broke mid-call (see WorkerBackgroundProcessor's onPipelineFailure): its
   * output has stopped updating. Rebuild from the current choice — the broken processor no longer
   * counts as reusable, and the worker path is now off for this page, so this lands on the
   * main-thread processor.
   */
  const handlePipelineFailure = useCallback((reason: string) => {
    diagEvent('background-pipeline-failed', { reason });
    void reapplyRef.current?.().catch((e) => console.error('[Connect] failed to rebuild background effect:', e));
  }, []);

  /**
   * 'high' was asked for but its model didn't arrive in time (see qualityWithinLoadDeadline):
   * settle on 'balanced' as if the person had picked it, including for future joins on this
   * device. The person can still retry 'high' by hand.
   */
  const handleHighModelFallback = useCallback((fallbackMode: BackgroundMode, fallbackImageId: string | undefined) => {
    writeStoredChoice({ mode: fallbackMode, imageId: fallbackImageId, quality: 'balanced' });
    setQualityState('balanced');
    setError(HIGH_MODEL_FALLBACK_MESSAGE);
  }, []);

  /**
   * Brings the camera track in line with the requested effect. Reuses the running
   * processor where it can — rebuilding one means reloading the segmentation
   * model, which is a visible stall (and a 16 MB download on the 'high' model).
   * The worker processor can even change model in place, with no stall at all.
   *
   * Resolves to the quality actually applied, which is 'balanced' instead of a
   * requested 'high' whenever that model couldn't be loaded in time — callers that
   * persist the choice afterwards must store this, not what they asked for.
   */
  const applyEffect = useCallback(
    async (
      nextMode: BackgroundMode,
      nextImageId: string | undefined,
      nextQuality: SegmentationQuality,
    ): Promise<SegmentationQuality> => {
      const track = getCameraTrack();
      if (!track) return nextQuality;

      if (nextMode === 'off') {
        await removeBackgroundProcessor(track);
        processorRef.current = null;
        return nextQuality;
      }

      const imageUrl = nextMode === 'image' ? imageUrlFor(nextImageId) : undefined;
      if (nextMode === 'image' && !imageUrl) {
        throw new Error('選択した背景画像が見つかりませんでした。');
      }

      // Get the 'high' model into memory (or give up on it) *before* touching whatever is
      // currently running — mid-call, that keeps the existing effect live on the published
      // track for the whole download instead of bridging through a blank frame, and a failed
      // attempt never disturbs it at all. A processor that's already 'high' has nothing to load.
      let effectiveQuality = nextQuality;
      const attachedBefore = track.getProcessor();
      if (
        nextQuality === 'high' &&
        !(isBackgroundProcessor(attachedBefore) && attachedBefore.quality === 'high')
      ) {
        effectiveQuality = await qualityWithinLoadDeadline('high');
        if (effectiveQuality !== nextQuality) handleHighModelFallback(nextMode, nextImageId);
      }

      // Don't trust processorRef alone: the track may already be carrying a
      // processor this hook instance didn't create (e.g. the one PreJoinScreen
      // attached before publish — see usePreJoinBackground). Ask the track
      // itself, and adopt a match into processorRef rather than treating "not
      // mine" as "not attached" and rebuilding — that raced the pre-join
      // processor's own setProcessor() call and intermittently tore down its
      // WebGL context / segmentation pipeline mid-flight.
      const existingOnTrack = track.getProcessor();
      const current = isBackgroundProcessor(existingOnTrack) ? existingOnTrack : processorRef.current;
      const reusable = !!current && track.getProcessor() === current && !isFailedProcessor(current);

      if (reusable && (current.quality === effectiveQuality || canSwapQualityInPlace(current))) {
        if (processorRef.current !== current) {
          // Adopting one this hook didn't build (the pre-join screen's): its reports should
          // come here now, not to the unmounted pre-join hook.
          current.setCallbacks({
            onSustainedSlowFrames: (measure) => handlePerfSlow(current.quality, measure),
            onSustainedFastFrames: undefined,
            onPipelineFailure: handlePipelineFailure,
          });
        }
        processorRef.current = current;
        // The worker processor loads and warms the new model beside the running one and then
        // hands over — the published video never pauses or goes black.
        if (current.quality !== effectiveQuality && canSwapQualityInPlace(current)) {
          await current.setQuality(effectiveQuality);
        }
        await current.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        return effectiveQuality;
      }

      // Otherwise — a main-thread processor at a different quality, a broken worker
      // pipeline, or nothing attached yet — build a new processor, which means a new
      // segmenter load. MediaPipe's tasks-vision WASM build pools GPU buffers
      // globally rather than scoping them per ImageSegmenter instance, so two
      // segmenters alive at once corrupt each other's GL state — stop the old
      // one *before* building the new one, not after (letting setProcessor()
      // build the replacement first and tear down the old one internally is
      // exactly the ordering that leaves both alive simultaneously for a
      // moment). See MediapipeBackgroundProcessor.init()'s doc comment.
      if (track.getProcessor()) await track.stopProcessor();

      // With nothing attached, the published track would fall straight back to raw
      // camera video for as long as the new model takes to load — bridge through a
      // blank placeholder instead, so a swap always reads as "video paused," never
      // "the background effect fell off." See BlankFrameProcessor's doc comment.
      await track.setProcessor(new BlankFrameProcessor());

      const processor = createBackgroundProcessor({
        quality: effectiveQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
        imageUrl: imageUrl ?? null,
        blurRadius: 16,
        temporalSmoothing: 0.25,
        edgeFeather: 1.5,
        matteLo: 0.3,
        matteHi: 0.75,
        segmentationFps: perfProfileRef.current?.segmentationFps ?? detectSegmentationFps(),
        segmentationScheduler: perfProfileRef.current?.segmentationScheduler ?? 'interval',
        // Every processor reports when it's too heavy (see handlePerfSlow for what happens
        // next). Read the quality at call time: the worker processor changes it in place.
        // No onSustainedFastFrames: automatic upgrades are off, see handlePerfSlow.
        onSustainedSlowFrames: (measure) => handlePerfSlow(processor.quality, measure),
        onPipelineFailure: handlePipelineFailure,
      });
      // setProcessor() resolves once the model is loaded and the pipeline is wired,
      // not once its output is stable — the processor blanks its own output until
      // then (see its renderFrame()), so the blank bridge above stays effectively in
      // place, just handed off to the real processor's own blanking, until this
      // resolves.
      await track.setProcessor(processor);
      await processor.waitUntilReady();
      processorRef.current = processor;
      return effectiveQuality;
    },
    [getCameraTrack, imageUrlFor, handlePerfSlow, handleHighModelFallback, handlePipelineFailure],
  );

  const commit = useCallback(
    async (next: { mode?: BackgroundMode; imageId?: string }) => {
      const nextMode = next.mode ?? mode;
      const nextImageId = 'imageId' in next ? next.imageId : imageId;

      setBusy(true);
      setError('');
      try {
        const applied = await applyEffect(nextMode, nextImageId, quality);
        setMode(nextMode);
        setImageId(nextImageId);
        writeStoredChoice({ mode: nextMode, imageId: nextImageId, quality: applied });
      } catch (e) {
        console.error('[Connect] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId, quality],
  );

  // The camera track may be published after this mounts (joined with the
  // camera off, or switched devices), so re-apply whenever a new one shows up.
  useEffect(() => {
    if (!supported || mode === 'off') return;

    const reapply = () => {
      void applyEffect(mode, imageId, quality).catch((e) =>
        console.error('[Connect] failed to re-apply background effect:', e),
      );
    };

    reapply();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, reapply);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, reapply);
    };
  }, [supported, localParticipant, applyEffect, mode, imageId, quality]);

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError('');
      try {
        const uploaded = await uploadBackground(file);
        // Select it immediately — uploading a background and not using it is not a thing.
        const applied = await applyEffect('image', uploaded.id, quality);
        setMode('image');
        setImageId(uploaded.id);
        writeStoredChoice({ mode: 'image', imageId: uploaded.id, quality: applied });
      } catch (e) {
        console.error('[Connect] background upload failed:', e);
        setError(e instanceof Error ? e.message : 'アップロードに失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, uploadBackground, quality],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError('');
      try {
        await deleteBackground(id);
        // Deleting the background currently on screen leaves nothing to show.
        if (imageId === id) {
          const applied = await applyEffect('blur', undefined, quality);
          setMode('blur');
          setImageId(undefined);
          writeStoredChoice({ mode: 'blur', quality: applied });
        }
      } catch (e) {
        console.error('[Connect] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, deleteBackground, imageId, quality],
  );

  /**
   * The manual Balanced/High toggle — see BackgroundControls. Also the path
   * handlePerfSlow uses to fall back automatically (`auto`); returns whether it
   * succeeded so that caller can decide whether to surface a message.
   *
   * An `auto` change is for this call only: it isn't remembered for the next join, and it
   * doesn't re-arm the automatic fallback the way a person's own choice does.
   */
  const setQuality = useCallback(
    async (nextQuality: SegmentationQuality, opts?: { auto?: boolean }) => {
      // A person choosing 'high' again gets a fresh shot at the automatic fallback —
      // otherwise one auto-swap early in a call would silently suppress it for good.
      if (!opts?.auto && nextQuality === 'high') autoDowngradedRef.current = false;
      setBusy(true);
      setError('');
      try {
        if (!opts?.auto) writeStoredChoice({ mode, imageId, quality: nextQuality });
        setQualityState(nextQuality);
        const applied = await applyEffect(mode, imageId, nextQuality);
        // A 'high' that fell back to 'balanced' isn't a success for the caller's purposes —
        // handleHighModelFallback has already said what actually happened.
        return applied === nextQuality;
      } catch (e) {
        console.error('[Connect] failed to change segmentation quality:', e);
        setError(e instanceof Error ? e.message : '画質の変更に失敗しました');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId],
  );

  useEffect(() => {
    setQualityRef.current = setQuality;
  }, [setQuality]);

  useEffect(() => {
    reapplyRef.current = () => applyEffect(mode, imageId, quality);
  }, [applyEffect, mode, imageId, quality]);

  /**
   * The load governor's segmentation rate for the current camera frame rate (null = back to the
   * device default). Applied to the running processor in place, and to any processor built later.
   */
  const setPerformanceProfile = useCallback(
    (profile: PerformanceProfile | null) => {
      perfProfileRef.current = profile;
      const processor = getCameraTrack()?.getProcessor();
      if (!isBackgroundProcessor(processor)) return;
      processor.updateOptions({
        segmentationFps: profile?.segmentationFps ?? detectSegmentationFps(),
        segmentationScheduler: profile?.segmentationScheduler ?? 'interval',
      });
    },
    [getCameraTrack],
  );

  // Diagnostics timeline (lib/connectDiagnostics). `error` also carries the automatic
  // high <-> balanced switch messages, which is the main thing worth seeing there.
  useEffect(() => {
    diagState('background', supported ? mode : 'unsupported');
    diagState('backgroundQuality', quality);
  }, [supported, mode, quality]);
  useEffect(() => {
    if (error) diagEvent('background-message', { message: error });
  }, [error]);

  return {
    supported,
    mode,
    imageId,
    quality,
    uploads,
    busy,
    error,
    commit,
    setQuality,
    setPerformanceProfile,
    handleUpload,
    handleDelete,
    imageUrlFor,
  };
}

export type BackgroundEffectState = ReturnType<typeof useBackgroundEffect>;

export interface PerformanceProfile {
  segmentationFps: number;
  segmentationScheduler: 'interval' | 'exact';
}
