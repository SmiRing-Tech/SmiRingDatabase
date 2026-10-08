const GUEST_KEY_STORAGE = 'smiring_form_guest_key';
const GUEST_NAME_STORAGE = 'smiring_form_guest_name';

export const FORM_GUEST_KEY_HEADER = 'X-Form-Guest-Key';

export type FormGuest = { key: string; name: string };

let sessionGuestKey: string | null = null;

// The key identifies a not-logged-in visitor across visits: it resumes their form drafts and,
// in Connect, keeps their call identity stable so survey progress can match them to answers.
// If storage is unavailable (private mode etc.) it still stays the same for this page load.
export function getOrCreateFormGuestKey(): string {
  if (sessionGuestKey) return sessionGuestKey;
  try {
    const existing = localStorage.getItem(GUEST_KEY_STORAGE);
    if (existing) return (sessionGuestKey = existing);
  } catch { /* storage unavailable */ }
  sessionGuestKey = crypto.randomUUID();
  try {
    localStorage.setItem(GUEST_KEY_STORAGE, sessionGuestKey);
  } catch { /* storage unavailable */ }
  return sessionGuestKey;
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
