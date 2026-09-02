import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { ParticipantEvent, Track, type LocalVideoTrack } from 'livekit-client';
import {
  MediapipeBackgroundProcessor,
  supportsMediapipeBackground,
  type SegmentationQuality,
} from '../../lib/video/MediapipeBackgroundProcessor';
import { apiClient } from '../../lib/apiClient';

/**
 * Background effect for the video room: off / blur / still image.
 *
 * Split in two on purpose. `useBackgroundEffect` owns the processor and must be
 * called somewhere that stays mounted for the whole call — the saved effect has
 * to be restored on join, not on the first time someone opens a settings panel,
 * and unmounting would drop the processor reference and force a rebuild.
 * `BackgroundControls` is the panel UI and can come and go freely.
 *
 * The chosen effect is remembered per device in localStorage rather than on the
 * server — it is a property of "this laptop's camera and GPU", not of the account,
 * and a phone joining the same call should not inherit a laptop's choice.
 */

type BackgroundMode = 'off' | 'blur' | 'image';

/** Bundled in frontend/public/backgrounds/ — no network round trip, no CORS. */
export const PRESETS = [
  { id: 'preset:slate', label: 'スレート', url: '/backgrounds/slate.jpg' },
  { id: 'preset:indigo', label: 'インディゴ', url: '/backgrounds/indigo.jpg' },
  { id: 'preset:dusk', label: 'ダスク', url: '/backgrounds/dusk.jpg' },
  { id: 'preset:forest', label: 'フォレスト', url: '/backgrounds/forest.jpg' },
  { id: 'preset:sand', label: 'サンド', url: '/backgrounds/sand.jpg' },
  { id: 'preset:paper', label: 'ペーパー', url: '/backgrounds/paper.jpg' },
];

/**
 * `objectUrl` is a blob: URL created from bytes fetched through our own backend,
 * not a link to R2. Two reasons: an authenticated <img> cannot carry a bearer
 * token, and a blob URL is same-origin, so WebGL can sample it without the
 * cross-origin dance that would otherwise need CORS headers on the bucket.
 */
type UploadedBackground = { id: string; created_at: string; objectUrl: string };

const STORAGE_KEY = 'smiring.connect.background';

type StoredChoice = { mode: BackgroundMode; imageId?: string; quality?: SegmentationQuality };

function readStoredChoice(): StoredChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: 'off' };
    const parsed = JSON.parse(raw) as StoredChoice;
    if (parsed.mode !== 'off' && parsed.mode !== 'blur' && parsed.mode !== 'image') {
      return { mode: 'off' };
    }
    return parsed;
  } catch {
    return { mode: 'off' };
  }
}

export function useBackgroundEffect() {
  const { localParticipant } = useLocalParticipant();
  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);

  const supported = useMemo(() => supportsMediapipeBackground(), []);
  const stored = useMemo(readStoredChoice, []);

  const [mode, setMode] = useState<BackgroundMode>(stored.mode);
  const [imageId, setImageId] = useState<string | undefined>(stored.imageId);
  const [quality, setQuality] = useState<SegmentationQuality>(stored.quality ?? 'balanced');
  const [uploads, setUploads] = useState<UploadedBackground[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const imageUrlFor = useCallback(
    (id: string | undefined) => {
      if (!id) return undefined;
      const preset = PRESETS.find((p) => p.id === id);
      if (preset) return preset.url;
      return uploads.find((u) => u.id === id)?.objectUrl;
    },
    [uploads],
  );

  /** Pulls one background's bytes through the backend and wraps them in a blob URL. */
  const fetchAsObjectUrl = useCallback(async (id: string) => {
    const res = await apiClient.get(`/api/connect/backgrounds/${id}/image`);
    if (!res.ok) throw new Error('背景画像を取得できませんでした');
    return URL.createObjectURL(await res.blob());
  }, []);

  // Every blob URL we mint, so none of them leak when this unmounts.
  const objectUrlsRef = useRef<string[]>([]);
  const trackObjectUrl = useCallback((url: string) => {
    objectUrlsRef.current.push(url);
    return url;
  }, []);

  useEffect(
    () => () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
    },
    [],
  );

  // Load the user's saved backgrounds once per mount.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;

    (async () => {
      const res = await apiClient.get('/api/connect/backgrounds');
      if (!res.ok) return;
      const data = await res.json();
      const rows: { id: string; created_at: string }[] = data.backgrounds ?? [];

      // One failed image should not blank the whole picker.
      const loaded = await Promise.all(
        rows.map(async (row) => {
          try {
            return { ...row, objectUrl: trackObjectUrl(await fetchAsObjectUrl(row.id)) };
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) setUploads(loaded.filter((b): b is UploadedBackground => b !== null));
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [supported, fetchAsObjectUrl, trackObjectUrl]);

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

      const current = processorRef.current;
      const isAttached = !!current && track.getProcessor() === current;
      const qualityMatches = current?.quality === nextQuality;

      if (isAttached && qualityMatches) {
        await current!.setBackground({
          mode: nextMode === 'image' ? 'image' : 'blur',
          imageUrl: imageUrl ?? null,
        });
        return;
      }

      const processor = new MediapipeBackgroundProcessor({
        quality: nextQuality,
        mode: nextMode === 'image' ? 'image' : 'blur',
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
    async (next: { mode?: BackgroundMode; imageId?: string; quality?: SegmentationQuality }) => {
      const nextMode = next.mode ?? mode;
      const nextImageId = 'imageId' in next ? next.imageId : imageId;
      const nextQuality = next.quality ?? quality;

      setBusy(true);
      setError('');
      try {
        await applyEffect(nextMode, nextImageId, nextQuality);
        setMode(nextMode);
        setImageId(nextImageId);
        setQuality(nextQuality);
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ mode: nextMode, imageId: nextImageId, quality: nextQuality }),
        );
      } catch (e) {
        console.error('[Connect] failed to apply background effect:', e);
        setError(e instanceof Error ? e.message : '背景の適用に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, mode, imageId, quality],
  );

  // The camera track may be published after this component mounts (joined with the
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
        const form = new FormData();
        form.append('file', file);
        const res = await apiClient.post('/api/connect/backgrounds', form);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');

        const row: { id: string; created_at: string } = data.background;
        const uploaded: UploadedBackground = {
          ...row,
          objectUrl: trackObjectUrl(await fetchAsObjectUrl(row.id)),
        };
        setUploads((prev) => [uploaded, ...prev]);
        // Select it immediately — uploading a background and not using it is not a thing.
        await applyEffect('image', uploaded.id, quality);
        setMode('image');
        setImageId(uploaded.id);
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ mode: 'image', imageId: uploaded.id, quality }),
        );
      } catch (e) {
        console.error('[Connect] background upload failed:', e);
        setError(e instanceof Error ? e.message : 'アップロードに失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, quality, fetchAsObjectUrl, trackObjectUrl],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(true);
      setError('');
      try {
        const res = await apiClient.delete(`/api/connect/backgrounds/${id}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '削除に失敗しました');
        }
        setUploads((prev) => {
          const removed = prev.find((u) => u.id === id);
          if (removed) {
            URL.revokeObjectURL(removed.objectUrl);
            objectUrlsRef.current = objectUrlsRef.current.filter((u) => u !== removed.objectUrl);
          }
          return prev.filter((u) => u.id !== id);
        });
        // Deleting the background currently on screen leaves nothing to show.
        if (imageId === id) {
          await applyEffect('blur', undefined, quality);
          setMode('blur');
          setImageId(undefined);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'blur', quality }));
        }
      } catch (e) {
        console.error('[Connect] background delete failed:', e);
        setError(e instanceof Error ? e.message : '削除に失敗しました');
      } finally {
        setBusy(false);
      }
    },
    [applyEffect, imageId, quality],
  );

  return {
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
  };
}

export type BackgroundEffectState = ReturnType<typeof useBackgroundEffect>;

