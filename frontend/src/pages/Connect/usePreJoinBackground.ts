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
  isMobileDevice,
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
  // Starts at whatever the track already has attached, so a remount doesn't
  // ping-pong a previously-upgraded processor back down to 'balanced'. See the
  // auto-upgrade in the restore effect below for how it gets to 'high' at all.
  const [quality, setQuality] = useState<SegmentationQuality>(() => {
    const existing = track?.getProcessor();
    return existing instanceof MediapipeBackgroundProcessor ? existing.quality : 'balanced';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // When a background effect is stored, keep isReady false until the processor
  // is attached so the raw room is never visible.
  const [isReady, setIsReady] = useState(() => stored.mode === 'off');

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
      if (!track) return;

      if (nextMode === 'off') {
        if (track.getProcessor()) await track.stopProcessor();
        processorRef.current = null;
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

      if (isAttached && qualityMatches) {
        processorRef.current = current;
        await current!.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        setIsReady(true);
        return;
      }

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
      if (track.getProcessor()) await track.stopProcessor();
      await track.setProcessor(processor);
      processorRef.current = processor;
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
        writeStoredChoice({ mode: nextMode, imageId: nextImageId });
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

  // The track may not exist yet on first render (still being created), or may be
  // replaced (device switch) — (re-)apply the stored effect whenever it shows up.
  // Once that succeeds, also try upgrading a fresh 'balanced' processor up to
  // 'high' — skipped on mobile (see isMobileDevice) — so people see the effect
  // instantly and only pay for the bigger model in the background.
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
    if (!supported || !track || mode === 'off') {
      setIsReady(true);
      return;
    }
    if (mode === 'image' && imageId && !imageUrlFor(imageId)) return;
    if (restoredRef.current) return;
    restoredRef.current = true;

    // Apply balanced first so camera unblocks fast with effect active,
    // then silently upgrade to high model on desktop.
    void applyEffect(mode, imageId, 'balanced')
      .then(() => {
        setIsReady(true);
        if (!isMobileDevice()) {
          return applyEffect(mode, imageId, 'high').then(() => setQuality('high'));
        }
      })
      .catch((e) => {
        console.error('[PreJoin] failed to restore background effect:', e);
        setIsReady(true);
      });
  }, [supported, track, applyEffect, imageUrlFor, mode, imageId]);

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
        writeStoredChoice({ mode: 'image', imageId: uploaded.id });
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
          writeStoredChoice({ mode: 'blur' });
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
    handleUpload,
    handleDelete,
    imageUrlFor,
  };

  return { state, isReady };
}
