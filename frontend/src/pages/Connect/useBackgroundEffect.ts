import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { ParticipantEvent, Track, type LocalVideoTrack } from 'livekit-client';
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
export function useBackgroundEffect() {
  const { localParticipant } = useLocalParticipant();
  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);

  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  const [quality, setQuality] = useState<SegmentationQuality>(stored.quality ?? 'balanced');
  const [target, setTarget] = useState<EffectTarget>(stored.target ?? 'background');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { uploads, imageUrlFor, uploadBackground, deleteBackground } =
    useBackgroundLibrary(supported);

  const getCameraTrack = useCallback(() => {
    const publication = localParticipant.getTrackPublication(Track.Source.Camera);
    return publication?.track as LocalVideoTrack | undefined;
  }, [localParticipant]);

  /**
   * Brings the camera track in line with the requested effect. Reuses the running
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
      const track = getCameraTrack();
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

      // Don't trust processorRef alone: the track may already be carrying a
      // processor this hook instance didn't create (e.g. the one PreJoinScreen
      // attached before publish — see usePreJoinBackground). Ask the track
      // itself, and adopt a match into processorRef rather than treating "not
      // mine" as "not attached" and rebuilding — that raced the pre-join
      // processor's own setProcessor() call and intermittently tore down its
      // WebGL context / segmentation pipeline mid-flight.
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
    [getCameraTrack, imageUrlFor],
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
        await applyEffect(nextMode, nextImageId, nextQuality, nextTarget);
        setMode(nextMode);
        setImageId(nextImageId);
        setQuality(nextQuality);
        setTarget(nextTarget);
        writeStoredChoice({
          mode: nextMode,
          imageId: nextImageId,
          quality: nextQuality,
          target: nextTarget,
        });
      } catch (e) {
        console.error('[Connect] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId, quality, target],
  );

  // The camera track may be published after this mounts (joined with the camera
  // off, or switched devices), so re-apply whenever a new one shows up.
  useEffect(() => {
    if (!supported || mode === 'off') return;

    const reapply = () => {
      void applyEffect(mode, imageId, quality, target).catch((e) =>
        console.error('[Connect] failed to re-apply background effect:', e),
      );
    };

    reapply();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, reapply);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, reapply);
    };
  }, [supported, localParticipant, applyEffect, mode, imageId, quality, target]);

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
        console.error('[Connect] background upload failed:', e);
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
        console.error('[Connect] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, deleteBackground, imageId, quality, target],
  );

  return {
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
}

export type BackgroundEffectState = ReturnType<typeof useBackgroundEffect>;
