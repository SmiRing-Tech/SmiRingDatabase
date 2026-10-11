/**
 * macOS の連係カメラ（Continuity Camera）は、近くにある同じ Apple ID の iPhone/iPad を Mac の
 * カメラ・マイクとして一覧に出し、条件がそろうと OS の既定デバイス自体をそちらに切り替える。
 * Connect はデバイスを指定せず OS の既定を使うので、そのままだとポケットの中の iPhone のマイクで
 * 通話に入ってしまう（相手に声が届かない）。
 *
 * 方針:
 *  - ユーザーが明示的に選んだデバイスは、iPhone/iPad であってもそのまま使う。
 *  - そうでなければ OS の既定に従う（イヤホン・ヘッドフォンの付け替えに自動で追従するため）。
 *    ただし既定が iPhone/iPad なら、iPhone/iPad 以外の候補を使う。候補が無ければ iPhone/iPad のまま。
 *
 * 入室前は PreJoinScreen、通話中は useContinuityDeviceGuard がこのルールを適用する。
 */

export type CaptureKind = 'audioinput' | 'videoinput';

/** 連係カメラのデバイス名には端末種別が入る（例: "〇〇のiPhoneのマイク" / "Taro's iPhone Camera"）。 */
const CONTINUITY_DEVICE_PATTERN = /iPhone|iPad/i;

/** Chrome が一覧に入れる「既定」「通信」の仮想エントリ。実デバイスではない。 */
const PSEUDO_DEVICE_IDS = new Set(['default', 'communications']);

export function isContinuityDevice(label: string | null | undefined): boolean {
  return !!label && CONTINUITY_DEVICE_PATTERN.test(label);
}

/** OS の既定デバイス。Chrome は 'default' の仮想エントリで、Safari/Firefox は先頭のデバイスで表す。 */
export function osDefaultDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  return devices.find((d) => d.deviceId === 'default') ?? devices[0];
}

/**
 * 既定が iPhone/iPad のときに代わりに使うデバイスID。既定が iPhone/iPad でない（＝既定に従えばよい）か、
 * 代わりの候補が無いときは null。`devices` は1種類（kind）分の一覧を渡す。
 */
export function nonContinuityFallback(devices: MediaDeviceInfo[]): string | null {
  if (!isContinuityDevice(osDefaultDevice(devices)?.label)) return null;
  const alternative = devices.find((d) => !PSEUDO_DEVICE_IDS.has(d.deviceId) && !isContinuityDevice(d.label));
  return alternative?.deviceId ?? null;
}

// 以下は1回の参加（入室前の画面〜通話終了）の間だけ持つ状態。PreJoinScreen の表示時にリセットする。
// 入室前の画面と通話中のメニュー・フックで共有するため、apiClient の guestAuthToken と同じくモジュールに置く。

/** ユーザーがメニューから明示的にデバイスを選んだ kind。以後その kind は自動で切り替えない。 */
const explicitlyChosen = new Set<CaptureKind>();
/** 既定が iPhone/iPad だったために代わりに使っているデバイスID。既定が戻ったら既定に戻すために覚えておく。 */
const fallbackInUse = new Map<CaptureKind, string>();

export function resetDeviceChoices(): void {
  explicitlyChosen.clear();
  fallbackInUse.clear();
}

export function markDeviceExplicitlyChosen(kind: CaptureKind): void {
  explicitlyChosen.add(kind);
  fallbackInUse.delete(kind);
}

export function isDeviceExplicitlyChosen(kind: CaptureKind): boolean {
  return explicitlyChosen.has(kind);
}

export function getFallbackInUse(kind: CaptureKind): string | undefined {
  return fallbackInUse.get(kind);
}

export function setFallbackInUse(kind: CaptureKind, deviceId: string | null): void {
  if (deviceId) fallbackInUse.set(kind, deviceId);
  else fallbackInUse.delete(kind);
}
