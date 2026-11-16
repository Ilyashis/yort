import type { Vec2 } from '../world/walk/localFrame';
import { AudioEngine, type Volumes } from './AudioEngine';
import { Ambience } from './ambience';
import { EngineSound, type CarSound } from './engineSound';
import type { SoundZones } from './soundZones';
import { WinterSounds } from './winter';

const UPDATE_MS = 250;

export interface ListenerSample {
  /** Положение слушателя в локальных метрах района. */
  point: Vec2;
  /** Высота над землёй, м. */
  altitude: number;
  /** Зима: свои звуки (ветер, синицы и вороны, ручей подо льдом). */
  winter?: boolean;
  /** Ночь: тише. */
  night?: boolean;
}

/** Где ёлка и дома (локальные метры) — для колокольчиков и собак зимой. */
export interface WinterPlaces {
  tree?: Vec2;
  houses: readonly Vec2[];
}

/**
 * Звуковая картина сцены: звуки места по положению слушателя (птицы, река рядом), машина, щелчки. Шагов нет.
 * Сэмплирует камеру несколько раз в секунду — без перерисовок React.
 */
export class Soundscape {
  private readonly engine = new AudioEngine();
  private readonly ambience = new Ambience(this.engine);
  private readonly car = new EngineSound(this.engine);
  private readonly winter = new WinterSounds(this.engine);
  private winterPlaces: WinterPlaces = { houses: [] };
  private readonly timer: number;

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

  /** Машина: мотор и шины (undefined — заглушить). Зимой шины — по снегу. */
  drove(car: CarSound | undefined): void {
    this.car.update(car && this.winter.isActive ? { ...car, surface: 'snow' } : car);
  }

  /** Где ёлка и дома — для зимних колокольчиков и собак. */
  setWinterPlaces(places: WinterPlaces): void {
    this.winterPlaces = places;
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
    this.winter.stop();
    this.engine.destroy();
  }

  private readonly unlock = () => this.engine.unlock();

  private readonly onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('button')) this.ambience.click();
  };

  private update(): void {
    if (!this.engine.isRunning) return;
    const listener = this.sample();
    if (!listener) return;
    const winter = !!listener.winter;
    this.winter.setActive(winter);
    if (winter) {
      // Зимой летние слои молчат: ни летних птиц, ни журчания.
      this.ambience.setLevels({ traffic: 0, park: 0, leaves: 0, water: 0 });
      this.winter.setLevels(this.zones.winterAt(listener.point, listener.altitude, this.winterPlaces.tree, this.winterPlaces.houses), !!listener.night);
    } else {
      this.ambience.setLevels(this.zones.levelsAt(listener.point, listener.altitude));
    }
  }
}
