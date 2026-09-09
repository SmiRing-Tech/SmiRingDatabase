import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import {
  MediapipeBackgroundProcessor,
  supportsMediapipeBackground,
  type SegmentationQuality,
} from '../../lib/video/MediapipeBackgroundProcessor';
import {
  useBackgroundLibrary,
  readStoredChoice,
  writeStoredChoice,
  detectSegmentationQuality,
  type BackgroundMode,
} from './backgroundLibrary';
import type { BackgroundEffectState } from './useBackgroundEffect';

function hookLog(msg: string, data?: Record<string, unknown>) {
  const t = typeof performance !== 'undefined' ? performance.now().toFixed(0) : '?';
  console.log(`[usePreJoinBackground t=${t}ms] ${msg}`, data ?? '');
}

/**
 * The background picker for the pre-join screen.
 *
 * Applies the effect directly to the caller's own `LocalVideoTrack` (the same track
 * that will later be published for the call — see `PreJoinScreen`), via
 * `track.setProcessor()`. This mirrors `useBackgroundEffect`'s `applyEffect` almost
 * exactly; the two will merge once the in-call track is also just "the pre-join
 * track, kept alive" rather than a separately-created one.
 *
 * Choices are written to localStorage as they are made, which is what the call
 * reads on join — so this screen configures the call, it does not just preview it.
 */
export function usePreJoinBackground(track: LocalVideoTrack | null) {
  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  // Starts at whatever the track already has attached, so a remount doesn't
  // rebuild a processor at a different quality than what's already running.
  // Otherwise: the stored manual override, or a fresh capability-based guess —
  // see detectSegmentationQuality(). There is no runtime upgrade path anymore
  // (see MediapipeBackgroundProcessor.init()'s comment for why); quality is
  // decided once, before the only processor this screen builds exists.
  const [quality, setQualityState] = useState<SegmentationQuality>(() => {
    const existing = track?.getProcessor();
    if (existing instanceof MediapipeBackgroundProcessor) return existing.quality;
    return stored.quality ?? detectSegmentationQuality();
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // When a background effect is stored, keep isReady false until the processor
  // is attached so the raw room is never visible.
  const [isReady, setIsReady] = useState(() => {
    const initial = stored.mode === 'off';
    hookLog('isReady initial state', { initial, storedMode: stored.mode });
    return initial;
  });

  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported);

  /**
   * Brings the track in line with the requested effect. Reuses the running
   * processor where it can — rebuilding one means reloading the segmentation
   * model, which is a visible stall (and a 16 MB download on the 'high' model).
   */
  const applyEffect = useCallback(
    async (nextMode: BackgroundMode, nextImageId: string | undefined, nextQuality: SegmentationQuality) => {
      hookLog('applyEffect() called', { nextMode, nextImageId, nextQuality, hasTrack: !!track });
      if (!track) return;

      if (nextMode === 'off') {
        if (track.getProcessor()) await track.stopProcessor();
        processorRef.current = null;
        hookLog('applyEffect() mode=off, isReady=true immediately');
        setIsReady(true);
        return;
      }

      const imageUrl = nextMode === 'image' ? imageUrlFor(nextImageId) : undefined;
      if (nextMode === 'image' && !imageUrl) {
        throw new Error('選択した背景画像が見つかりませんでした。');
      }

      // Ask the track itself rather than trusting processorRef alone, and adopt
      // a match — otherwise a second caller (or a StrictMode-doubled effect) that
      // doesn't recognize the ref rebuilds a working processor from scratch,
      // tearing down its WebGL context / segmentation pipeline mid-flight.
      const existingOnTrack = track.getProcessor();
      const current =
        existingOnTrack instanceof MediapipeBackgroundProcessor ? existingOnTrack : processorRef.current;
      const isAttached = !!current && track.getProcessor() === current;
      const qualityMatches = current?.quality === nextQuality;
      hookLog('applyEffect() decision', { isAttached, qualityMatches, currentQuality: current?.quality });

      if (isAttached && qualityMatches) {
        processorRef.current = current;
        await current!.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        // setBackground() only swaps which image/blur is composited; it does not
        // mean the *next* composited frame is out yet, let alone verified (matte
        // polarity, temporal smoothing) — wait for the processor to confirm its
        // own output before telling the caller it's safe to show.
        await current!.waitUntilReady();
        hookLog('applyEffect() reuse path done, isReady=true');
        setIsReady(true);
        return;
      }

      // A different quality (only reachable via the manual toggle now — see
      // BackgroundControls) means a whole new processor, which means a new
      // segmenter load. Only one segmenter may be alive at a time (see
      // MediapipeBackgroundProcessor.init()'s doc comment), so the old one has
      // to be torn down first — block the preview for that gap instead of
      // flashing the viewer's real, un-blurred background.
      // Don't rely on isReady already being false here — assert it. A brand
      // new processor is about to be built and is not yet proven stable.
      hookLog('applyEffect() building a new processor, isReady=false', {
        hadExistingProcessor: !!track.getProcessor(),
      });
      setIsReady(false);
      if (track.getProcessor()) await track.stopProcessor();

      const processor = new MediapipeBackgroundProcessor({
        quality: nextQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
        imageUrl: imageUrl ?? null,
        blurRadius: 16,
        temporalSmoothing: 0.25,
        edgeFeather: 1.5,
        matteLo: 0.3,
        matteHi: 0.75,
      });
      hookLog('applyEffect() calling track.setProcessor()');
      const tSetProcessor = performance.now();
      await track.setProcessor(processor);
      hookLog('applyEffect() track.setProcessor() resolved', {
        ms: Math.round(performance.now() - tSetProcessor),
      });
      processorRef.current = processor;
      // setProcessor() resolves once the model is loaded and the pipeline is
      // wired, not once its output has been verified — see waitUntilReady().
      const tWait = performance.now();
      await processor.waitUntilReady();
      hookLog('applyEffect() waitUntilReady() resolved, isReady=true NOW', {
        ms: Math.round(performance.now() - tWait),
      });
      setIsReady(true);
    },
    [track, imageUrlFor],
  );

  const commit = useCallback(
    async (next: { mode?: BackgroundMode; imageId?: string }) => {
      const nextMode = next.mode ?? mode;
      const nextImageId = 'imageId' in next ? next.imageId : imageId;

      setBusy(true);
      setError('');
      try {
        // Save first: the preview is a nicety, the stored choice is the point, and
        // it should stick even where the preview cannot run.
        writeStoredChoice({ mode: nextMode, imageId: nextImageId, quality });
        setMode(nextMode);
        setImageId(nextImageId);
        await applyEffect(nextMode, nextImageId, quality);
      } catch (e) {
        console.error('[PreJoin] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : 'エフェクトの適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, imageId, mode, quality],
  );

  /** The manual Balanced/High toggle — see BackgroundControls. */
  const setQuality = useCallback(
    async (nextQuality: SegmentationQuality) => {
      setBusy(true);
      setError('');
      try {
        writeStoredChoice({ mode, imageId, quality: nextQuality });
        setQualityState(nextQuality);
        await applyEffect(mode, imageId, nextQuality);
      } catch (e) {
        console.error('[PreJoin] failed to change segmentation quality:', e);
        setError(e instanceof Error ? e.message : '画質の変更に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId],
  );

  // The track may not exist yet on first render (still being created), or may be
  // replaced (device switch) — (re-)apply the stored effect whenever it shows up.
  //
  // Guard is `restoredRef.current` alone, checked and set synchronously — NOT
  // `track.getProcessor()`, which stays null until the asynchronous `applyEffect`
  // below actually finishes. In React's StrictMode dev double-invoke (mount ->
  // cleanup -> mount again), the second invocation runs before the first
  // `applyEffect` call has resolved; gating on `getProcessor()` let both
  // invocations through, each building its own MediapipeBackgroundProcessor and
  // racing to `setProcessor()` — the first one's WebGL context and pipeline gets
  // torn down mid-flight, which is why the effect only sometimes actually worked.
  const restoredRef = useRef(false);
  useEffect(() => {
    hookLog('restore effect fired', {
      supported,
      hasTrack: !!track,
      mode,
      imageId,
      alreadyRestored: restoredRef.current,
    });
    if (!supported || mode === 'off') {
      // Genuinely nothing to wait for: no background effect will ever be
      // applied, so there is no reason to keep the preview blocked.
      hookLog('restore effect: nothing to apply, isReady=true', { supported, mode });
      setIsReady(true);
      return;
    }
    if (!track) {
      // Camera/mic permission hasn't resolved yet — leave isReady at whatever
      // it already is (false, from the initial state) and wait for track to
      // show up. Treating "no track yet" the same as "mode is off" here used
      // to set isReady=true before the camera even existed; by the time the
      // track appeared a few hundred ms later, isReady was already stuck true
      // from this branch, so PreJoinScreen's `ready` gate — which only checks
      // `!videoTrack || isBackgroundReady` — passed immediately and revealed
      // the raw, un-blurred camera the instant permission was granted, with
      // the real effect only catching up ~1-2s later. See the console trace
      // from 2026-09-09 for the exact repro.
      hookLog('restore effect: no track yet, waiting (isReady untouched)');
      return;
    }
    if (mode === 'image' && imageId && !imageUrlFor(imageId)) {
      hookLog('restore effect: image not loaded yet, waiting for library');
      return;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;

    hookLog('restore effect: calling applyEffect (initial, one-shot)', { quality });
    void applyEffect(mode, imageId, quality).catch((e) => {
      console.error('[PreJoin] failed to restore background effect:', e);
      hookLog('restore effect: applyEffect FAILED, isReady=true', { err: String(e) });
      setIsReady(true);
    });
  }, [supported, track, applyEffect, imageUrlFor, mode, imageId, quality]);

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError('');
      try {
        const uploaded = await uploadBackground(file);
        // Select it immediately — uploading a background and not using it is not a thing.
        await applyEffect('image', uploaded.id, quality);
        setMode('image');
        setImageId(uploaded.id);
        writeStoredChoice({ mode: 'image', imageId: uploaded.id, quality });
      } catch (e) {
        console.error('[PreJoin] background upload failed:', e);
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
          await applyEffect('blur', undefined, quality);
          setMode('blur');
          setImageId(undefined);
          writeStoredChoice({ mode: 'blur', quality });
        }
      } catch (e) {
        console.error('[PreJoin] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, deleteBackground, imageId, quality],
  );

  const state: BackgroundEffectState = {
    supported,
    mode,
    imageId,
    quality,
    uploads,
    busy,
    error,
    commit,
    setQuality,
    handleUpload,
    handleDelete,
    imageUrlFor,
  };

  return { state, isReady };
}
