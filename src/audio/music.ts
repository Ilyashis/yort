import { midiToHz, type AudioEngine } from './AudioEngine';

/**
 * Спокойная генеративная музыка: медленно сменяющиеся аккорды-«подушки»
 * и редкие колокольчики по пентатонике. Не повторяется и не надоедает.
 */

/** Аккорды (MIDI): Dmaj9 → Bm9 → Gmaj7 → Asus2. */
const CHORDS = [
  [50, 57, 61, 64, 66],
  [47, 54, 57, 61, 62],
  [43, 50, 54, 59],
  [45, 52, 59, 61],
];
/** Ре-мажорная пентатоника для колокольчиков (2-я и 3-я октавы над средней). */
const BELL_NOTES = [74, 76, 78, 81, 83, 86, 88];

const CHORD_SECONDS = 10;
const LOOKAHEAD_MS = 250;

export class GenerativeMusic {
  private timer: number | undefined;
  private nextChordAt = 0;
  private nextBellAt = 0;
  private chord = 0;

  constructor(private readonly engine: AudioEngine) {}

  start(): void {
    if (this.timer !== undefined) return;
    const ctx = this.engine.ctx;
    if (!ctx) return;
    this.nextChordAt = ctx.currentTime + 0.1;
    this.nextBellAt = ctx.currentTime + 4;
    this.timer = window.setInterval(() => this.schedule(), LOOKAHEAD_MS);
    this.schedule();
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 1;

    while (this.nextChordAt < horizon) {
      this.playChord(CHORDS[this.chord % CHORDS.length]!, this.nextChordAt);
      this.chord++;
      this.nextChordAt += CHORD_SECONDS;
    }
    while (this.nextBellAt < horizon) {
      const note = BELL_NOTES[Math.floor(Math.random() * BELL_NOTES.length)]!;
      this.playBell(note, this.nextBellAt);
      this.nextBellAt += 2.5 + Math.random() * 5;
    }
  }

  /** Аккорд-подушка: по два слегка расстроенных голоса на ноту, мягкий фильтр, долгие атака и затухание. */
  private playChord(notes: number[], at: number): void {
    const ctx = this.engine.ctx!;
    const length = CHORD_SECONDS + 4; // перекрытие с соседним аккордом
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700, at);
    filter.frequency.linearRampToValueAtTime(1400, at + length / 2);
    filter.frequency.linearRampToValueAtTime(800, at + length);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(0.09, at + 3.5);
    envelope.gain.setValueAtTime(0.09, at + length - 4.5);
    envelope.gain.linearRampToValueAtTime(0, at + length);
    filter.connect(envelope);
    envelope.connect(this.engine.music);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    envelope.connect(send).connect(this.engine.reverb);

    for (const note of notes) {
      for (const [type, detune] of [['sine', -4], ['triangle', 5]] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = midiToHz(note);
        osc.detune.value = detune;
        const voice = ctx.createGain();
        voice.gain.value = (type === 'sine' ? 0.5 : 0.22) / notes.length;
        osc.connect(voice).connect(filter);
        osc.start(at);
        osc.stop(at + length + 0.1);
      }
    }
  }

  /** Колокольчик: основной тон + «колокольный» обертон, короткая атака, долгое затухание. */
  private playBell(note: number, at: number): void {
    const ctx = this.engine.ctx!;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(0.035, at + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 3.5);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.2 - 0.6;
    envelope.connect(pan);
    pan.connect(this.engine.music);
    const send = ctx.createGain();
    send.gain.value = 0.8;
    pan.connect(send).connect(this.engine.reverb);

    for (const [ratio, level] of [[1, 1], [2.76, 0.25]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToHz(note) * ratio;
      const partial = ctx.createGain();
      partial.gain.value = level;
      osc.connect(partial).connect(envelope);
      osc.start(at);
      osc.stop(at + 3.6);
    }
  }
}
