import type { AudioEngine } from './AudioEngine';

/** Громкость слоёв окружения, 0..1. */
export interface AmbienceLevels {
  traffic: number;
  park: number;
  water: number;
}

export type Surface = 'pavement' | 'grass';

/**
 * Звуки города из шума: гул машин, ветер в листве, птицы, вода у реки, шаги, щелчки интерфейса.
 * Громкость слоёв задаёт soundscape по месту, где сейчас камера или пешеход.
 */
export class Ambience {
  private traffic: GainNode | undefined;
  private wind: GainNode | undefined;
  private water: GainNode | undefined;
  private levels: AmbienceLevels = { traffic: 0, park: 0, water: 0 };
  private birdTimer: number | undefined;
  private waterTimer: number | undefined;
  private waterFilter: BiquadFilterNode | undefined;
  private started = false;

  constructor(private readonly engine: AudioEngine) {}

  start(): void {
    const ctx = this.engine.ctx;
    if (!ctx || this.started) return;
    this.started = true;

    // Машины: низкий «бурый» шум с медленными наплывами проезжающих авто.
    this.traffic = this.noiseLayer('lowpass', 320, 0.7, 0.07, 0.35);
    // Листва: средние частоты, громкость «гуляет» как порывы ветра.
    this.wind = this.noiseLayer('bandpass', 900, 0.6, 0.1, 0.4);
    // Вода: журчание — полосовой шум, частота которого дрожит.
    this.water = this.noiseLayer('bandpass', 1300, 1.4, 0.4, 0.3);
    this.waterFilter = (this.water as GainNode & { filter?: BiquadFilterNode }).filter;

    this.birdTimer = window.setInterval(() => this.maybeBird(), 700);
    this.waterTimer = window.setInterval(() => this.babble(), 120);
    this.apply(0.1);
  }

  stop(): void {
    if (this.birdTimer !== undefined) window.clearInterval(this.birdTimer);
    if (this.waterTimer !== undefined) window.clearInterval(this.waterTimer);
  }

  setLevels(levels: AmbienceLevels): void {
    this.levels = levels;
    this.apply(0.6);
  }

  /** Шаг: короткий щелчок шума; по траве — глуше, по плитке — суше и звонче. */
  footstep(surface: Surface, running: boolean): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const at = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.engine.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = surface === 'grass' ? 'lowpass' : 'bandpass';
    filter.frequency.value = (surface === 'grass' ? 380 : 900) * (0.9 + Math.random() * 0.2);
    filter.Q.value = surface === 'grass' ? 0.7 : 1.1;
    const envelope = ctx.createGain();
    const level = (surface === 'grass' ? 0.16 : 0.22) * (running ? 1.3 : 1);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + (surface === 'grass' ? 0.16 : 0.09));
    source.connect(filter).connect(envelope).connect(this.engine.sfx);
    source.start(at, Math.random() * 1.5);
    source.stop(at + 0.2);
  }

  /** Тихий щелчок интерфейса. */
  click(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const at = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1300, at);
    osc.frequency.exponentialRampToValueAtTime(700, at + 0.05);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.05, at);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    osc.connect(envelope).connect(this.engine.sfx);
    osc.start(at);
    osc.stop(at + 0.08);
  }

  private apply(timeConstant: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.traffic || !this.wind || !this.water) return;
    const now = ctx.currentTime;
    const { traffic, park, water } = this.levels;
    this.traffic.gain.setTargetAtTime(0.03 + 0.42 * traffic, now, timeConstant);
    this.wind.gain.setTargetAtTime(0.02 + 0.22 * park, now, timeConstant);
    this.water.gain.setTargetAtTime(0.3 * water, now, timeConstant);
  }

  /**
   * Петля шума → фильтр → громкость слоя, плюс медленный LFO на громкость или частоту.
   * Возвращает узел громкости слоя (в поле filter — сам фильтр).
   */
  private noiseLayer(
    type: BiquadFilterType,
    frequency: number,
    q: number,
    lfoRate: number,
    lfoDepth: number,
  ): GainNode {
    const ctx = this.engine.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.engine.noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const swell = ctx.createGain();
    swell.gain.value = 1 - lfoDepth / 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = lfoRate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = lfoDepth / 2;
    lfo.connect(lfoGain).connect(swell.gain);
    const level = ctx.createGain() as GainNode & { filter?: BiquadFilterNode };
    level.gain.value = 0;
    level.filter = filter;
    source.connect(filter).connect(swell).connect(level).connect(this.engine.ambience);
    source.start(0, Math.random() * 1.5);
    lfo.start();
    return level;
  }

  /** Птица: 2–4 быстрых чирика с глиссандо, в случайной стороне стереопанорамы. */
  private maybeBird(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const chance = 0.05 + 0.35 * this.levels.park;
    if (Math.random() > chance * (this.levels.park > 0.05 ? 1 : 0.15)) return;

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.engine.ambience);
    const send = ctx.createGain();
    send.gain.value = 0.35;
    pan.connect(send).connect(this.engine.reverb);

    const base = 2600 + Math.random() * 1800;
    const level = 0.012 + 0.03 * this.levels.park;
    const chirps = 2 + Math.floor(Math.random() * 3);
    let at = ctx.currentTime + 0.05;
    for (let i = 0; i < chirps; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base, at);
      osc.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.3), at + 0.07);
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(level, at + 0.01);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
      osc.connect(envelope).connect(pan);
      osc.start(at);
      osc.stop(at + 0.1);
      at += 0.11 + Math.random() * 0.08;
    }
  }

  private babble(): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.waterFilter || this.levels.water < 0.02) return;
    this.waterFilter.frequency.setTargetAtTime(900 + Math.random() * 1200, ctx.currentTime, 0.05);
  }
}
