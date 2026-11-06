// User World: здание на участке. Спецификация (BuildingSpec) — это контракт,
// который сейчас заполняет форма, а дальше будет заполнять ИИ по текстовому запросу.
// Генератор детерминированно превращает спецификацию + участок в геометрию здания.

import { area, buffer, polygon } from '@turf/turf';
import type { LonLat } from './plot';

export type BuildingType = 'residential' | 'office' | 'tower' | 'house';
export type RoofKind = 'flat' | 'pitched';
/** Тип окон в шейдере фасадов: 0 — классика, 1 — высокие узкие, 2 — ленточные. */
export type WindowVariant = 0 | 1 | 2;

export interface BuildingSpec {
  type: BuildingType;
  /** Количество надземных этажей. */
  floors: number;
  /** Высота этажа, м. */
  floorHeight: number;
  /** Отступ стен от границ участка, м. */
  setback: number;
  roof: RoofKind;
  /** Цвет фасада, #rrggbb. */
  facadeColor: string;
  /** Витрины на первом этаже. */
  shops: boolean;
}

interface TypePreset {
  label: string;
  windowVariant: WindowVariant;
  defaults: Omit<BuildingSpec, 'type' | 'setback'>;
}

export const BUILDING_TYPES: Record<BuildingType, TypePreset> = {
  residential: {
    label: 'Жилой дом',
    windowVariant: 0,
    defaults: { floors: 9, floorHeight: 3.0, roof: 'flat', facadeColor: '#e9dcc3', shops: true },
  },
  office: {
    label: 'Офис',
    windowVariant: 2,
    defaults: { floors: 6, floorHeight: 3.6, roof: 'flat', facadeColor: '#a9b9c7', shops: true },
  },
  tower: {
    label: 'Башня',
    windowVariant: 2,
    defaults: { floors: 25, floorHeight: 3.3, roof: 'flat', facadeColor: '#d5dadb', shops: false },
  },
  house: {
    label: 'Особняк',
    windowVariant: 1,
    defaults: { floors: 2, floorHeight: 3.2, roof: 'pitched', facadeColor: '#f1e7d3', shops: false },
  },
};

/** Цвета фасада в конструкторе. */
export const FACADE_SWATCHES = [
  '#e9dcc3', '#f3f0e9', '#f1e7d3', '#d9b99f', '#c99f84', '#d5dadb', '#a9b9c7', '#b5c4a8', '#e3c56f',
];

export const SPEC_LIMITS = {
  floors: { min: 1, max: 40 },
  floorHeight: { min: 2.7, max: 5 },
  setback: { min: 0, max: 20 },
  /** Максимальная высота здания, м. */
  maxHeight: 150,
  /** Минимальная площадь пятна застройки после отступов, м². */
  minFootprint: 30,
} as const;

export const DEFAULT_SETBACK = 3;

export function defaultSpec(type: BuildingType, setback = DEFAULT_SETBACK): BuildingSpec {
  return { type, setback, ...BUILDING_TYPES[type].defaults };
}

/** Готовая геометрия здания. */
export interface GeneratedBuilding {
  /** Контур стен (без повторной замыкающей точки). */
  footprint: LonLat[];
  /** Площадь пятна застройки, м². */
  footprintArea: number;
  /** Общая площадь этажей, м². */
  grossArea: number;
  /** Высота стен, м. */
  wallHeight: number;
  roof: RoofKind;
  /** Высота конька над стенами, м (0 — плоская крыша). */
  ridgeHeight: number;
  totalHeight: number;
  floorHeight: number;
  windowVariant: WindowVariant;
}

export type BuildIssueCode =
  | 'floors-out-of-range'
  | 'floor-height-out-of-range'
  | 'setback-out-of-range'
  | 'setback-too-large'
  | 'footprint-too-small'
  | 'too-tall'
  | 'bad-color';

export interface BuildIssue {
  code: BuildIssueCode;
  message: string;
}

export interface BuildResult {
  building?: GeneratedBuilding;
  /** Ошибки: разместить нельзя. */
  issues: BuildIssue[];
  /** Предупреждения: разместить можно, но что-то упрощено. */
  warnings: string[];
}

/** Проверка спецификации — пригодится и для ответа ИИ, а не только для формы. */
export function validateSpec(spec: BuildingSpec): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const { floors, floorHeight, setback } = SPEC_LIMITS;
  if (!Number.isInteger(spec.floors) || spec.floors < floors.min || spec.floors > floors.max) {
    issues.push({ code: 'floors-out-of-range', message: `Этажей должно быть от ${floors.min} до ${floors.max}` });
  }
  if (!(spec.floorHeight >= floorHeight.min && spec.floorHeight <= floorHeight.max)) {
    issues.push({
      code: 'floor-height-out-of-range',
      message: `Высота этажа — от ${floorHeight.min} до ${floorHeight.max} м`,
    });
  }
  if (!(spec.setback >= setback.min && spec.setback <= setback.max)) {
    issues.push({ code: 'setback-out-of-range', message: `Отступ — от ${setback.min} до ${setback.max} м` });
  }
  if (!/^#[0-9a-f]{6}$/i.test(spec.facadeColor)) {
    issues.push({ code: 'bad-color', message: 'Цвет фасада должен быть в формате #rrggbb' });
  }
  return issues;
}

export function generateBuilding(spec: BuildingSpec, plot: readonly LonLat[]): BuildResult {
  const issues = validateSpec(spec);
  const warnings: string[] = [];
  if (issues.length > 0 || plot.length < 3) return { issues, warnings };

  const footprint = insetPolygon(plot, spec.setback);
  if (!footprint) {
    return {
      issues: [{ code: 'setback-too-large', message: 'Отступ слишком большой — на участке не остаётся места' }],
      warnings,
    };
  }

  const footprintArea = area(polygon([[...footprint, footprint[0]!]]));
  if (footprintArea < SPEC_LIMITS.minFootprint) {
    issues.push({
      code: 'footprint-too-small',
      message: `Пятно застройки меньше ${SPEC_LIMITS.minFootprint} м² — уменьшите отступ`,
    });
  }

  let roof = spec.roof;
  if (roof === 'pitched' && !isConvex(footprint)) {
    roof = 'flat';
    warnings.push('Скатная крыша строится только на выпуклом контуре — сделана плоская');
  }

  const wallHeight = spec.floors * spec.floorHeight;
  const ridgeHeight = roof === 'pitched' ? pitchedRidge(footprint, footprintArea) : 0;
  const totalHeight = wallHeight + ridgeHeight;
  if (totalHeight > SPEC_LIMITS.maxHeight) {
    issues.push({ code: 'too-tall', message: `Высота больше ${SPEC_LIMITS.maxHeight} м` });
  }

  return {
    building: {
      footprint,
      footprintArea,
      grossArea: footprintArea * spec.floors,
      wallHeight,
      roof,
      ridgeHeight,
      totalHeight,
      floorHeight: spec.floorHeight,
      windowVariant: BUILDING_TYPES[spec.type].windowVariant,
    },
    issues,
    warnings,
  };
}

/** Контур, отступивший внутрь на distance метров; undefined — если места не осталось. */
export function insetPolygon(points: readonly LonLat[], distance: number): LonLat[] | undefined {
  const closed = [...points, points[0]!];
  if (distance < 0.01) return [...points];
  const result = buffer(polygon([closed]), -distance, { units: 'meters', steps: 2 });
  const geometry = result?.geometry;
  if (!geometry) return undefined;
  // При вогнутом участке может распасться на части — берём самую большую.
  const outers = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates)
    .map((rings) => rings[0] as LonLat[] | undefined)
    .filter((ring): ring is LonLat[] => !!ring && ring.length >= 4);
  if (!outers.length) return undefined;
  const largest = outers.reduce((best, ring) => (ringArea(ring) > ringArea(best) ? ring : best));
  return largest.slice(0, -1);
}

const ringArea = (ring: LonLat[]) => area(polygon([ring]));

/** Выпуклый ли контур (все повороты в одну сторону). */
export function isConvex(points: readonly LonLat[]): boolean {
  let sign = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % n]!;
    const [cx, cy] = points[(i + 2) % n]!;
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-18) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Высота конька при уклоне ~25°: половина «ширины» контура × tg 25°, в разумных пределах. */
function pitchedRidge(footprint: readonly LonLat[], footprintArea: number): number {
  let perimeter = 0;
  const latRad = ((footprint[0]?.[1] ?? 0) * Math.PI) / 180;
  for (let i = 0; i < footprint.length; i++) {
    const [ax, ay] = footprint[i]!;
    const [bx, by] = footprint[(i + 1) % footprint.length]!;
    perimeter += Math.hypot((bx - ax) * 111_320 * Math.cos(latRad), (by - ay) * 111_320);
  }
  const halfWidth = perimeter > 0 ? (2 * footprintArea) / perimeter : 0;
  return Math.min(Math.max(halfWidth * Math.tan((25 * Math.PI) / 180), 1.5), 6);
}
