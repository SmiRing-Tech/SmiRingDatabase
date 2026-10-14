import type { VoiceLevelerSettingsMessage, VoiceLevelerState } from './voiceLeveler.worklet';
import voiceLevelerWorkletUrl from './voiceLeveler.worklet.ts?worker&url';

/**
 * Voice "finishing" chain, prototyped in /dev/audio-gain-lab: the processing that makes speech
 * *sound* loud and clear at a given level, as opposed to just measuring loud.
 *
 *   input -> leveler -> low cut (90Hz) -> presence boost (~3kHz) -+-> compressor -> gain -> limiter -> output
 *                                                                  |                ^
 *                                                                  +-> air (exciter)+
 *
 *  - Leveler: a slow gain that brings speech to a target level over seconds — the far-from-mic /
 *    quiet-mic fix (see voiceLeveler.worklet.ts). First, so everything after it sees a
 *    consistent level and the compressor below behaves the same for quiet and loud talkers.
 *  - Low cut: rumble, desk thumps and the boom of a mic 50cm away carry a lot of energy (so they
 *    count towards the level and the peaks) but add nothing to intelligibility.
 *  - Presence: consonants live around 2-5kHz; lifting it is the standard fix for "muffled". Below
 *    GTCRN's 8kHz ceiling (it processes at 16kHz), so it still has something to work on.
 *  - Air: GTCRN processes at 16kHz, so nothing above 8kHz survives it — that missing band is
 *    the "muffled" no EQ can fix, since there's nothing up there left to boost. This regenerates
 *    a stand-in from what *is* there: the 3.5-8kHz band (where consonants' upper energy sits) is
 *    full-wave rectified, which creates harmonics up to roughly twice its frequencies, and only
 *    the part above 8kHz is mixed back in. Built from the processed signal, so it can't bring
 *    back any noise GTCRN removed, and |x| tracks its input's level, so pauses stay quiet. Not
 *    the real high band — a perceptual patch until the pipeline keeps the real one.
 *  - Compressor: speech has ~20dB between its average and its peaks; squeezing that is what lets
 *    the average come up without the peaks hitting 0dBFS — "louder at the same peak", which is
 *    most of why some apps sound louder than others at similar measured levels. Note the Web
 *    Audio compressor applies its own automatic makeup gain on top of `gainDb`.
 *  - Limiter: last line against clipping, since the stages above all add gain.
 *
 * Every stage but the leveler is a native Web Audio node; the leveler is a small AudioWorklet.
 * None of it does any per-sample work on the main thread. Call loadVoiceFinish() once per
 * context before constructing one.
 */

export function loadVoiceFinish(ctx: BaseAudioContext): Promise<void> {
  return ctx.audioWorklet.addModule(voiceLevelerWorkletUrl);
}

export type VoiceCompression = 'off' | 'light' | 'strong';

export interface VoiceFinishParams {
  lowCut: boolean;
  /** Peaking boost at PRESENCE_HZ, dB. 0 = flat. */
  presenceDb: number;
  compression: VoiceCompression;
  /** Extra gain after the compressor, dB. */
  gainDb: number;
  /** Synthesized above-8kHz band, 0 (off) to 10. */
  air: number;
  leveler: boolean;
  /** Speech level the leveler aims for, dBFS (mean power of speech, before the EQ/compressor). */
  levelerTargetDb: number;
  /** Most the leveler may boost, dB. */
  levelerMaxGainDb: number;
}

export const DEFAULT_VOICE_FINISH: VoiceFinishParams = {
  lowCut: true,
  presenceDb: 4,
  compression: 'light',
  gainDb: 0,
  air: 5,
  leveler: false,
  levelerTargetDb: -24,
  levelerMaxGainDb: 12,
};

/** Most the leveler may cut, dB — only ever needs to tame someone right on top of their mic. */
const LEVELER_MIN_GAIN_DB = -6;

const LOW_CUT_HZ = 90;
const PRESENCE_HZ = 3000;
const PRESENCE_Q = 0.9;
/** Bottom of the band the exciter derives its harmonics from. */
const AIR_SOURCE_HZ = 3500;
/** Only what lands above GTCRN's ceiling is mixed back in. */
const AIR_BAND_HZ = 8000;

/** air 1..10 -> mix gain, 2dB per step; 0 = off. Measured on synthesized speech, the
 *  above-8.5kHz share of the output comes to about -31dB (air 1), -24dB (5) and -15dB (10)
 *  relative to the whole signal; natural full-band speech sits somewhere around -20 to -30. */
const airGain = (air: number) => (air <= 0 ? 0 : 10 ** ((air * 2 - 20) / 20));

/** Two cascaded 2nd-order high-passes (24dB/oct), for a reasonably clean band edge. */
function highPass4(ctx: BaseAudioContext, hz: number): [BiquadFilterNode, BiquadFilterNode] {
  const a = ctx.createBiquadFilter();
  const b = ctx.createBiquadFilter();
  for (const f of [a, b]) {
    f.type = 'highpass';
    f.frequency.value = hz;
    f.Q.value = Math.SQRT1_2;
  }
  a.connect(b);
  return [a, b];
}

/** Full-wave rectifier, |x|. */
function rectifierCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
  return curve;
}

const COMPRESSION: Record<VoiceCompression, { threshold: number; ratio: number; knee: number }> = {
  // ratio 1 with a 0dB threshold is an identity (and its automatic makeup gain is 0dB).
  off: { threshold: 0, ratio: 1, knee: 0 },
  light: { threshold: -24, ratio: 2.5, knee: 10 },
  strong: { threshold: -30, ratio: 4, knee: 10 },
};

export class VoiceFinishChain {
  readonly input: AudioNode;
  readonly output: AudioNode;
  private readonly lowCut: BiquadFilterNode;
  private readonly presence: BiquadFilterNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly gain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly airNodes: AudioNode[];
  private readonly airMix: GainNode;
  private readonly leveler: AudioWorkletNode;
  private lastLevelerState: VoiceLevelerState | null = null;

  constructor(ctx: BaseAudioContext, params: VoiceFinishParams = DEFAULT_VOICE_FINISH) {
    this.leveler = new AudioWorkletNode(ctx, 'voice-leveler', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.leveler.port.onmessage = (event: MessageEvent<VoiceLevelerState>) => {
      this.lastLevelerState = event.data;
    };

    this.lowCut = ctx.createBiquadFilter();
    this.lowCut.type = 'highpass';
    this.lowCut.Q.value = Math.SQRT1_2;

    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.frequency.value = PRESENCE_HZ;
    this.presence.Q.value = PRESENCE_Q;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.15;

    this.gain = ctx.createGain();

    // Threshold and knee set explicitly: the defaults (-24dB, 30dB knee) would compress all of
    // normal speech rather than just catch peaks.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;

    const [airSourceIn, airSourceOut] = highPass4(ctx, AIR_SOURCE_HZ);
    const rectifier = ctx.createWaveShaper();
    rectifier.curve = rectifierCurve();
    // |x| has harmonics all the way up; oversampling keeps the ones past Nyquist from folding
    // back down into the audible band as aliasing.
    rectifier.oversample = '4x';
    const [airBandIn, airBandOut] = highPass4(ctx, AIR_BAND_HZ);
    this.airMix = ctx.createGain();
    airSourceOut.connect(rectifier);
    rectifier.connect(airBandIn);
    airBandOut.connect(this.airMix);
    this.airNodes = [airSourceIn, airSourceOut, rectifier, airBandIn, airBandOut, this.airMix];

    this.leveler.connect(this.lowCut);
    this.lowCut.connect(this.presence);
    this.presence.connect(this.compressor);
    this.presence.connect(airSourceIn);
    this.airMix.connect(this.compressor);
    this.compressor.connect(this.gain);
    this.gain.connect(this.limiter);
    this.input = this.leveler;
    this.output = this.limiter;
    this.apply(params);
  }

  /** Takes effect immediately; safe to call while audio is flowing. */
  apply(params: VoiceFinishParams) {
    // A 10Hz high-pass is inaudible: "off" without rewiring the graph.
    this.lowCut.frequency.value = params.lowCut ? LOW_CUT_HZ : 10;
    this.presence.gain.value = params.presenceDb;
    const c = COMPRESSION[params.compression];
    this.compressor.threshold.value = c.threshold;
    this.compressor.ratio.value = c.ratio;
    this.compressor.knee.value = c.knee;
    this.gain.gain.value = 10 ** (params.gainDb / 20);
    this.airMix.gain.value = airGain(params.air);
    const message: VoiceLevelerSettingsMessage = {
      type: 'settings',
      settings: {
        enabled: params.leveler,
        targetDb: params.levelerTargetDb,
        maxGainDb: params.levelerMaxGainDb,
        minGainDb: LEVELER_MIN_GAIN_DB,
      },
    };
    this.leveler.port.postMessage(message);
  }

  /** The leveler's latest gain / speech-level estimate (updated every ~100ms). */
  get levelerState(): VoiceLevelerState | null {
    return this.lastLevelerState;
  }

  disconnect() {
    this.leveler.port.onmessage = null;
    this.leveler.disconnect();
    this.lowCut.disconnect();
    this.presence.disconnect();
    this.compressor.disconnect();
    this.gain.disconnect();
    this.limiter.disconnect();
    for (const node of this.airNodes) node.disconnect();
  }
}
