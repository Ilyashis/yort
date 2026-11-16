// Зимние звуки деревни (синтез, без файлов): мягкий ветер порывами, редкие синицы и вороны, ручей подо льдом —
// редкие глухие капли, изредка собака лает вдалеке, у ёлки — тихий перезвон колокольчиков.
// Ночью тише: ветер слабее, птиц нет, собака — реже.

import type { AudioEngine } from './AudioEngine';

/** Что слышно в этом месте зимой, 0..1. */
export interface WinterLevels {
  /** Ветер: на открытом месте и сверху сильнее, у домов и в лесу тише. */
  wind: number;
  /** Птицы (синицы, вороны): у деревьев чаще. */
  birds: number;
  /** Ручей подо льдом — только вблизи. */
  water: number;
  /** Колокольчики у ёлки — только рядом с ней. */
  bells: number;
  /** Собаки и жизнь деревни — у домов. */
  village: number;
}

export const SILENT_WINTER: WinterLevels = { wind: 0, birds: 0, water: 0, bells: 0, village: 0 };

const TICK_MS = 250;

export class WinterSounds {
  private wind?: GainNode;
  private levels: WinterLevels = SILENT_WINTER;
  private night = false;
  private timer?: number;
  private active = false;

  constructor(private readonly engine: AudioEngine) {}

  /** Зима включилась или выключилась. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    const ctx = this.engine.ctx;
    if (active && ctx) this.start(ctx);
    if (!active) {
      if (this.timer !== undefined) window.clearInterval(this.timer);
      this.timer = undefined;
      this.wind?.gain.setTargetAtTime(0, ctx?.currentTime ?? 0, 0.5);
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  setLevels(levels: WinterLevels, night: boolean): void {
    this.levels = levels;
    this.night = night;
    const ctx = this.engine.ctx;
    if (!ctx || !this.wind || !this.active) return;
    // Ветер — мягкий, низкий: громче на открытом месте, ночью слабее.
    this.wind.gain.setTargetAtTime(0.11 * levels.wind * (night ? 0.6 : 1), ctx.currentTime, 0.8);
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  private start(ctx: AudioContext): void {
    if (!this.wind) {
      const source = ctx.createBufferSource();
      source.buffer = this.engine.noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.9;
      // Порывы: громкость и «высота» ветра медленно гуляют.
      const swell = ctx.createGain();
      swell.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.4;
      lfo.connect(lfoGain).connect(swell.gain);
      const pitchLfo = ctx.createOscillator();
      pitchLfo.frequency.value = 0.11;
      const pitchDepth = ctx.createGain();
      pitchDepth.gain.value = 160;
      pitchLfo.connect(pitchDepth).connect(filter.frequency);
      const level = ctx.createGain();
      level.gain.value = 0;
      source.connect(filter).connect(swell).connect(level).connect(this.engine.ambience);
      source.start(0, Math.random() * 1.5);
      lfo.start();
      pitchLfo.start();
      this.wind = level;
    }
    if (this.timer === undefined) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.setLevels(this.levels, this.night);
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running' || !this.active) return;
    const { birds, water, bells, village } = this.levels;
    const per = TICK_MS / 1000;
    // Птицы днём: синица — изредка, ворона — ещё реже.
    if (!this.night && birds > 0.05) {
      if (Math.random() < per * 0.12 * birds) this.titmouse(birds);
      if (Math.random() < per * 0.05 * birds) this.crow(birds);
    }
    // Ручей подо льдом: редкие глухие капли.
    if (water > 0.05 && Math.random() < per * 6 * water * water) this.drip(water * water);
    // Собака вдалеке — редко (ночью ещё реже).
    if (village > 0.05 && Math.random() < per * (this.night ? 0.012 : 0.02) * village) this.dog();
    // Колокольчики у ёлки.
    if (bells > 0.05 && Math.random() < per * 0.9 * bells) this.chime(bells);
  }

  private panner(spread = 1.6): StereoPannerNode {
    const ctx = this.engine.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * spread - spread / 2;
    pan.connect(this.engine.ambience);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    pan.connect(send).connect(this.engine.reverb);
    return pan;
  }

  private tone(out: AudioNode, at: number, f0: number, f1: number, duration: number, level: number, type: OscillatorType = 'sine'): void {
    const ctx = this.engine.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f1, at + duration);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + Math.min(0.015, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(envelope).connect(out);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Синица зимой: звонкое «ци-ци-ци-фи». */
  private titmouse(birds: number): void {
    const ctx = this.engine.ctx!;
    const out = this.panner();
    const level = (0.01 + 0.02 * birds) * (0.6 + Math.random() * 0.5);
    const high = 5600 + Math.random() * 500;
    let at = ctx.currentTime + 0.05;
    for (let i = 0; i < 3; i++) {
      this.tone(out, at, high, high * 0.97, 0.05, level * 0.8);
      at += 0.09;
    }
    this.tone(out, at + 0.03, high * 0.7, high * 0.68, 0.16, level);
  }

  /** Ворона вдалеке: хриплое «кар» 2–3 раза. */
  private crow(birds: number): void {
    const ctx = this.engine.ctx!;
    const out = this.panner();
    const level = (0.012 + 0.018 * birds) * (0.6 + Math.random() * 0.4);
    const caws = 2 + Math.floor(Math.random() * 2);
    let at = ctx.currentTime + 0.05;
    for (let i = 0; i < caws; i++) {
      const base = 480 + Math.random() * 80;
      // Хрип: пилообразный тон через полосовой фильтр с «дрожью».
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 1.08, at);
      osc.frequency.exponentialRampToValueAtTime(base * 0.82, at + 0.28);
      const rasp = ctx.createOscillator();
      rasp.frequency.value = 55 + Math.random() * 20;
      const raspDepth = ctx.createGain();
      raspDepth.gain.value = base * 0.12;
      rasp.connect(raspDepth).connect(osc.frequency);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1300;
      band.Q.value = 1.4;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(level, at + 0.03);
      envelope.gain.setValueAtTime(level, at + 0.18);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(band).connect(envelope).connect(out);
      osc.start(at);
      rasp.start(at);
      osc.stop(at + 0.32);
      rasp.stop(at + 0.32);
      at += 0.42 + Math.random() * 0.15;
    }
  }

  /** Капля подо льдом: глухой короткий «плюх» вниз по тону. */
  private drip(closeness: number): void {
    const ctx = this.engine.ctx!;
    const out = this.panner(1);
    const at = ctx.currentTime + Math.random() * (TICK_MS / 1000);
    const f0 = 700 + Math.random() * 500;
    this.tone(out, at, f0, f0 * 0.55, 0.07 + Math.random() * 0.05, (0.012 + Math.random() * 0.012) * closeness);
  }

  /** Собака вдалеке: 2–4 «гав» с эхом, приглушённо. */
  private dog(): void {
    const ctx = this.engine.ctx!;
    const out = this.panner();
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 1400;
    muffle.connect(out);
    const barks = 2 + Math.floor(Math.random() * 3);
    const base = 330 + Math.random() * 120;
    let at = ctx.currentTime + 0.05;
    for (let i = 0; i < barks; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 1.3, at);
      osc.frequency.exponentialRampToValueAtTime(base * 0.8, at + 0.12);
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(0.014, at + 0.012);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      osc.connect(envelope).connect(muffle);
      osc.start(at);
      osc.stop(at + 0.16);
      at += 0.26 + Math.random() * 0.12;
    }
  }

  /** Колокольчик у ёлки: тихий звон с обертонами и долгим затуханием. */
  private chime(closeness: number): void {
    const ctx = this.engine.ctx!;
    const out = this.panner(0.8);
    const notes = [1568, 1760, 2093, 2349, 2637];
    const f = notes[Math.floor(Math.random() * notes.length)]!;
    const at = ctx.currentTime + Math.random() * (TICK_MS / 1000);
    const level = 0.012 * closeness;
    for (const [k, gain] of [
      [1, 1],
      [2.76, 0.35],
      [5.4, 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f * k;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(level * gain, at + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 1.4 / k);
      osc.connect(envelope).connect(out);
      osc.start(at);
      osc.stop(at + 1.5);
    }
  }
}
