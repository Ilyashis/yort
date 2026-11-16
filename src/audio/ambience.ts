import type { AudioEngine } from './AudioEngine';

/** Громкость слоёв окружения, 0..1. */
export interface AmbienceLevels {
  traffic: number;
  /** Птицы (у зелени; в деревне — везде). */
  park: number;
  /** Шум листвы на ветру (в городе — у парков; в деревне не нужен: это ровное шипение). */
  leaves: number;
  water: number;
}

export type Surface = 'pavement' | 'grass';

/** Как часто подбрасываем пузырьки ручья, мс. */
const BABBLE_MS = 100;

/**
 * Звуки места: пение птиц, журчание реки вблизи, шаги, щелчки интерфейса; в городе ещё гул машин и листва.
 * Громкость слоёв задаёт soundscape по месту, где сейчас камера или пешеход.
 */
export class Ambience {
  private traffic: GainNode | undefined;
  private wind: GainNode | undefined;
  private water: GainNode | undefined;
  private levels: AmbienceLevels = { traffic: 0, park: 0, leaves: 0, water: 0 };
  private birdTimer: number | undefined;
  private waterTimer: number | undefined;
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
    // Ручей: лёгкий плеск — тихий верхний шум (струйки), поверх него — пузырьки (babble).
    this.water = this.noiseLayer('highpass', 1800, 0.5, 0.9, 0.5);

    this.birdTimer = window.setInterval(() => this.maybeBird(), 700);
    this.waterTimer = window.setInterval(() => this.babble(), BABBLE_MS);
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
    // Шаги — тихо, фоном: они не должны перекрывать птиц и ручей.
    const level = (surface === 'grass' ? 0.07 : 0.1) * (running ? 1.3 : 1);
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
    const { traffic, leaves, water } = this.levels;
    // Без постоянной «подложки»: где нет машин и листвы — тишина, слышны только птицы.
    this.traffic.gain.setTargetAtTime(0.42 * traffic, now, timeConstant);
    this.wind.gain.setTargetAtTime(0.22 * leaves, now, timeConstant);
    // Ручей — только вблизи и плавно нарастает, когда подходишь (квадрат близости). Это фон плеска,
    // главное — пузырьки.
    this.water.gain.setTargetAtTime(0.035 * water * water, now, timeConstant);
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

  /**
   * Птица в случайной стороне стереопанорамы, с лёгким эхом. Несколько «видов», чтобы не звучало
   * одной и той же трелью: воробьиное чириканье, синица («ци-ци-фи»), переливчатая трель, свист.
   */
  private maybeBird(): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const park = this.levels.park;
    if (park < 0.03) return;
    if (Math.random() > 0.06 + 0.3 * park) return;
    // У леса птиц больше: иногда поют сразу две.
    if (park > 0.8 && Math.random() < (park - 0.8) * 2.5) window.setTimeout(() => this.bird(park), 250 + Math.random() * 900);
    this.bird(park);
  }

  private bird(park: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.engine.ambience);
    const send = ctx.createGain();
    send.gain.value = 0.3;
    pan.connect(send).connect(this.engine.reverb);

    // Ближе или дальше — громче или тише.
    const level = (0.008 + 0.028 * park) * (0.5 + Math.random() * 0.6);
    const start = ctx.currentTime + 0.05;
    const kind = Math.random();
    if (kind < 0.35) this.chirps(pan, start, level);
    else if (kind < 0.6) this.titmouse(pan, start, level);
    else if (kind < 0.85) this.warble(pan, start, level);
    else this.whistle(pan, start, level);
  }

  /** Один «звук» птицы: тон от f0 к f1 за duration с мягкой атакой. */
  private note(out: AudioNode, at: number, f0: number, f1: number, duration: number, level: number, type: OscillatorType = 'sine'): void {
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

  /** Воробей: 2–4 коротких чирика вверх. */
  private chirps(out: AudioNode, at: number, level: number): void {
    const base = 2800 + Math.random() * 1400;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      this.note(out, at, base, base * (1.25 + Math.random() * 0.3), 0.08, level);
      at += 0.12 + Math.random() * 0.08;
    }
  }

  /** Синица: «ци-ци-фи», два высоких и один пониже, повтор 2–3 раза. */
  private titmouse(out: AudioNode, at: number, level: number): void {
    const high = 5200 + Math.random() * 600;
    const low = high * 0.72;
    const repeats = 2 + Math.floor(Math.random() * 2);
    for (let r = 0; r < repeats; r++) {
      this.note(out, at, high, high * 0.97, 0.06, level * 0.8);
      this.note(out, at + 0.1, high, high * 0.97, 0.06, level * 0.8);
      this.note(out, at + 0.2, low, low * 0.96, 0.14, level);
      at += 0.45;
    }
  }

  /** Переливчатая трель: частая «дрожь» тона, плавно уходящая вниз. */
  private warble(out: AudioNode, at: number, level: number): void {
    const ctx = this.engine.ctx!;
    const base = 3200 + Math.random() * 1500;
    const duration = 0.6 + Math.random() * 0.5;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 1.15, at);
    osc.frequency.exponentialRampToValueAtTime(base * 0.85, at + duration);
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 22 + Math.random() * 14;
    const depth = ctx.createGain();
    depth.gain.value = base * 0.09;
    vibrato.connect(depth).connect(osc.frequency);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level * 0.8, at + 0.05);
    envelope.gain.setValueAtTime(level * 0.8, at + duration - 0.12);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(envelope).connect(out);
    osc.start(at);
    vibrato.start(at);
    osc.stop(at + duration + 0.02);
    vibrato.stop(at + duration + 0.02);
  }

  /** Свист: два протяжных тона — вверх и вниз (как у иволги или дрозда). */
  private whistle(out: AudioNode, at: number, level: number): void {
    const base = 1900 + Math.random() * 700;
    this.note(out, at, base, base * 1.3, 0.22, level);
    this.note(out, at + 0.28, base * 1.3, base * 0.95, 0.3, level * 0.9);
  }

  /**
   * Журчание ручейка: много коротких «пузырьков» — тон, быстро уходящий вверх и затухающий (так звучит
   * лопающийся у поверхности пузырёк воздуха). Чем ближе к воде, тем их больше и тем они громче.
   */
  private babble(): void {
    const ctx = this.engine.ctx;
    const water = this.levels.water;
    if (!ctx || ctx.state !== 'running' || water < 0.03) return;
    const closeness = water * water;
    // До ~35 пузырьков в секунду у самой воды.
    const expected = 35 * closeness * (BABBLE_MS / 1000);
    let count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    const now = ctx.currentTime + 0.02;
    while (count-- > 0) {
      const at = now + Math.random() * (BABBLE_MS / 1000);
      const f0 = 450 + Math.random() ** 2 * 1300;
      const duration = 0.025 + Math.random() * 0.06;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f0 * (1.6 + Math.random() * 0.9), at + duration);
      const envelope = ctx.createGain();
      const level = (0.006 + Math.random() * 0.016) * closeness;
      envelope.gain.setValueAtTime(0, at);
      envelope.gain.linearRampToValueAtTime(level, at + 0.004);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.2 - 0.6;
      osc.connect(envelope).connect(pan).connect(this.engine.ambience);
      osc.start(at);
      osc.stop(at + duration + 0.01);
    }
  }
}
