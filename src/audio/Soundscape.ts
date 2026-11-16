import type { Vec2 } from '../world/walk/localFrame';
import { AudioEngine, type Volumes } from './AudioEngine';
import { Ambience } from './ambience';
import { EngineSound, type CarSound } from './engineSound';
import type { SoundZones } from './soundZones';

/**
 * Сколько метров проходим между звуками шагов. Пешеход в сцене идёт быстро (4 м/с, бегом 12), поэтому
 * шаг длиннее настоящего: около двух шагов в секунду при ходьбе — как в жизни, а не дробный топот.
 */
const STRIDE = { walk: 1.9, run: 3.2 } as const;
const UPDATE_MS = 250;

export interface ListenerSample {
  /** Положение слушателя в локальных метрах района. */
  point: Vec2;
  /** Высота над землёй, м. */
  altitude: number;
}

/**
 * Звуковая картина сцены: звуки места по положению слушателя (птицы, река рядом), шаги, машина, щелчки.
 * Сэмплирует камеру несколько раз в секунду — без перерисовок React.
 */
export class Soundscape {
  private readonly engine = new AudioEngine();
  private readonly ambience = new Ambience(this.engine);
  private readonly car = new EngineSound(this.engine);
  private readonly timer: number;
  private stepDistance = 0;

  constructor(
    private readonly zones: SoundZones,
    private readonly sample: () => ListenerSample | undefined,
  ) {
    // Фоновой музыки нет: в деревне слышны птицы и река рядом (музыка с шумом мешали).
    this.engine.onReady(() => this.ambience.start());
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
