// Прилипание точек, когда забор (или дорогу) ставят щелчками: новый забор сходится с соседним
// в общем углу, упирается в его линию и идёт под прямым углом к предыдущему отрезку — так участки
// обводятся по карте без щелей и перекосов.

import type { Vec2 } from '../walk/localFrame';

export type SnapKind = 'vertex' | 'line' | 'angle';

export interface Snap {
  point: Vec2;
  kind: SnapKind;
}

/** Допуск прямого угла, градусы. */
const ANGLE_TOLERANCE_DEG = 6;

/**
 * Куда встать точке p. Приоритет: угол соседнего забора (ближе tolerance) → его линия (ближе
 * tolerance · 0,7) → тот же или прямой угол к предыдущему отрезку (prev2 → prev) → без прилипания.
 */
export function snapPoint(p: Vec2, lines: readonly (readonly Vec2[])[], tolerance: number, prev?: Vec2, prev2?: Vec2): Snap | undefined {
  let vertex: { d: number; point: Vec2 } | undefined;
  for (const line of lines) {
    for (const q of line) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d <= tolerance && (!vertex || d < vertex.d)) vertex = { d, point: [q[0], q[1]] };
    }
  }
  if (vertex) return { point: vertex.point, kind: 'vertex' };

  let onLine: { d: number; point: Vec2 } | undefined;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const q = closestOnSegment(p, line[i - 1]!, line[i]!);
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d <= tolerance * 0.7 && (!onLine || d < onLine.d)) onLine = { d, point: q };
    }
  }
  if (onLine) return { point: onLine.point, kind: 'line' };

  if (prev && prev2) {
    const base = Math.atan2(prev[1] - prev2[1], prev[0] - prev2[0]);
    const dx = p[0] - prev[0], dy = p[1] - prev[1];
    const length = Math.hypot(dx, dy);
    if (length > 0.5) {
      const angle = Math.atan2(dy, dx);
      // Ближайшее кратное 90° к направлению предыдущего отрезка.
      const turn = Math.round((angle - base) / (Math.PI / 2)) * (Math.PI / 2);
      let off = angle - base - turn;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.abs(off) <= (ANGLE_TOLERANCE_DEG * Math.PI) / 180) {
        const a = base + turn;
        return { point: [prev[0] + Math.cos(a) * length, prev[1] + Math.sin(a) * length], kind: 'angle' };
      }
    }
  }
  return undefined;
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2)) : 0;
  return [a[0] + abx * t, a[1] + aby * t];
}

/** Длина отрезка, м — для подсказки «отрезок 12,4 м». */
export const segmentLength = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Метры с одним знаком по-русски: 12,4 м. */
export const formatMetres = (m: number) => `${m.toFixed(1).replace('.', ',')} м`;

/** Точка на середине каждого отрезка — за неё тянут, чтобы вставить излом. */
export function midpoints(line: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i < line.length; i++) out.push([(line[i - 1]![0] + line[i]![0]) / 2, (line[i - 1]![1] + line[i]![1]) / 2]);
  return out;
}

/** Убрать излом index; у забора остаётся хотя бы две точки (иначе undefined). Замкнутый остаётся замкнутым. */
export function removeVertex(line: readonly Vec2[], index: number): Vec2[] | undefined {
  const closed = line.length > 3 && line[0]![0] === line[line.length - 1]![0] && line[0]![1] === line[line.length - 1]![1];
  if (closed) {
    const ring = line.slice(0, -1).filter((_, i) => i !== (index === line.length - 1 ? 0 : index));
    return ring.length >= 3 ? [...ring, ring[0]!] : undefined;
  }
  const out = line.filter((_, i) => i !== index);
  return out.length >= 2 ? out : undefined;
}
