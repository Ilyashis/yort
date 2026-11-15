// Общественные здания из OSM в своей форме (школа, лицей): контур и стены — как в данных, а на стене,
// что смотрит на ближайшую улицу, — вход с дверью и крыльцом под козырьком, вывеска с названием здания и
// флаги Башкортостана и России перед входом. Детали — из тех же частей, что у моделей домов.

import { Group } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { siteOnSlope } from '../world/base/siting';
import { doorParts, flagpole, porch, wallSign, at, type HousePart, type WallFrame } from '../world/village/houseParts';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { buildPartsMesh, createHouseMaterials, type HouseMaterials, type HouseMesh } from './houseMesh';
import type { GroundArea, GroundDelta } from './merged';

export interface PublicBuilding {
  id: string;
  /** Контур (локальные метры: x — восток, y — север). */
  ring: Vec2[];
  /** Высота стен над полом, м. */
  wallTop: number;
  /** Надпись на вывеске. */
  title: string;
}

/** Стена контура, что смотрит на ближайшую улицу (из достаточно длинных). Наружу — вправо от a → b. */
export function streetWall(ring: readonly Vec2[], roads: readonly (readonly Vec2[])[]): WallFrame | undefined {
  // Обход против часовой: наружу — справа от направления стены.
  const area = ring.reduce((s, p, i) => s + p[0] * ring[(i + 1) % ring.length]![1] - ring[(i + 1) % ring.length]![0] * p[1], 0);
  const pts = area >= 0 ? ring : [...ring].reverse();
  const roadDistance = (p: Vec2) => {
    let d = Infinity;
    for (const road of roads) {
      for (let k = 1; k < road.length; k++) {
        const a = road[k - 1]!;
        const b = road[k]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t));
      }
    }
    return d;
  };
  let best: { f: WallFrame; score: number } | undefined;
  const longest = Math.max(...pts.map((a, i) => Math.hypot(pts[(i + 1) % pts.length]![0] - a[0], pts[(i + 1) % pts.length]![1] - a[1])));
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Вход и вывеска — на стене не короче 8 м (или самой длинной, если здание маленькое).
    if (len < Math.min(8, longest * 0.9)) return;
    const tx = (b[0] - a[0]) / len;
    const ty = (b[1] - a[1]) / len;
    const mid: Vec2 = [(a[0] + b[0]) / 2 + ty * 6, (a[1] + b[1]) / 2 - tx * 6];
    // Ближе к улице — лучше; при равенстве — длиннее.
    const score = roadDistance(mid) - len * 0.15;
    if (!best || score < best.score) best = { f: { x: a[0], y: a[1], tx, ty, length: len }, score };
  });
  return best?.f;
}

/** Детали здания (локальные метры, z — от пола здания). */
export function publicParts(f: WallFrame, wallTop: number, title: string): HousePart[] {
  const u = f.length / 2;
  const floor = 0.15;
  const parts: HousePart[] = [];
  parts.push(...doorParts(f, u, floor, 1.9, 2.4, 0.03, 0.01, '#6b4a33', '#f2f0ea'));
  parts.push(
    ...porch(f, {
      u,
      width: 3.6,
      depth: 2.2,
      floor,
      wallOut: 0.03,
      canopy: { kind: 'gable', z: floor + 2.8 },
      wood: '#a8a397',
      roof: '#3a5f86',
      roofSurface: 'metal',
      trim: '#ecebe6',
    }),
  );
  const signW = Math.min(Math.max(title.length * 0.55, 3), f.length * 0.5, 6);
  // Вывеска — над входом, сразу над козырьком крыльца (у низкого здания — под карнизом).
  parts.push(...wallSign(f, u, 0.06, Math.min(floor + 3.85, wallTop - 0.55), signW, 0.85, title, '#1f5fa8', '#ffffff'));
  // Флаги — по сторонам дорожки, в 5 м от стены.
  const [lx, ly] = at(f, u - 3.2, 5, 0);
  const [rx, ry] = at(f, u + 3.2, 5, 0);
  const angle = Math.atan2(f.ty, f.tx);
  parts.push(...flagpole(lx, ly, 0, 8, 'bashkortostan', angle), ...flagpole(rx, ry, 0, 8, 'russia', angle));
  return parts;
}

export class PublicDetailsLayer {
  readonly group = new Group();
  private readonly materials: HouseMaterials;
  private readonly items: { id: string; mesh: HouseMesh; x: number; y: number }[] = [];

  /** Изменённые в редакторе копии этих зданий (сдвинутые, растянутые): их детали пересобираются. */
  private edited: { id: string; mesh: HouseMesh; x: number; y: number }[] = [];
  private editedKey = '';

  constructor(
    private readonly city: CityScene,
    buildings: readonly PublicBuilding[],
    private readonly roads: readonly (readonly Vec2[])[],
    private readonly heightAt: (x: number, y: number) => number,
    csm: CSM,
  ) {
    this.materials = createHouseMaterials(csm);
    this.group.name = 'public-details';
    for (const b of buildings) {
      const item = this.build(b);
      if (item) this.items.push(item);
    }
    city.scene.add(this.group);
  }

  private build(b: PublicBuilding): { id: string; mesh: HouseMesh; x: number; y: number } | undefined {
    const f = streetWall(b.ring, this.roads);
    if (!f) return undefined;
    const floor = siteOnSlope(b.ring, this.heightAt).floor;
    const mesh = buildPartsMesh(publicParts(f, b.wallTop, b.title), this.materials, `public:${b.id}`);
    // Части — от пола здания: вся группа — на его высоту.
    mesh.group.position.y = floor;
    this.group.add(mesh.group);
    return { id: b.id, mesh, x: f.x + (f.tx * f.length) / 2, y: f.y + (f.ty * f.length) / 2 };
  }

  /** Изменённые копии (своя форма из правок): детали — по их контуру и высоте. */
  setEdited(buildings: readonly PublicBuilding[]): void {
    const key = JSON.stringify(buildings);
    if (key === this.editedKey) return;
    this.editedKey = key;
    for (const item of this.edited) {
      this.group.remove(item.mesh.group);
      item.mesh.dispose();
    }
    this.edited = buildings.flatMap((b) => this.build(b) ?? []);
    this.city.requestRender();
  }

  get count(): number {
    return this.items.length;
  }

  /** Здания убраны или заменены правкой — их детали прячутся. */
  setHidden(ids: ReadonlySet<string>): void {
    for (const item of this.items) item.mesh.group.visible = !ids.has(item.id);
    this.city.requestRender();
  }

  /** Земля поменялась (кисть рельефа): детали — вместе со зданием. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    for (const item of [...this.items, ...this.edited]) {
      if (item.x < area.x0 || item.x > area.x1 || item.y < area.y0 || item.y > area.y1) continue;
      item.mesh.group.position.y += delta(item.x, item.y);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  destroy(): void {
    this.city.scene.remove(this.group);
    for (const item of [...this.items, ...this.edited]) item.mesh.dispose();
    this.materials.dispose();
  }
}
