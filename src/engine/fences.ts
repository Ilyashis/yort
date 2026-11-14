// Настоящие заборы деревни: линии, снятые с картинки-рендера (fences-render.json), — досками и столбами
// одной сеткой. Показываются, когда «обустроенный посёлок» выключен: там заборы придуманные.

import { Color, type Mesh } from 'three';
import type { World } from '../core/data';
import { hash01 } from '../core/geo';
import type { RingIndex } from '../core/spatial';
import { MergedBuilder, type GroundArea, type GroundDelta, type MergedMesh } from '../three/merged';
import { FENCE, FENCE_COLOR_HEX, fenceBoxes } from '../world/base/buildingDetails';
import type { HeightMap } from './terrain';

export interface Fences {
  mesh: Mesh;
  /** Заборы по одному: ключ и линия (локальные метры, y — север) — чтобы выбрать и взять в правку. */
  lines: { id: string; line: [number, number][] }[];
  /** Спрятать заборы, убранные или взятые в правку. */
  setHidden: (keys: ReadonlySet<string>) => void;
  shiftGround: (delta: GroundDelta, area: GroundArea) => void;
  dispose: () => void;
}

export function createFences(world: World, hm: HeightMap, footprints: RingIndex): Fences | undefined {
  if (!world.surveyFences.length) return undefined;
  const builder = new MergedBuilder();
  const lines: Fences['lines'] = [];
  world.surveyFences.forEach((line, n) => {
    // Цвет — один на забор, из тех же красок, что у заборов редактора.
    const color = new Color(FENCE_COLOR_HEX[Math.floor(hash01(n, 7) * FENCE_COLOR_HEX.length)]);
    const post = color.clone().multiplyScalar(0.7);
    // Ключ — по месту, а не по номеру: номера меняются, когда заборы пересчитывают.
    const a0 = line[0], a1 = line[line.length - 1];
    const id = `mf/${a0[0].toFixed(1)}/${a0[1].toFixed(1)}/${a1[0].toFixed(1)}/${a1[1].toFixed(1)}`;
    lines.push({ id, line: line.map(([x, z]): [number, number] => [x, -z]) });
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      // Кусок, целиком попавший в дом, — не забор, а кромка крыши на картинке.
      if (footprints.find((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) >= 0) continue;
      const { pieces, posts } = fenceBoxes([a[0], -a[1]], [b[0], -b[1]], FENCE.other, true);
      for (const box of pieces) builder.addBox(box, hm.at(box.center[0], -box.center[1]), color, id);
      for (const box of posts) builder.addBox(box, hm.at(box.center[0], -box.center[1]), post, id);
    }
  });
  if (builder.empty) return undefined;
  const merged: MergedMesh = builder.build('survey-fences', undefined);
  return {
    mesh: merged.mesh,
    lines,
    setHidden: (keys) => {
      merged.setHidden((owner) => keys.has(owner));
    },
    shiftGround: (delta, area) => {
      merged.shiftGround(delta, area);
    },
    dispose: () => merged.dispose(),
  };
}
