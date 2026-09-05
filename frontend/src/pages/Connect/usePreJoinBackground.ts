import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import {
  MediapipeBackgroundProcessor,
  type EffectTarget,
  supportsMediapipeBackground,
  type SegmentationQuality,
} from '../../lib/video/MediapipeBackgroundProcessor';
import {
  useBackgroundLibrary,
  readStoredChoice,
  writeStoredChoice,
  type BackgroundMode,
} from './backgroundLibrary';
import type { BackgroundEffectState } from './useBackgroundEffect';

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
  const [quality, setQuality] = useState<SegmentationQuality>(stored.quality ?? 'balanced');
  const [target, setTarget] = useState<EffectTarget>(stored.target ?? 'background');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported);

  /**
   * Brings the track in line with the requested effect. Reuses the running
   * processor where it can — rebuilding one means reloading the segmentation
   * model, which is a visible stall (and a 16 MB download on the 'high' model).
   */
  const applyEffect = useCallback(
    async (
      nextMode: BackgroundMode,
      nextImageId: string | undefined,
      nextQuality: SegmentationQuality,
      nextTarget: EffectTarget,
    ) => {
      console.log('[PreJoin] applyEffect: called', {
        nextMode,
        nextQuality,
        currentProcessorName: track?.getProcessor()?.name,
        stack: new Error().stack,
      });
      if (!track) return;

      if (nextMode === 'off') {
        if (track.getProcessor()) await track.stopProcessor();
        processorRef.current = null;
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

      if (isAttached && qualityMatches) {
        processorRef.current = current;
        // Only the model is baked in at construction time; everything else can be
        // swapped on the running processor, which avoids a reload stall.
        current!.updateOptions({ target: nextTarget });
        await current!.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        return;
      }

      const processor = new MediapipeBackgroundProcessor({
        quality: nextQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
        target: nextTarget,
        imageUrl: imageUrl ?? null,
        blurRadius: 14,
        temporalSmoothing: 0.45,
        edgeFeather: 4,
      });
      if (track.getProcessor()) await track.stopProcessor();
      await track.setProcessor(processor);
      processorRef.current = processor;
    },
    [track, imageUrlFor],
  );

  const commit = useCallback(
    async (next: {
      mode?: BackgroundMode;
      imageId?: string;
      quality?: SegmentationQuality;
      target?: EffectTarget;
    }) => {
      const nextMode = next.mode ?? mode;
      const nextImageId = 'imageId' in next ? next.imageId : imageId;
      const nextQuality = next.quality ?? quality;
      const nextTarget = next.target ?? target;

      setBusy(true);
      setError('');
      try {
        // Save first: the preview is a nicety, the stored choice is the point, and
        // it should stick even where the preview cannot run.
        writeStoredChoice({
          mode: nextMode,
          imageId: nextImageId,
          quality: nextQuality,
          target: nextTarget,
        });
        setMode(nextMode);
        setImageId(nextImageId);
        setQuality(nextQuality);
        setTarget(nextTarget);
        await applyEffect(nextMode, nextImageId, nextQuality, nextTarget);
      } catch (e) {
        console.error('[PreJoin] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId, quality, target],
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
    if (!supported || !track || mode === 'off') return;
    if (mode === 'image' && imageId && !imageUrlFor(imageId)) return;
    if (restoredRef.current) return;
    restoredRef.current = true;
    void applyEffect(mode, imageId, quality, target).catch((e) =>
      console.error('[PreJoin] failed to restore background effect:', e),
    );
  }, [supported, track, applyEffect, imageUrlFor, mode, imageId, quality, target]);

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError('');
      try {
        const uploaded = await uploadBackground(file);
        // Select it immediately — uploading a background and not using it is not a thing.
        await applyEffect('image', uploaded.id, quality, target);
        setMode('image');
        setImageId(uploaded.id);
        writeStoredChoice({ mode: 'image', imageId: uploaded.id, quality, target });
      } catch (e) {
        console.error('[PreJoin] background upload failed:', e);
        setError(e instanceof Error ? e.message : 'アップロードに失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, uploadBackground, quality, target],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError('');
      try {
        await deleteBackground(id);
        // Deleting the background currently on screen leaves nothing to show.
        if (imageId === id) {
          await applyEffect('blur', undefined, quality, target);
          setMode('blur');
          setImageId(undefined);
          writeStoredChoice({ mode: 'blur', quality, target });
        }
      } catch (e) {
        console.error('[PreJoin] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, deleteBackground, imageId, quality, target],
  );

  const state: BackgroundEffectState = {
    supported,
    mode,
    imageId,
    quality,
    target,
    uploads,
    busy,
    error,
    commit,
    handleUpload,
    handleDelete,
    imageUrlFor,
  };

  return { state };
}
