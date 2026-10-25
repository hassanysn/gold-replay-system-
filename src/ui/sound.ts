// Short MT5-style sounds made with Web Audio (no sound files): trade opened, trade closed, zone alert.

let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers only allow sound after a click; call this from any click to unlock it early. */
export function unlockSound() {
  audio();
}

function tone(a: AudioContext, freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.18) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime + start);
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(vol, a.currentTime + start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.02);
}

/** Trade opened: short rising double chime. */
export function playOpen() {
  const a = audio();
  if (!a) return;
  tone(a, 880, 0, 0.12);
  tone(a, 1318.5, 0.09, 0.18);
}

/** Trade closed (SL, TP, manager or you): falling double tone. */
export function playClose() {
  const a = audio();
  if (!a) return;
  tone(a, 1046.5, 0, 0.12, 'triangle', 0.2);
  tone(a, 659.3, 0.1, 0.22, 'triangle', 0.2);
}

/** Replay paused on a zone touch: three quick alert pings. */
export function playAlert() {
  const a = audio();
  if (!a) return;
  for (let i = 0; i < 3; i++) tone(a, 1568, i * 0.16, 0.1, 'square', 0.07);
}
