import { useEffect, useState } from 'react';
import { TrackEvent, type LocalAudioTrack } from 'livekit-client';

/**
 * Live input level (0..1) for a mic track, for a level-meter UI.
 *
 * Keeps reacting while the mic is muted — the point is to let someone check "is my mic picking
 * me up?" *before* unmuting. LiveKit mutes a mic by setting its MediaStreamTrack's `.enabled` to
 * false, which makes it read as pure silence, so the meter measures a clone with `.enabled`
 * forced back on instead. The clone only ever feeds this local AnalyserNode; nothing it carries
 * is sent anywhere, so muting still means nobody else hears you.
 *
 * Rebuilt whenever LiveKit swaps the underlying MediaStreamTrack (a mic device switch fires
 * TrackEvent.Restarted on the same LocalAudioTrack) — otherwise the clone would keep the old
 * device open and the meter would keep measuring it.
 */
export function useMicLevel(track: LocalAudioTrack | null): number {
  const [level, setLevel] = useState(0);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!track) return;
    const bump = () => setEpoch((n) => n + 1);
    track.on(TrackEvent.Restarted, bump);
    return () => {
      track.off(TrackEvent.Restarted, bump);
    };
  }, [track]);

  useEffect(() => {
    if (!track) return; // no track to measure; reported as 0 below regardless of stale state
    if (track.mediaStreamTrack.readyState === 'ended') return;

    const meterTrack = track.mediaStreamTrack.clone();
    meterTrack.enabled = true;
    const audioContext = new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    const source = audioContext.createMediaStreamSource(new MediaStream([meterTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      // RMS around the 128 (silence) midpoint.
      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      // Perceived loudness (and mic input in general) is logarithmic, not
      // linear — a straight `rms * k` scale leaves normal speech barely
      // registering and only shooting up once you're nearly shouting. Convert
      // to dB and map a normal-conversation-to-loud-speech range onto 0..1
      // instead, so mid-volume talking actually moves the meter.
      //
      // The track this reads from is captured with autoGainControl (see
      // createLocalTracks in PreJoinScreen), which shapes what range is
      // actually reachable — these bounds are tuned by ear against that,
      // not derived from a theoretical dBFS range.
      const decibels = 20 * Math.log10(rms || 1e-8);
      const minDb = -50;
      const maxDb = 0;
      setLevel(Math.max(0, Math.min(1, (decibels - minDb) / (maxDb - minDb))));
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      meterTrack.stop();
      void audioContext.close();
    };
  }, [track, epoch]);

  return track ? level : 0;
}

/**
 * Plays "ド・ミ・ソ・ミ・ソ・ド" (C4-E4-G4-E4-G4-C5), one third of a second each,
 * so someone can confirm their speakers/headphones actually put out sound
 * without us having to ship and host an audio file for it.
 *
 * @param sinkId Output device to play on — in a call, the speaker picked in the mic menu, so
 *   the test checks the device the call's audio actually goes to. Ignored (system default)
 *   where AudioContext.setSinkId isn't supported, or for the default device.
 */
export async function playSpeakerTestTone(sinkId?: string): Promise<void> {
  const notes = [261.63, 329.63, 392.0, 329.63, 392.0, 523.25];
  const noteDuration = 1 / 3;

  const audioContext = new AudioContext();
  const withSink = audioContext as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && sinkId !== 'default' && withSink.setSinkId) {
    await withSink.setSinkId(sinkId).catch(() => {});
  }
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
  const now = audioContext.currentTime;

  notes.forEach((frequency, i) => {
    const start = now + i * noteDuration;
    const end = start + noteDuration;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    // Short fades in/out so each note doesn't click at its edges.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
    gain.gain.linearRampToValueAtTime(0.3, end - 0.02);
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(end);
  });

  const totalMs = notes.length * noteDuration * 1000;
  return new Promise((resolve) => {
    setTimeout(() => {
      void audioContext.close();
      resolve();
    }, totalMs);
  });
}
