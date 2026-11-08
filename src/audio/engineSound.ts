// Звук машины, синтезом в браузере: мотор (пила и квадрат по оборотам через фильтр — «ворчит» на холостых
// и звенит на высоких), шорох шин (шум: по асфальту — выше, по траве и грунту — глуше) и глухой удар.

import type { AudioEngine } from './AudioEngine';
import type { Surface } from './ambience';

export interface CarSound {
  /** Обороты, 0..1. */
  rpm: number;
  /** Газ, −1..1. */
  throttle: number;
  /** Скорость, м/с (по модулю). */
  speed: number;
  surface: Surface;
}

interface Nodes {
  saw: OscillatorNode;
  square: OscillatorNode;
  filter: BiquadFilterNode;
  motor: GainNode;
  tyres: AudioBufferSourceNode;
  tyreFilter: BiquadFilterNode;
  tyreGain: GainNode;
}

const GLIDE = 0.06;

export class EngineSound {
  private nodes?: Nodes;
  private stopTimer = 0;

  constructor(private readonly engine: AudioEngine) {}

  update(car: CarSound | undefined): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!car) {
      this.fadeOut();
      return;
    }
    window.clearTimeout(this.stopTimer);
    this.stopTimer = 0;
    const n = (this.nodes ??= this.create(ctx));
    const now = ctx.currentTime;
    const throttle = Math.max(car.throttle, 0);
    const f = 26 + car.rpm * 150;
    n.saw.frequency.setTargetAtTime(f, now, GLIDE);
    n.square.frequency.setTargetAtTime(f / 2, now, GLIDE);
    n.filter.frequency.setTargetAtTime(220 + car.rpm * 800 + throttle * 450, now, GLIDE);
    n.motor.gain.setTargetAtTime(0.045 + car.rpm * 0.05 + throttle * 0.05, now, GLIDE);
    const grass = car.surface === 'grass';
    const roll = Math.min(car.speed / 22, 1);
    n.tyreFilter.frequency.setTargetAtTime((grass ? 260 : 520) + roll * 500, now, 0.1);
    n.tyreGain.gain.setTargetAtTime(roll * (grass ? 0.16 : 0.09), now, 0.1);
  }

  /** Удар о стену: сила 0..1. */
  bump(strength: number): void {
    const ctx = this.engine.ctx;
    if (!ctx || ctx.state !== 'running' || strength <= 0) return;
    const at = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.engine.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const envelope = ctx.createGain();
    const level = 0.15 + 0.45 * Math.min(strength, 1);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(level, at + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    source.connect(filter).connect(envelope).connect(this.engine.sfx);
    source.start(at, Math.random());
    source.stop(at + 0.4);
  }

  stop(): void {
    window.clearTimeout(this.stopTimer);
    this.release();
  }

  private create(ctx: AudioContext): Nodes {
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    const square = ctx.createOscillator();
    square.type = 'square';
    const squareGain = ctx.createGain();
    squareGain.gain.value = 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 2;
    const motor = ctx.createGain();
    motor.gain.value = 0;
    saw.connect(filter);
    square.connect(squareGain).connect(filter);
    filter.connect(motor).connect(this.engine.sfx);

    const tyres = ctx.createBufferSource();
    tyres.buffer = this.engine.noise;
    tyres.loop = true;
    const tyreFilter = ctx.createBiquadFilter();
    tyreFilter.type = 'bandpass';
    tyreFilter.Q.value = 0.8;
    const tyreGain = ctx.createGain();
    tyreGain.gain.value = 0;
    tyres.connect(tyreFilter).connect(tyreGain).connect(this.engine.sfx);

    saw.start();
    square.start();
    tyres.start();
    return { saw, square, filter, motor, tyres, tyreFilter, tyreGain };
  }

  private fadeOut(): void {
    const n = this.nodes;
    const ctx = this.engine.ctx;
    if (!n || !ctx || this.stopTimer) return;
    const now = ctx.currentTime;
    n.motor.gain.setTargetAtTime(0, now, 0.15);
    n.tyreGain.gain.setTargetAtTime(0, now, 0.1);
    this.stopTimer = window.setTimeout(() => this.release(), 900);
  }

  private release(): void {
    const n = this.nodes;
    this.nodes = undefined;
    this.stopTimer = 0;
    if (!n) return;
    for (const node of [n.saw, n.square, n.tyres]) {
      try {
        node.stop();
      } catch {
        // уже остановлен
      }
    }
    n.motor.disconnect();
    n.tyreGain.disconnect();
  }
}
