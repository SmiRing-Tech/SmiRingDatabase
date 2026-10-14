import type { LocalVideoTrack } from 'livekit-client';
import { MediapipeBackgroundProcessor } from './MediapipeBackgroundProcessor';
import {
  supportsWorkerBackground,
  workerBackgroundDisabledReason,
  WorkerBackgroundProcessor,
  type WorkerBackgroundOptions,
} from './WorkerBackgroundProcessor';

/**
 * Which background processor the app builds. The worker pipeline (WorkerBackgroundProcessor) is
 * the default wherever it runs; the main-thread one covers Safari/Firefox, a page where the
 * workers already failed once, and anyone switched back by hand:
 *
 *   localStorage.setItem('smiring.debug.bgPipeline', 'main')   // per device, until removed
 */
export type BackgroundProcessor = MediapipeBackgroundProcessor | WorkerBackgroundProcessor;

const PIPELINE_KEY = 'smiring.debug.bgPipeline';

export function isBackgroundProcessor(value: unknown): value is BackgroundProcessor {
  return value instanceof MediapipeBackgroundProcessor || value instanceof WorkerBackgroundProcessor;
}

/** True when `processor` can change model in place, without a rebuild (and so without a blank). */
export function canSwapQualityInPlace(processor: BackgroundProcessor): processor is WorkerBackgroundProcessor {
  return processor instanceof WorkerBackgroundProcessor && processor.canSwapQuality;
}

/** True when the processor has broken and has to be rebuilt. */
export function isFailedProcessor(processor: BackgroundProcessor) {
  return processor instanceof WorkerBackgroundProcessor && processor.failed;
}

function forcedMainThread() {
  try {
    return localStorage.getItem(PIPELINE_KEY) === 'main';
  } catch {
    return false;
  }
}

export function backgroundPipeline(): 'worker' | 'main' {
  if (forcedMainThread() || workerBackgroundDisabledReason() || !supportsWorkerBackground()) return 'main';
  return 'worker';
}

export function createBackgroundProcessor(options: WorkerBackgroundOptions): BackgroundProcessor {
  return backgroundPipeline() === 'worker'
    ? new WorkerBackgroundProcessor(options)
    : new MediapipeBackgroundProcessor(options);
}

const isSafari = () => typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

/**
 * Takes the effect off the track. On Safari, also re-sets every attached <video>'s srcObject:
 * LiveKit puts the raw camera back by swapping the track *inside* the element's existing
 * MediaStream, and Safari keeps painting that element black until something forces a repaint
 * (switching tabs, toggling the camera) — LiveKit's own Safari workaround only runs when the
 * MediaStream object itself changes. https://developer.apple.com/forums/thread/690523
 */
export async function removeBackgroundProcessor(track: LocalVideoTrack) {
  if (!track.getProcessor()) return;
  await track.stopProcessor();
  if (!isSafari()) return;
  for (const element of track.attachedElements) {
    if (!(element instanceof HTMLVideoElement)) continue;
    const stream = element.srcObject;
    element.srcObject = null;
    element.srcObject = stream;
    void element.play().catch(() => {});
  }
}

/**
 * Changes the camera's capture settings (the load governor lowering or restoring resolution/fps).
 * Applied to the track LiveKit holds, and passed on to a worker processor that reads its own copy
 * of the camera (Safari), which wouldn't follow otherwise.
 */
export async function applyCaptureConstraints(track: LocalVideoTrack, constraints: MediaTrackConstraints) {
  await track.mediaStreamTrack.applyConstraints(constraints);
  const processor = track.getProcessor();
  if (processor instanceof WorkerBackgroundProcessor) processor.applySourceConstraints(constraints);
}
