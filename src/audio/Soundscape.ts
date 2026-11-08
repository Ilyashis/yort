import type { Vec2 } from '../world/walk/localFrame';
import { AudioEngine, type Volumes } from './AudioEngine';
import { Ambience } from './ambience';
import { EngineSound, type CarSound } from './engineSound';
import { GenerativeMusic } from './music';
import type { SoundZones } from './soundZones';

/** Длина шага, м: при ходьбе и беге. */
const STRIDE = { walk: 0.75, run: 1.6 } as const;
const UPDATE_MS = 250;

export interface ListenerSample {
  /** Положение слушателя в локальных метрах района. */
  point: Vec2;
  /** Высота над землёй, м. */
  altitude: number;
}

/**
 * Звуковая картина сцены: музыка, звуки города по месту слушателя, шаги и щелчки интерфейса.
 * Сэмплирует камеру несколько раз в секунду — без перерисовок React.
 */
export class Soundscape {
  private readonly engine = new AudioEngine();
  private readonly music = new GenerativeMusic(this.engine);
  private readonly ambience = new Ambience(this.engine);
  private readonly car = new EngineSound(this.engine);
  private readonly timer: number;
  private stepDistance = 0;

  constructor(
    private readonly zones: SoundZones,
    private readonly sample: () => ListenerSample | undefined,
  ) {
    this.engine.onReady(() => {
      this.music.start();
      this.ambience.start();
    });
    // Браузер разрешит звук только после жеста пользователя.
    window.addEventListener('pointerdown', this.unlock, true);
    window.addEventListener('keydown', this.unlock, true);
    document.addEventListener('click', this.onClick, true);
    this.timer = window.setInterval(() => this.update(), UPDATE_MS);
  }

  setEnabled(enabled: boolean): void {
    this.engine.setEnabled(enabled);
  }

  setVolumes(volumes: Volumes): void {
    this.engine.setVolumes(volumes);
  }

  /** Пешеход прошёл distance метров — пора ли «шагнуть». */
  walked(distance: number, running: boolean, point: Vec2): void {
    this.stepDistance += distance;
    const stride = running ? STRIDE.run : STRIDE.walk;
    if (this.stepDistance < stride) return;
    this.stepDistance %= stride;
    this.ambience.footstep(this.zones.surfaceAt(point), running);
  }

  /** Машина: мотор и шины (undefined — заглушить). */
  drove(car: CarSound | undefined): void {
    this.car.update(car);
  }

  /** Машина ударилась: сила 0..1. */
  bumped(strength: number): void {
    this.car.bump(strength);
  }

  /** По чему едет или идёт: «плитка» или трава/грунт. */
  surfaceAt(point: Vec2) {
    return this.zones.surfaceAt(point);
  }

  destroy(): void {
    window.clearInterval(this.timer);
    this.car.stop();
    window.removeEventListener('pointerdown', this.unlock, true);
    window.removeEventListener('keydown', this.unlock, true);
    document.removeEventListener('click', this.onClick, true);
    this.music.stop();
    this.ambience.stop();
    this.engine.destroy();
  }

  private readonly unlock = () => this.engine.unlock();

  private readonly onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button')) this.ambience.click();
  };

  private update(): void {
    if (!this.engine.isRunning) return;
    const listener = this.sample();
    if (listener) this.ambience.setLevels(this.zones.levelsAt(listener.point, listener.altitude));
  }
}
