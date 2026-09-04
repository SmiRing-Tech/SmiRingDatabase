import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
 * LiveKit's <PreJoin> takes a `videoProcessor`, so the effect can run on the
 * preview it already owns — no second camera, and what you see before joining is
 * the same pipeline that will run in the call.
 *
 * One processor instance is kept alive and mutated in place. LiveKit decides
 * whether to rebuild the preview tracks by serialising the processor down to its
 * `name`, so handing it a different instance with the same name would be ignored;
 * the name carries the model for exactly that reason, which means only a quality
 * change costs a rebuild.
 *
 * Choices are written to localStorage as they are made, which is what the call
 * reads on join — so this screen configures the call, it does not just preview it.
 */
export function usePreJoinBackground() {
  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  const [quality, setQuality] = useState<SegmentationQuality>(stored.quality ?? 'balanced');
  const [target, setTarget] = useState<EffectTarget>(stored.target ?? 'background');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Held in state, not a ref: <PreJoin> has to re-render when it changes.
  const [processor, setProcessor] = useState<MediapipeBackgroundProcessor | null>(null);
  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported);

  useEffect(
    () => () => {
      // PreJoin stops the tracks; the processor's own resources are ours to free.
      void processorRef.current?.destroy().catch(() => {});
      processorRef.current = null;
    },
    [],
  );

  /**
   * Reconciles the live processor with the requested settings, reusing the
   * instance whenever the model is unchanged.
   */
  const syncProcessor = useCallback(
    async (
      nextMode: BackgroundMode,
      nextImageId: string | undefined,
      nextQuality: SegmentationQuality,
      nextTarget: EffectTarget,
    ) => {
      if (!supported || nextMode === 'off') {
        const previous = processorRef.current;
        processorRef.current = null;
        setProcessor(null);
        // PreJoin drops it from the track first; destroying after that is safe.
        if (previous) await previous.destroy().catch(() => {});
        return;
      }

      const imageUrl = nextMode === 'image' ? imageUrlFor(nextImageId) : undefined;
      if (nextMode === 'image' && !imageUrl) {
        throw new Error('選択した背景画像が見つかりませんでした。');
      }

      const current = processorRef.current;
      if (current && current.quality === nextQuality) {
        current.updateOptions({ target: nextTarget });
        await current.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        return;
      }

      const next = new MediapipeBackgroundProcessor({
        quality: nextQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
        target: nextTarget,
        imageUrl: imageUrl ?? null,
        blurRadius: 14,
        temporalSmoothing: 0.45,
        edgeFeather: 4,
      });
      processorRef.current = next;
      setProcessor(next);
      if (current) await current.destroy().catch(() => {});
    },
    [supported, imageUrlFor],
  );

  // Restore the saved effect once the image library is ready — an uploaded
  // background cannot be resolved to a URL before its blob has been fetched.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!supported || restoredRef.current || mode === 'off') return;
    if (mode === 'image' && imageId && !imageUrlFor(imageId)) return;
    restoredRef.current = true;
    void syncProcessor(mode, imageId, quality, target).catch((e) =>
      console.error('[PreJoin] failed to restore background effect:', e),
    );
  }, [supported, syncProcessor, imageUrlFor, mode, imageId, quality, target]);

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
        await syncProcessor(nextMode, nextImageId, nextQuality, nextTarget);
      } catch (e) {
        console.error('[PreJoin] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [syncProcessor, mode, imageId, quality, target],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      setBusy(true);
      setError('');
      try {
        const uploaded = await uploadBackground(file);
        writeStoredChoice({ mode: 'image', imageId: uploaded.id, quality, target });
        setMode('image');
        setImageId(uploaded.id);
        await syncProcessor('image', uploaded.id, quality, target);
      } catch (e) {
        console.error('[PreJoin] background upload failed:', e);
        setError(e instanceof Error ? e.message : 'アップロードに失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [syncProcessor, uploadBackground, quality, target],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError('');
      try {
        await deleteBackground(id);
        if (imageId === id) {
          writeStoredChoice({ mode: 'blur', quality, target });
          setMode('blur');
          setImageId(undefined);
          await syncProcessor('blur', undefined, quality, target);
        }
      } catch (e) {
        console.error('[PreJoin] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [syncProcessor, deleteBackground, imageId, quality, target],
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

  return { state, processor };
}
