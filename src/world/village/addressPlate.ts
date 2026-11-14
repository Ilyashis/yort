// Где на доме-модели висит адресная табличка: на уличном фасаде (сторона −y модели), у правого угла,
// если смотреть с улицы, на высоте чуть выше окон первого этажа — на самой передней стене в этом месте
// (у дома с верандой — на веранде).

import type { HousePart } from './houseParts';

/** Табличка: ширина и высота, м (как обычная сине-белая табличка с улицей и номером). */
export const PLATE_SIZE: [number, number] = [0.62, 0.36];
/** Высота середины таблички над полом, м. */
const PLATE_Z = 1.95;
/** Отступ от угла фасада до середины таблички, м. */
const CORNER_OFFSET = 0.75;

/** Положение таблички в осях модели: x — вдоль фасада, y — лицо таблички (перед стеной), z — высота. */
export function platePlacement(parts: readonly HousePart[], width: number, depth: number): { x: number; y: number; z: number } {
  // С улицы (со стороны −y) правая рука — это +x.
  const x = Math.max(0, width / 2 - CORNER_OFFSET);
  let front: number | undefined;
  for (const p of parts) {
    let face: number | undefined;
    if (p.type === 'box' && !p.angle) {
      const covers = Math.abs(p.center[0] - x) <= p.size[0] / 2 && Math.abs(p.center[2] - PLATE_Z) <= p.size[2] / 2;
      // Стена, а не тонкая планка или ступенька: толще 5 см и выше 1 м.
      if (covers && p.size[1] >= 0.05 && p.size[2] >= 1) face = p.center[1] - p.size[1] / 2;
    } else if (p.type === 'cylinder') {
      // Бревно сруба вдоль фасада на высоте таблички.
      const horizontal = Math.abs(p.from[2] - p.to[2]) < 0.01 && Math.abs(p.from[1] - p.to[1]) < 0.01;
      const covers = Math.min(p.from[0], p.to[0]) <= x && Math.max(p.from[0], p.to[0]) >= x && Math.abs(p.from[2] - PLATE_Z) <= p.radius * 3;
      if (horizontal && covers) face = p.from[1] - p.radius;
    }
    // Только то, что стоит на фасадной половине дома.
    if (face !== undefined && face < 0 && face > -depth / 2 - 0.3 && (front === undefined || face < front)) front = face;
  }
  return { x, y: (front ?? -depth / 2) - 0.02, z: PLATE_Z };
}
