import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track } from 'livekit-client';
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
 * The same background picker, for the pre-join screen.
 *
 * There is no Room here — LiveKit's <PreJoin> owns its own preview and does not
 * hand the track out — so this opens a second camera stream of its own and runs
 * the processor on that. Browsers hand out a second track from an already-open
 * camera without complaint, and it only lives while the dialog is open.
 *
 * It writes the same localStorage entry the in-call hook reads, which is what
 * makes a choice made here take effect once the call actually starts.
 */
export function usePreviewBackgroundEffect(active: boolean) {
  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  const [quality, setQuality] = useState<SegmentationQuality>(stored.quality ?? 'balanced');
  const [target, setTarget] = useState<EffectTarget>(stored.target ?? 'background');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported && active);

  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const teardown = useCallback(async () => {
    const processor = processorRef.current;
    processorRef.current = null;
    if (processor) await processor.destroy().catch(() => {});
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    setPreviewStream(null);
  }, []);

  /**
   * Rebuilds the preview for the given settings. Unlike the in-call path there is
   * no published track to preserve, so this always constructs a fresh processor —
   * simpler, and a stall in a preview costs nothing.
   */
  const applyToPreview = useCallback(
    async (
      nextMode: BackgroundMode,
      nextImageId: string | undefined,
      nextQuality: SegmentationQuality,
      nextTarget: EffectTarget,
    ) => {
      const cameraTrack = cameraStreamRef.current?.getVideoTracks()[0];
      if (!cameraTrack) return;

      const previous = processorRef.current;
      processorRef.current = null;
      if (previous) await previous.destroy().catch(() => {});

      if (nextMode === 'off') {
        setPreviewStream(new MediaStream([cameraTrack]));
        return;
      }

      const imageUrl = nextMode === 'image' ? imageUrlFor(nextImageId) : undefined;
      if (nextMode === 'image' && !imageUrl) {
        throw new Error('選択した背景画像が見つかりませんでした。');
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
      await processor.init({ kind: Track.Kind.Video, track: cameraTrack });
      processorRef.current = processor;

      const processed = processor.processedTrack;
      setPreviewStream(processed ? new MediaStream([processed]) : new MediaStream([cameraTrack]));
    },
    [imageUrlFor],
  );

  // Open the camera while the dialog is up, and hand it back as soon as it closes.
  useEffect(() => {
    if (!active || !supported) {
      void teardown();
      return;
    }

    let cancelled = false;
    setBusy(true);
    setError('');

    (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false,
      });
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      cameraStreamRef.current = stream;
      setPreviewStream(stream);
      await applyToPreview(mode, imageId, quality, target);
    })()
      .catch((e) => {
        console.error('[PreJoin] preview failed:', e);
        if (!cancelled) {
          setError(
            e instanceof Error && e.name === 'NotReadableError'
              ? 'カメラを開けませんでした。他のアプリが使用中かもしれません。'
              : 'プレビューを開始できませんでした。設定の保存はできます。',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
      void teardown();
    };
    // Only the open/close transition should re-open the camera; setting changes
    // are handled by commit() below, which reuses the stream already open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, supported]);

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
        // it should stick even on a machine where the preview cannot run.
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
        await applyToPreview(nextMode, nextImageId, nextQuality, nextTarget);
      } catch (e) {
        console.error('[PreJoin] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyToPreview, mode, imageId, quality, target],
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
        await applyToPreview('image', uploaded.id, quality, target);
      } catch (e) {
        console.error('[PreJoin] background upload failed:', e);
        setError(e instanceof Error ? e.message : 'アップロードに失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyToPreview, uploadBackground, quality, target],
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
          await applyToPreview('blur', undefined, quality, target);
        }
      } catch (e) {
        console.error('[PreJoin] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyToPreview, deleteBackground, imageId, quality, target],
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

  return { state, previewStream };
}
