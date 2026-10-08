import crypto from 'crypto';

const GUEST_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A guest key is a random UUID a not-logged-in visitor's browser keeps. It is a bearer
 *  secret (it unlocks their own form drafts), so it must never be shown to other people. */
export function isGuestKey(value: unknown): value is string {
  return typeof value === 'string' && GUEST_KEY_RE.test(value);
}

/** The LiveKit identity for a guest holding `guestKey`. Derived one-way so other
 *  participants (who can see identities) can't recover the key, yet stable across rejoins
 *  so the backend can match a guest's in-call presence to their form responses. */
export function guestIdentityForKey(guestKey: string): string {
  const hash = crypto.createHash('sha256').update(guestKey.toLowerCase()).digest('hex');
  return `guest_${hash.slice(0, 32)}`;
}
