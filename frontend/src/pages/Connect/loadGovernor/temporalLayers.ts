import type { LocalVideoTrack } from 'livekit-client';
import { recordTelemetry } from '../../../lib/connectTelemetry';

/**
 * Gives an Android phone's camera stream temporal layers (VP8 L1T3), so a receiver the governor
 * has judged overloaded can ask the SFU for fewer of its frames (receiveFpsController.ts).
 *
 * PC Chrome already sends L1T3 on every simulcast layer by default; a phone publishes a single
 * layer, and a single layer defaults to L1T1. iPhones (WebKit) don't take it at all — measured on
 * /dev/temporal-lab: Android Chrome accepted L1T3 and kept its hardware encoder
 * (c2.exynos.vp8.encoder, same ~9ms/frame); iPhone Safari and Chrome stayed L1T1.
 *
 * Safety: a hardware encoder that can't do temporal layers makes Chrome fall back to software
 * (libvpx), which would cost the phone CPU for other people's benefit. So a few seconds after
 * setting it, the outbound stats are checked: hardware before but not after -> back to L1T1, and
 * not tried again on this device for the rest of the page's life.
 */

const VERIFY_AFTER_MS = 4000;

type SenderState =
  | { phase: 'applied'; at: number; wasHardware: boolean }
  | { phase: 'done' };

const senders = new WeakMap<RTCRtpSender, SenderState>();
let givenUp = false;

export function wantsTemporalLayers() {
  const ua = navigator.userAgent;
  return /Android/.test(ua) && /Chrome\//.test(ua) && !/Firefox/.test(ua);
}

interface EncoderInfo {
  frames: number;
  mode?: string;
  hardware: boolean;
  implementation?: string;
}

async function encoderInfo(sender: RTCRtpSender): Promise<EncoderInfo | null> {
  let info: EncoderInfo | null = null;
  (await sender.getStats()).forEach((stat) => {
    if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') return;
    const implementation = typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation : undefined;
    info = {
      frames: stat.framesEncoded ?? 0,
      mode: stat.scalabilityMode,
      hardware: stat.powerEfficientEncoder === true || /Accelerator|MediaCodec/i.test(implementation ?? ''),
      implementation,
    };
  });
  return info;
}

async function setMode(sender: RTCRtpSender, mode: 'L1T3' | 'L1T1') {
  const params = sender.getParameters();
  if (params.encodings.length !== 1) return false;
  (params.encodings[0] as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode = mode;
  await sender.setParameters(params);
  return true;
}

/** Called every governor sample with the current camera track; idempotent. */
export async function keepTemporalLayers(track: LocalVideoTrack | undefined) {
  if (givenUp || !track || !wantsTemporalLayers()) return;
  // VP8 only: that's what was measured, and the SFU can't tell H.264's layers apart anyway.
  if (track.codec && track.codec !== 'vp8') return;
  const sender = track.sender;
  if (!sender) return;
  const state = senders.get(sender);
  if (state?.phase === 'done') return;
  try {
    const info = await encoderInfo(sender);
    if (!info || info.frames === 0) return; // not encoding yet
    if (!state) {
      if (info.mode === 'L1T3') {
        senders.set(sender, { phase: 'done' });
        return;
      }
      if (await setMode(sender, 'L1T3')) {
        senders.set(sender, { phase: 'applied', at: performance.now(), wasHardware: info.hardware });
      } else {
        senders.set(sender, { phase: 'done' });
      }
      return;
    }
    if (performance.now() - state.at < VERIFY_AFTER_MS) return;
    senders.set(sender, { phase: 'done' });
    if (state.wasHardware && !info.hardware) {
      givenUp = true;
      await setMode(sender, 'L1T1');
      recordTelemetry('temporal-layers', { result: 'reverted-software-encoder', encoder: info.implementation });
      return;
    }
    recordTelemetry('temporal-layers', {
      result: info.mode === 'L1T3' ? 'ok' : 'not-accepted',
      mode: info.mode,
      encoder: info.implementation,
    });
  } catch (err) {
    // setParameters can refuse while the encoder is being reconfigured; next sample retries.
    if (!state) return;
    console.warn('[governor] temporal layers check failed:', err);
  }
}
