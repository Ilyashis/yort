// Время суток: от высоты солнца над горизонтом — сила и цвет солнца и луны, рассеянный свет,
// экспозиция, цвет дымки, когда зажигаются окна и фонари, когда видны звёзды.
// Чистые функции (без three.js) — легко тестировать. День — 15 июля, время — уфимское (UTC+5):
// летом в Уфе солнце садится около 21:50, а в полночь опускается лишь на ~14° под горизонт.

/** Местное время → момент (UTC) того же летнего дня. */
export const DAY = { year: 2026, month: 6, day: 15 };
export const UTC_OFFSET_HOURS = 5;
/** Время по умолчанию — предвечерний свет, как было до смены дня и ночи. */
export const DEFAULT_TIME = 17.5;

/** Когда время идёт само: сутки за 6 минут. */
export const TIME_FLOW_HOURS_PER_SECOND = 24 / 360;
/** Быстрый выбор времени: утро, день, закат, ночь. */
export const TIME_PRESETS: { label: string; hours: number }[] = [
  { label: 'Утро', hours: 6.5 },
  { label: 'День', hours: 13 },
  { label: 'Закат', hours: 21.25 },
  { label: 'Ночь', hours: 0.5 },
];

export type Rgb = [number, number, number];

export interface Lighting {
  /** Солнце: сила (как у DirectionalLight) и цвет sRGB 0..1. */
  sunIntensity: number;
  sunColor: Rgb;
  /** Луна (свет с другой стороны неба, голубоватый, со слабыми тенями). */
  moonIntensity: number;
  moonColor: Rgb;
  /** Рассеянный свет неба ночью (полусфера: небо — земля), чтобы город не тонул в черноте. */
  nightAmbient: number;
  /** Отражения окружения (небо) и экспозиция камеры. */
  environment: number;
  exposure: number;
  /** Цвет дымки у горизонта. */
  fog: Rgb;
  /** 0 — день, 1 — глубокая ночь (небо, звёзды). */
  night: number;
  /** Доля горящих окон и сила фонарей, 0..1. */
  windows: number;
  lamps: number;
  stars: number;
  /** Сила свечения ярких мест (окна, фонари). */
  bloom: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Плавный переход от a к b (a может быть больше b — тогда переход «вниз»). */
export function ramp(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const hex = (value: string): Rgb => [0, 2, 4].map((i) => parseInt(value.slice(1 + i, 3 + i), 16) / 255) as Rgb;

const SUN_LOW = hex('#ff9a55');
const SUN_HIGH = hex('#fff1dc');
const MOON = hex('#9db4ff');
const FOG_DAY = hex('#c5d3df');
const FOG_SUNSET = hex('#d8b49c');
const FOG_NIGHT = hex('#141c2e');

/** Освещение при высоте солнца elevation (градусы над горизонтом). */
export function lightingAt(elevation: number): Lighting {
  const sun = ramp(-2, 12, elevation);
  const night = ramp(1, -8, elevation);
  // Закатная окраска: солнце у горизонта — оранжевое, к 30° — обычное тёплое.
  const sunColor = mix(SUN_LOW, SUN_HIGH, ramp(1, 30, elevation));
  const sunset = ramp(12, 2, elevation) * (1 - ramp(-2, -7, elevation));
  const fogDay = mix(FOG_DAY, FOG_SUNSET, sunset);
  return {
    sunIntensity: 2.6 * sun,
    sunColor,
    moonIntensity: 0.55 * ramp(-3, -10, elevation),
    moonColor: MOON,
    nightAmbient: 0.8 * night,
    environment: 0.5 - 0.3 * night,
    exposure: 0.92 + 0.3 * night,
    fog: mix(fogDay, FOG_NIGHT, night),
    night,
    windows: ramp(5, -5, elevation),
    lamps: ramp(3, -3, elevation),
    stars: ramp(-5, -11, elevation),
    bloom: 0.45 * ramp(2, -6, elevation),
  };
}

/** Положение солнца (радианы): высота над горизонтом и азимут от севера по часовой. */
export function sunAngles(date: Date, lat: number, lon: number): { elevation: number; azimuth: number } {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86_400_000 - 10_957.5; // дни от J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const ecliptic = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const obliquity = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const hourAngle = (gmst * 15 + lon) * rad - ra;
  const phi = lat * rad;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(hourAngle));
  return { elevation, azimuth };
}

/** Высота солнца (градусы) в местное время hours. */
export function sunElevationAt(hours: number, lat: number, lon: number): number {
  return (sunAngles(dateAt(hours), lat, lon).elevation * 180) / Math.PI;
}

/** Местное время (часы, дробные) → момент UTC того же дня. */
export function dateAt(hours: number): Date {
  const { year, month, day } = DAY;
  return new Date(Date.UTC(year, month, day) + (hours - UTC_OFFSET_HOURS) * 3_600_000);
}

/** 17.5 → «17:30». */
export function formatTime(hours: number): string {
  const total = Math.round((((hours % 24) + 24) % 24) * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
