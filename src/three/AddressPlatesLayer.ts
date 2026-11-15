// Адресные таблички на домах: синяя табличка с белой рамкой — улица мелко, номер крупно, — на уличном
// фасаде у самого угла, выше окон (2,5 м от пола). Все таблички — одна геометрия и один атлас-текстура.

import { BufferAttribute, BufferGeometry, CanvasTexture, Group, LinearMipmapLinearFilter, Mesh, MeshStandardMaterial, SRGBColorSpace } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { siteOnSlope } from '../world/base/siting';
import { modelPlacement } from '../world/edit/edits';
import type { HouseModelId } from '../world/village/houseModels';
import { fitPreset } from '../world/village/villagePlan';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import type { GroundArea, GroundDelta } from './merged';
import { hookMaterial } from './shaderHooks';

export interface AddressPlate {
  houseId: string;
  /** Прямоугольник модели дома (локальные метры, против часовой, первая сторона — уличный фасад). */
  rect: readonly Vec2[];
  /** Модель дома: таблички — по её настоящему размеру. */
  model?: HouseModelId;
  street: string;
  number: string;
}

/** Табличка, м: ширина, высота; от угла фасада, над полом; отступ от стены. */
const W = 0.6;
const H = 0.32;
/** Табличка — у самого угла (между углом и окном места мало), выше окон: так её не закрывают наличники. */
const FROM_CORNER = 0.14;
const ABOVE_FLOOR = 2.5;
const OFF_WALL = 0.17;
/** Ячейка атласа, пиксели. */
const CW = 256;
const CH = 136;

function drawPlate(ctx: CanvasRenderingContext2D, x: number, y: number, street: string, number: string): void {
  ctx.save();
  ctx.translate(x, y);
  const r = 12;
  const rounded = (x0: number, y0: number, w: number, h: number, rr: number) => {
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, rr);
  };
  rounded(2, 2, CW - 4, CH - 4, r);
  ctx.fillStyle = '#f4f2ea';
  ctx.fill();
  rounded(9, 9, CW - 18, CH - 18, r - 5);
  ctx.fillStyle = '#1f4f9a';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Улица — в одну строку, ужимаем шрифт под ширину.
  let size = 30;
  ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  while (ctx.measureText(street).width > CW - 34 && size > 16) {
    size -= 1;
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  }
  ctx.fillText(street, CW / 2, 40);
  ctx.font = `700 62px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(number, CW / 2, 92);
  ctx.restore();
}

export class AddressPlatesLayer {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly texture: CanvasTexture;
  private readonly material: MeshStandardMaterial;
  /** У каждой таблички — её 4 вершины в общем буфере и точка для сдвига с землёй. */
  private readonly anchors: { houseId: string; x: number; y: number; first: number }[] = [];
  private hidden = new Set<string>();
  private base!: Float32Array;

  constructor(
    private readonly city: CityScene,
    plates: readonly AddressPlate[],
    heightAt: (x: number, y: number) => number,
    csm: CSM,
  ) {
    const perRow = 16;
    const rows = Math.max(1, Math.ceil(plates.length / perRow));
    const canvas = document.createElement('canvas');
    canvas.width = perRow * CW;
    canvas.height = 2 ** Math.ceil(Math.log2(rows * CH));
    const ctx = canvas.getContext('2d')!;
    const positions = new Float32Array(plates.length * 4 * 3);
    const normals = new Float32Array(plates.length * 4 * 3);
    const uvs = new Float32Array(plates.length * 4 * 2);
    const index: number[] = [];
    plates.forEach((plate, k) => {
      const cx = (k % perRow) * CW;
      const cy = Math.floor(k / perRow) * CH;
      drawPlate(ctx, cx, cy, plate.street, plate.number);
      // Модель дома — по своему размеру (пресет с масштабом), он бывает уже прямоугольника: угол — у модели.
      const place = modelPlacement(plate.rect);
      const fit = plate.model ? fitPreset(plate.model, place.width, place.depth) : undefined;
      const half = fit ? (fit.size[0] * fit.scale[0]) / 2 : place.width / 2;
      const halfDepth = fit ? (fit.size[1] * fit.scale[1]) / 2 : place.depth / 2;
      const t: Vec2 = [Math.cos(place.angle), Math.sin(place.angle)];
      // Наружу от фасада: прямоугольник против часовой — наружная нормаль справа от a→b.
      const n: Vec2 = [t[1], -t[0]];
      // У левого (если смотреть с улицы) угла фасада.
      const along = -half + Math.min(FROM_CORNER + W / 2, half);
      const mx = place.center[0] + t[0] * along + n[0] * (halfDepth + OFF_WALL);
      const my = place.center[1] + t[1] * along + n[1] * (halfDepth + OFF_WALL);
      const floor = siteOnSlope(plate.rect, heightAt).floor;
      const z0 = floor + ABOVE_FLOOR - H / 2;
      // Вершины (локальные x, y → three: x, высота, −y): лево-низ, право-низ, право-верх, лево-верх (с улицы).
      // Глядя на фасад с улицы, «право» — по направлению a→b.
      const corners: [number, number, number][] = [
        [mx - t[0] * (W / 2), my - t[1] * (W / 2), z0],
        [mx + t[0] * (W / 2), my + t[1] * (W / 2), z0],
        [mx + t[0] * (W / 2), my + t[1] * (W / 2), z0 + H],
        [mx - t[0] * (W / 2), my - t[1] * (W / 2), z0 + H],
      ];
      const u0 = cx / canvas.width;
      const u1 = (cx + CW) / canvas.width;
      const v0 = 1 - (cy + CH) / canvas.height;
      const v1 = 1 - cy / canvas.height;
      const uv = [u0, v0, u1, v0, u1, v1, u0, v1];
      corners.forEach(([x, y, z], i) => {
        positions.set([x, z, -y], (k * 4 + i) * 3);
        normals.set([n[0], 0, -n[1]], (k * 4 + i) * 3);
        uvs.set([uv[i * 2]!, uv[i * 2 + 1]!], (k * 4 + i) * 2);
      });
      const v = k * 4;
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
      this.anchors.push({ houseId: plate.houseId, x: mx, y: my, first: v });
    });
    this.base = positions.slice();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.anisotropy = city.renderer.capabilities.getMaxAnisotropy();
    this.material = new MeshStandardMaterial({ map: this.texture, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 });
    hookMaterial(this.material, 'address-plates', undefined, csm);
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'address-plates';
    this.group.add(this.mesh);
    city.scene.add(this.group);
  }

  get count(): number {
    return this.anchors.length;
  }

  /** Земля поменялась (кисть рельефа): таблички — вместе с домами. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    const position = this.mesh.geometry.getAttribute('position') as BufferAttribute;
    let changed = false;
    for (const { x, y, first } of this.anchors) {
      if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) continue;
      const d = delta(x, y);
      if (!d) continue;
      for (let i = first; i < first + 4; i++) {
        this.base[i * 3 + 1]! += d;
        position.setY(i, position.getY(i) + d);
      }
      changed = true;
    }
    if (changed) position.needsUpdate = true;
  }

  /** Дома убраны или заменены правкой: их таблички прячутся (сжимаются в точку). */
  setHidden(ids: ReadonlySet<string>): void {
    const position = this.mesh.geometry.getAttribute('position') as BufferAttribute;
    let changed = false;
    for (const { houseId, first } of this.anchors) {
      const hide = ids.has(houseId);
      if (hide === this.hidden.has(houseId)) continue;
      for (let i = first; i < first + 4; i++) {
        const from = (hide ? first : i) * 3;
        position.setXYZ(i, this.base[from]!, this.base[from + 1]!, this.base[from + 2]!);
      }
      changed = true;
    }
    this.hidden = new Set([...ids].filter((id) => this.anchors.some((a) => a.houseId === id)));
    if (changed) {
      position.needsUpdate = true;
      this.city.requestRender();
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  destroy(): void {
    this.city.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
