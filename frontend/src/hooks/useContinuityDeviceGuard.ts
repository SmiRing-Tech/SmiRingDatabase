import { useEffect } from 'react';
import { RoomEvent, Track, type Room } from 'livekit-client';
import {
  getFallbackInUse,
  isContinuityDevice,
  isDeviceExplicitlyChosen,
  nonContinuityFallback,
  osDefaultDevice,
  setFallbackInUse,
  type CaptureKind,
} from '../lib/continuityDevices';

const KIND_SOURCES: [CaptureKind, Track.Source][] = [
  ['audioinput', Track.Source.Microphone],
  ['videoinput', Track.Source.Camera],
];

/** devicechange は1回の抜き差しで連続して飛ぶうえ、LiveKit 自身の既定デバイス追従も同じイベントで動くので、落ち着いてから見る。 */
const RECONCILE_DELAY_MS = 500;

/**
 * 通話中のマイク・カメラに continuityDevices.ts の方針を適用し続ける:
 * 明示的に選んでいなければ OS の既定に従うが、既定が iPhone/iPad の間は iPhone/iPad 以外を使い、
 * 既定が iPhone/iPad 以外に戻ったら既定に戻す。デバイスの抜き差し・既定の変更（devicechange）と、
 * 通話中にカメラ/マイクを新しく公開したとき（LocalTrackPublished）に見直す。
 */
export function useContinuityDeviceGuard(room: Room) {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chain: Promise<void> = Promise.resolve();

    const reconcile = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const [kind, source] of KIND_SOURCES) {
        if (disposed || isDeviceExplicitlyChosen(kind)) continue;
        const track = room.localParticipant.getTrackPublication(source)?.track;
        if (!track) continue; // 未公開（カメラオフ等）。公開されたら LocalTrackPublished で見直す。

        const devicesOfKind = devices.filter((d) => d.kind === kind);
        const fallback = nonContinuityFallback(devicesOfKind);
        const inUse = getFallbackInUse(kind);

        if (fallback) {
          // 既定が iPhone/iPad。すでに代わりのデバイスを使っていて、それがまだつながっていれば何もしない。
          if (inUse && devicesOfKind.some((d) => d.deviceId === inUse)) continue;
          // いま取り込んでいるのが iPhone/iPad 以外の実デバイスならそれを維持し、そうでなければ代わりの候補へ。
          const currentLabel = track.mediaStreamTrack.label;
          const current = isContinuityDevice(currentLabel)
            ? undefined
            : devicesOfKind.find((d) => d.deviceId !== 'default' && d.label === currentLabel);
          const target = current?.deviceId ?? fallback;
          await room.switchActiveDevice(kind, target);
          setFallbackInUse(kind, target);
        } else if (inUse) {
          // 既定が iPhone/iPad 以外に戻った（または代わりの候補がもう無い）ので、既定に従う状態に戻す。
          const osDefault = osDefaultDevice(devicesOfKind);
          if (osDefault) await room.switchActiveDevice(kind, osDefault.deviceId);
          setFallbackInUse(kind, null);
        }
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        chain = chain
          .then(() => (disposed ? undefined : reconcile()))
          .catch((e) => console.warn('[Connect] Continuity device check failed:', e));
      }, RECONCILE_DELAY_MS);
    };

    const handleLocalTrackPublished = (pub: { source: Track.Source }) => {
      if (pub.source === Track.Source.Microphone || pub.source === Track.Source.Camera) schedule();
    };

    navigator.mediaDevices?.addEventListener('devicechange', schedule);
    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    schedule();

    return () => {
      disposed = true;
      clearTimeout(timer);
      navigator.mediaDevices?.removeEventListener('devicechange', schedule);
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    };
  }, [room]);
}
