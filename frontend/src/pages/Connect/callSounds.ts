let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    // Some browsers refuse AudioContext outside a user gesture; the call still
    // works fine without the chime, so this is just a no-op rather than an error.
    return null;
  }
}

type Note = { freq: number; atMs: number; durMs: number };

/** Plays each note at its own offset/length, with a quick attack and exponential decay. */
function playNotes(notes: Note[], { wave = 'sine', peak = 0.2 }: { wave?: OscillatorType; peak?: number } = {}): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  for (const { freq, atMs, durMs } of notes) {
    const start = now + atMs / 1000;
    const end = start + durMs / 1000;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, start);

    // Quick attack, exponential decay — a soft "pop" rather than a harsh beep.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/** Plays `freqs` (Hz) one after another, `stepMs` apart, each ringing for `noteMs`. */
function playChime(freqs: number[], stepMs: number, noteMs: number): void {
  playNotes(freqs.map((freq, i) => ({ freq, atMs: i * stepMs, durMs: noteMs })));
}

// C5 D5 E5 G5 — "ぽぽぽん↑". Played for every participant when a recording starts,
// same as the "録画中" banner, so nobody finds out about it only after the fact.
export function playRecordingStartSound(): void {
  playChime([523.25, 587.33, 659.25, 783.99], 90, 180);
}

// The same four notes descending — "ぽぽぽん↓" — when a recording stops.
export function playRecordingStopSound(): void {
  playChime([783.99, 659.25, 587.33, 523.25], 90, 180);
}

// E5 → C5, doorbell-style "ピンポーン" — someone joined the room. Two notes with a long
// ring on the second, so it can't be mistaken for either four-note recording chime.
export function playParticipantJoinSound(): void {
  playNotes(
    [
      { freq: 659.25, atMs: 0, durMs: 400 },
      { freq: 523.25, atMs: 300, durMs: 1000 },
    ],
    { peak: 0.15 },
  );
}

// G4 → C4, "ポローン↓" — someone left the room. Two notes like the join chime, so
// join/leave read as one pair and neither can pass for a four-note recording chime —
// mistaking a leave for "recording stopped" would be the harmful confusion, leaving people
// believing they're no longer being recorded. Lower and in a softer triangle wave so it's
// also told apart from the join chime by ear.
export function playParticipantLeaveSound(): void {
  playNotes(
    [
      { freq: 392.0, atMs: 0, durMs: 250 },
      { freq: 261.63, atMs: 180, durMs: 700 },
    ],
    { wave: 'triangle', peak: 0.15 },
  );
}
