import { useCallback, useEffect, useRef, useState } from 'react';
import type { EffectTarget, SegmentationQuality } from '../../lib/video/MediapipeBackgroundProcessor';
import { apiClient } from '../../lib/apiClient';

/**
 * The parts of the background feature that have nothing to do with where the
 * effect ends up: the picture library and the remembered choice.
 *
 * Shared by the in-call hook (which applies the effect to the published camera
 * track) and the pre-join hook (which applies it to a local preview), so the two
 * cannot drift apart on how images are fetched or how the choice is stored.
 */

export type BackgroundMode = 'off' | 'blur' | 'image';

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
export type UploadedBackground = { id: string; created_at: string; objectUrl: string };

const STORAGE_KEY = 'smiring.connect.background';

export type StoredChoice = {
  mode: BackgroundMode;
  imageId?: string;
  quality?: SegmentationQuality;
  target?: EffectTarget;
};

/**
 * The choice lives in localStorage rather than on the server: it is a property
 * of "this laptop's camera and GPU", not of the account, so a phone joining the
 * same call should not inherit what was picked on a desktop.
 */
export function readStoredChoice(): StoredChoice {
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

export function writeStoredChoice(choice: StoredChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // A full or disabled storage is not worth failing the effect over.
  }
}

/** Loads, uploads and deletes the user's saved backgrounds. */
export function useBackgroundLibrary(enabled: boolean) {
  const [uploads, setUploads] = useState<UploadedBackground[]>([]);

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

  /** Pulls one background's bytes through the backend and wraps them in a blob URL. */
  const fetchAsObjectUrl = useCallback(async (id: string) => {
    const res = await apiClient.get(`/api/connect/backgrounds/${id}/image`);
    if (!res.ok) throw new Error('背景画像を取得できませんでした');
    return URL.createObjectURL(await res.blob());
  }, []);

  // Load the user's saved backgrounds once per mount.
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, fetchAsObjectUrl, trackObjectUrl]);

  const imageUrlFor = useCallback(
    (id: string | undefined) => {
      if (!id) return undefined;
      const preset = PRESETS.find((p) => p.id === id);
      if (preset) return preset.url;
      return uploads.find((u) => u.id === id)?.objectUrl;
    },
    [uploads],
  );

  const uploadBackground = useCallback(
    async (file: File): Promise<UploadedBackground> => {
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
      return uploaded;
    },
    [fetchAsObjectUrl, trackObjectUrl],
  );

  const deleteBackground = useCallback(async (id: string) => {
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
  }, []);

  return { uploads, imageUrlFor, uploadBackground, deleteBackground };
}
