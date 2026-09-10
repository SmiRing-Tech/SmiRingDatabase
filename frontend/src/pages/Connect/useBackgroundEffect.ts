import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { ParticipantEvent, Track, type LocalVideoTrack } from 'livekit-client';
import {
  MediapipeBackgroundProcessor,
  supportsMediapipeBackground,
  type SegmentationQuality,
} from '../../lib/video/MediapipeBackgroundProcessor';
import { BlankFrameProcessor } from '../../lib/video/BlankFrameProcessor';
import {
  useBackgroundLibrary,
  readStoredChoice,
  writeStoredChoice,
  detectSegmentationQuality,
  detectSegmentationFps,
  isMobileDevice,
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
  // Guards the automatic high -> balanced fallback (see handlePerfDowngrade) so
  // it fires at most once per "high" attempt; setQuality resets it whenever the
  // user picks 'high' again themselves, so a later attempt gets its own chance.
  const autoDowngradedRef = useRef(false);
  // Same idea, opposite direction — see handlePerfUpgrade.
  const autoUpgradedRef = useRef(false);
  // setQuality closes over applyEffect, and handlePerfDowngrade needs to call
  // setQuality — but handlePerfDowngrade is handed to applyEffect as a
  // constructor option, so it has to exist before setQuality does. A ref sidesteps
  // the circular dependency: handlePerfDowngrade is only ever invoked later, from
  // inside a running processor, well after this effect has populated it.
  const setQualityRef = useRef<((q: SegmentationQuality) => Promise<boolean>) | undefined>(undefined);

  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  // Starts at whatever the track already has attached (e.g. PreJoin already
  // picked a quality before publish) so this hook doesn't rebuild the
  // processor at a different quality the moment it takes over. Otherwise the
  // stored manual override, or a fresh capability-based guess — see
  // detectSegmentationQuality(). There is no runtime upgrade path (see
  // MediapipeBackgroundProcessor.init()'s doc comment for why not: only one
  // segmenter may be alive at a time).
  const [quality, setQualityState] = useState<SegmentationQuality>(() => {
    const publication = localParticipant.getTrackPublication(Track.Source.Camera);
    const existing = (publication?.track as LocalVideoTrack | undefined)?.getProcessor();
    if (existing instanceof MediapipeBackgroundProcessor) return existing.quality;
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
   * Wired into the 'high'-quality processor as onSustainedSlowFrames: fires
   * once its own per-frame cost has averaged above a stutter-level threshold
   * for a few seconds straight. Falls back to 'balanced' the same way the
   * manual HD toggle does (see setQuality) rather than duplicating the
   * processor-swap logic here.
   */
  const handlePerfDowngrade = useCallback(() => {
    if (autoDowngradedRef.current) return;
    autoDowngradedRef.current = true;
    console.warn('[Connect] background effect running slow, falling back to balanced quality');
    void setQualityRef.current?.('balanced').then((ok) => {
      if (ok) setError('処理が重かったため、背景エフェクトを標準画質に切り替えました。');
    });
  }, []);

  /**
   * Wired into the 'balanced'-quality processor as onSustainedFastFrames: fires once
   * it's had comfortable headroom for a while, and tries 'high' the same way the
   * manual HD toggle does. Desktop only — mobile always forces 'balanced' regardless
   * of measured performance (see detectSegmentationQuality), so there's nothing to
   * try upgrading to there.
   */
  const handlePerfUpgrade = useCallback(() => {
    if (autoUpgradedRef.current || isMobileDevice()) return;
    autoUpgradedRef.current = true;
    console.info('[Connect] background effect has headroom, trying high quality');
    void setQualityRef.current?.('high').then((ok) => {
      if (ok) setError('処理に余裕があるため、背景エフェクトを高精細画質に切り替えました。');
    });
  }, []);

  /**
   * Brings the camera track in line with the requested effect. Reuses the running
   * processor where it can — rebuilding one means reloading the segmentation
   * model, which is a visible stall (and a 16 MB download on the 'high' model).
   */
  const applyEffect = useCallback(
    async (nextMode: BackgroundMode, nextImageId: string | undefined, nextQuality: SegmentationQuality) => {
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
        await current!.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        return;
      }

      // Different quality means a whole new processor, which means a new
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

      const processor = new MediapipeBackgroundProcessor({
        quality: nextQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
        imageUrl: imageUrl ?? null,
        blurRadius: 16,
        temporalSmoothing: 0.25,
        edgeFeather: 1.5,
        matteLo: 0.3,
        matteHi: 0.75,
        segmentationFps: detectSegmentationFps(),
        // Only 'high' has anywhere lighter to fall back to, and only 'balanced' has
        // anywhere heavier to try — never both on the same processor.
        onSustainedSlowFrames: nextQuality === 'high' ? handlePerfDowngrade : undefined,
        onSustainedFastFrames: nextQuality === 'balanced' ? handlePerfUpgrade : undefined,
      });
      // setProcessor() resolves once the model is loaded and the pipeline is wired,
      // not once its output is stable — the processor blanks its own output until
      // then (see its renderFrame()), so the blank bridge above stays effectively in
      // place, just handed off to the real processor's own blanking, until this
      // resolves.
      await track.setProcessor(processor);
      await processor.waitUntilReady();
      processorRef.current = processor;
    },
    [getCameraTrack, imageUrlFor, handlePerfDowngrade, handlePerfUpgrade],
  );

  const commit = useCallback(
    async (next: { mode?: BackgroundMode; imageId?: string }) => {
      const nextMode = next.mode ?? mode;
      const nextImageId = 'imageId' in next ? next.imageId : imageId;

      setBusy(true);
      setError('');
      try {
        await applyEffect(nextMode, nextImageId, quality);
        setMode(nextMode);
        setImageId(nextImageId);
        writeStoredChoice({ mode: nextMode, imageId: nextImageId, quality });
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
        await applyEffect('image', uploaded.id, quality);
        setMode('image');
        setImageId(uploaded.id);
        writeStoredChoice({ mode: 'image', imageId: uploaded.id, quality });
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
          await applyEffect('blur', undefined, quality);
          setMode('blur');
          setImageId(undefined);
          writeStoredChoice({ mode: 'blur', quality });
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
   * handlePerfDowngrade uses to fall back automatically; returns whether it
   * succeeded so that caller can decide whether to surface a message.
   */
  const setQuality = useCallback(
    async (nextQuality: SegmentationQuality) => {
      // A person choosing 'high' (or 'balanced') again gets a fresh shot at the
      // opposite auto-adjustment — otherwise one auto-swap early in a call would
      // silently suppress its counterpart for the rest of every call after.
      if (nextQuality === 'high') autoDowngradedRef.current = false;
      if (nextQuality === 'balanced') autoUpgradedRef.current = false;
      setBusy(true);
      setError('');
      try {
        writeStoredChoice({ mode, imageId, quality: nextQuality });
        setQualityState(nextQuality);
        await applyEffect(mode, imageId, nextQuality);
        return true;
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
    handleUpload,
    handleDelete,
    imageUrlFor,
  };
}

export type BackgroundEffectState = ReturnType<typeof useBackgroundEffect>;
