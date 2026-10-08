const GUEST_KEY_STORAGE = 'smiring_form_guest_key';
const GUEST_NAME_STORAGE = 'smiring_form_guest_name';

export const FORM_GUEST_KEY_HEADER = 'X-Form-Guest-Key';

export type FormGuest = { key: string; name: string };

// The key identifies a not-logged-in respondent across visits so they can resume drafts.
// If storage is unavailable (private mode etc.) they still get a key, just not a persistent one.
export function getOrCreateFormGuestKey(): string {
  try {
    const existing = localStorage.getItem(GUEST_KEY_STORAGE);
    if (existing) return existing;
  } catch { /* storage unavailable */ }
  const key = crypto.randomUUID();
  try {
    localStorage.setItem(GUEST_KEY_STORAGE, key);
  } catch { /* storage unavailable */ }
  return key;
}

export function getSavedFormGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_STORAGE) || '';
  } catch {
    return '';
  }
}

export function saveFormGuestName(name: string) {
  try {
    localStorage.setItem(GUEST_NAME_STORAGE, name);
  } catch { /* storage unavailable */ }
}

export function formGuestRequestOptions(guest: FormGuest | null | undefined): RequestInit | undefined {
  return guest ? { headers: { [FORM_GUEST_KEY_HEADER]: guest.key } } : undefined;
}
