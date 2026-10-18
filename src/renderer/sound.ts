/**
 * Completion chime for agent replies. The tone is synthesised with the Web Audio
 * API so the app ships no audio asset, and every call is a no-op where audio is
 * unavailable (tests, headless, blocked autoplay) — a missing chime must never
 * break a run.
 */

let enabled = true;
let context: AudioContext | undefined;
let unusable = false;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function configureCompletionSound(value: boolean): void {
  enabled = value;
}

function audioContext(): AudioContext | undefined {
  if (typeof window === "undefined" || unusable) return undefined;
  const Constructor =
    window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Constructor) {
    unusable = true;
    return undefined;
  }
  try {
    context ??= new Constructor();
    return context;
  } catch {
    unusable = true;
    return undefined;
  }
}

/** A short two-note rise: quiet enough to leave running in a shared room. */
export function playCompletionChime(): void {
  if (!enabled) return;
  const audio = audioContext();
  if (!audio) return;
  try {
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    for (const note of [
      { frequency: 880, start: 0, duration: 0.16 },
      { frequency: 1318.5, start: 0.13, duration: 0.32 },
    ]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      const from = now + note.start;
      const until = from + note.duration;
      gain.gain.setValueAtTime(0, from);
      gain.gain.linearRampToValueAtTime(0.16, from + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0005, until);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(from);
      oscillator.stop(until + 0.02);
    }
  } catch {
    /* Ignore: the chime is a nicety, never a requirement. */
  }
}

/** Preview button in the settings view; ignores the switch on purpose. */
export function previewCompletionChime(): void {
  const previous = enabled;
  enabled = true;
  playCompletionChime();
  enabled = previous;
}
