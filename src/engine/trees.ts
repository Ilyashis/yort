// Деревья: несколько процедурных моделей, расставленных инстансами по плиткам.
// Отдельные деревья из OSM, парки, лес (упрощённые модели) и деревья во дворах деревни.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { World } from '../core/data';
import { centroid, pointInPoly, rng, signedArea, type P2 } from '../core/geo';
import type { RingIndex, RoadIndex } from '../core/spatial';
import type { Building } from './buildings';
import { shared } from './shared';
import type { HeightMap } from './terrain';

/** Атлас 4×2: листва, листва берёзы, хвоя сосны, еловая лапа, кора, кора берёзы, белое. */
const CELL = { leaf: 0, birchLeaf: 1, pine: 2, spruce: 3, bark: 4, birchBark: 5, white: 6 } as const;
type Cell = (typeof CELL)[keyof typeof CELL];

/** Точка ячейки атласа (u, v — 0..1 внутри ячейки, v вверх). */
function cellUv(cell: Cell, u: number, v: number): [number, number] {
  const pad = 0.012;
  const cu = pad + u * (1 - 2 * pad), cv = pad + v * (1 - 2 * pad);
  return [((cell % 4) + cu) / 4, 1 - (Math.floor(cell / 4) + 1 - cv) / 2];
}

function foliageAtlas(): CanvasTexture {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S * 4;
  canvas.height = S * 2;
  const ctx = canvas.getContext('2d')!;
  const r = rng(2024);
  const at = (cell: Cell, draw: () => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect((cell % 4) * S, Math.floor(cell / 4) * S, S, S);
    ctx.clip();
    ctx.translate((cell % 4) * S, Math.floor(cell / 4) * S);
    draw();
    ctx.restore();
  };
  // Светлота листа: текстура почти белая, сам цвет дают вершины (у каждой породы свой).
  const tone = (l: number, warm = 0) => `hsl(${88 - warm * 30}, ${14 + warm * 20}%, ${l}%)`;
  const leaves = (count: number, len: number, wid: number, spread: number, pointed: boolean) => {
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      ctx.save();
      ctx.translate(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d * 0.94);
      ctx.rotate(r() * Math.PI * 2);
      ctx.fillStyle = tone(48 + t * 38 + r() * 14, r() < 0.12 ? 0.6 : 0);
      ctx.beginPath();
      if (pointed) {
        ctx.moveTo(-len / 2, 0);
        ctx.quadraticCurveTo(0, -wid, len / 2, 0);
        ctx.quadraticCurveTo(0, wid, -len / 2, 0);
      } else ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,50,30,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.lineTo(len / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
  };
  at(CELL.leaf, () => leaves(430, 23, 13, 110, false));
  at(CELL.birchLeaf, () => leaves(520, 15, 9, 108, true));
  at(CELL.pine, () => {
    ctx.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 92;
      const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
      const l = 55 + (i / 46) * 30;
      for (let k = 0; k < 26; k++) {
        const b = r() * Math.PI * 2, len = 16 + r() * 16;
        ctx.strokeStyle = tone(l + r() * 14);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(b) * len, y + Math.sin(b) * len);
        ctx.stroke();
      }
    }
  });
  at(CELL.spruce, () => {
    // Еловая лапа: стержень снизу вверх, веточки с хвоей — клином от широкого основания к кончику.
    ctx.lineCap = 'round';
    for (let i = 0; i < 520; i++) {
      const t = Math.pow(r(), 0.8);
      const y = S - 8 - t * (S - 20);
      const half = (1 - t) * 104 + 10;
      const x = S / 2 + (r() * 2 - 1) * half;
      const out = Math.sign(x - S / 2) || 1;
      const b = -Math.PI / 2 + out * (0.5 + r() * 0.7);
      ctx.strokeStyle = tone(42 + r() * 44);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(b) * 15, y + Math.sin(b) * 15);
      ctx.stroke();
    }
  });
  at(CELL.bark, () => {
    ctx.fillStyle = '#c9c9c9';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) {
      const x = r() * S, y = r() * S, len = 20 + r() * 70;
      ctx.strokeStyle = `rgba(${r() < 0.5 ? '40,34,28' : '255,255,255'},${0.12 + r() * 0.3})`;
      ctx.lineWidth = 1 + r() * 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + (r() - 0.5) * 8, y + len * 0.3, x + (r() - 0.5) * 8, y + len * 0.6, x + (r() - 0.5) * 6, y + len);
      ctx.stroke();
    }
  });
  at(CELL.birchBark, () => {
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(0, 0, S, S);
    // Ячейка ложится на ствол один раз во всю длину, поэтому отметины — широкие и низкие.
    for (let i = 0; i < 44; i++) {
      const x = r() * S, y = 6 + r() * (S - 12), w = 24 + r() * 56;
      ctx.fillStyle = `rgba(22,20,18,${0.75 + r() * 0.25})`;
      ctx.beginPath();
      ctx.ellipse(x, y, w / 2, 1.6 + r() * 2.6, (r() - 0.5) * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  at(CELL.white, () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, S, S);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

interface Palette {
  top: string;
  bottom: string;
}

class Parts {
  /** Дальняя модель: вместо листвы на карточках — сплошные комья. */
  flat = false;
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];

  add(geometry: BufferGeometry, colour: (y: number, ny: number) => Color, uvAt: (u: number, v: number) => [number, number], sphere?: Vector3): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      let nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
      if (sphere) {
        const l = Math.hypot(x - sphere.x, y - sphere.y, z - sphere.z) || 1;
        nx = (x - sphere.x) / l;
        ny = (y - sphere.y) / l;
        nz = (z - sphere.z) / l;
      }
      const c = colour(y, ny);
      this.pos.push(x, y, z);
      this.nrm.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(...uvAt(t ? t.getX(i) : 0.5, t ? t.getY(i) : 0.5));
    }
    return this;
  }

  /** Ствол или ветка от точки к точке. */
  limb(from: [number, number, number], to: [number, number, number], r0: number, r1: number, sides: number, hex: string, cell: Cell = CELL.bark): this {
    const a = new Vector3(...from), b = new Vector3(...to);
    const length = a.distanceTo(b);
    const g = new CylinderGeometry(r1, r0, length, sides, 1, true).translate(0, length / 2, 0);
    g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize())).translate(a.x, a.y, a.z);
    const c = new Color(hex);
    return this.add(g, () => c, (u, v) => cellUv(cell, u, v));
  }

  trunk(height: number, r0: number, r1: number, sides: number, hex: string, cell: Cell = CELL.bark): this {
    return this.limb([0, 0, 0], [0, height, 0], r0, r1, sides, hex, cell);
  }

  /** Тёмная сердцевина кроны: издали крона остаётся плотной, даже когда листва на карточках редеет. */
  core(x: number, y: number, z: number, r: number, ry: number, palette: Palette, shade = 0.62): this {
    const g = new IcosahedronGeometry(1, 0);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setXYZ(i, x + p.getX(i) * r, y + p.getY(i) * r * ry, z + p.getZ(i) * r);
    // Под листвой сердцевина тёмная (цвет тени), у дальней модели — цвета самой кроны.
    const a = new Color(shade < 0.6 ? palette.bottom : palette.top).multiplyScalar(shade < 0.6 ? 1 : shade), b = new Color(palette.bottom).multiplyScalar(shade < 0.6 ? 0.75 : shade + 0.1), out = new Color();
    return this.add(g, (_y, ny) => out.copy(b).lerp(a, Math.min(1, Math.max(0, ny * 0.6 + 0.5))), () => cellUv(CELL.white, 0.5, 0.5), new Vector3(x, y - r * 0.2, z));
  }

  /** Лист-карточка: квадрат с текстурой листвы; нормали — как у шара кроны, чтобы свет ложился мягко. */
  card(centre: Vector3, normal: Vector3, size: number, roll: number, cell: Cell, palette: Palette, crown: Vector3, lift = 0.5): this {
    const side = Math.abs(normal.y) > 0.92 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const u = new Vector3().crossVectors(side, normal).normalize();
    const v = new Vector3().crossVectors(normal, u);
    const cu = u.clone().multiplyScalar(Math.cos(roll)).addScaledVector(v, Math.sin(roll));
    const cv = v.clone().multiplyScalar(Math.cos(roll)).addScaledVector(u, -Math.sin(roll));
    const a = new Color(palette.top), b = new Color(palette.bottom), out = new Color();
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const [i, j] of corners) {
      const p = centre.clone().addScaledVector(cu, (i * size) / 2).addScaledVector(cv, (j * size) / 2);
      const n = p.clone().sub(crown).normalize();
      n.y += 0.35;
      n.normalize();
      const c = out.copy(b).lerp(a, Math.min(1, Math.max(0, n.y * 0.6 + lift)));
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(...cellUv(cell, (i + 1) / 2, (j + 1) / 2));
    }
    return this;
  }

  /** Ком листвы: сердцевина и карточки по её поверхности. Снизу крона реже. */
  crown(x: number, y: number, z: number, r: number, ry: number, cell: Cell, palette: Palette, rnd: () => number, density = 1, droop = 0): this {
    const centre = new Vector3(x, y, z);
    if (this.flat) return this.core(x, y, z, r * 0.95, ry, palette, 0.82);
    const far = density < 1;
    this.core(x, y, z, r * (far ? 0.72 : 0.58), ry, palette, far ? 0.4 : 0.45);
    // Листвы столько, чтобы закрыть ком целиком: у лесных моделей карточек меньше, зато они крупнее.
    const count = far ? Math.round(20 * density) : 24;
    const size = r * (far ? 1.7 : 1.2);
    for (let i = 0; i < count; i++) {
      const dir = new Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      if (dir.lengthSq() < 0.05 || dir.lengthSq() > 1) {
        i--;
        continue;
      }
      dir.normalize();
      if (dir.y < -0.55 && rnd() < 0.7) dir.y = -dir.y;
      const k = 0.6 + rnd() * 0.4;
      const at = new Vector3(x + dir.x * r * k, y + dir.y * r * ry * k, z + dir.z * r * k);
      // Карточка смотрит наружу, но каждая со своим наклоном; у берёзы часть висит прядями вниз.
      const normal = dir.clone().multiplyScalar(0.7).add(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)).normalize();
      if (droop && rnd() < droop) {
        normal.y *= 0.15;
        normal.normalize();
        at.y -= r * 0.6;
      }
      this.card(at, normal, size * (0.8 + rnd() * 0.45), rnd() * Math.PI * 2, cell, palette, centre.clone().setY(y - r * 0.25));
    }
    return this;
  }

  /** Ярус еловых лап: карточки расходятся от ствола и свисают. */
  tier(y: number, length: number, count: number, turn: number, palette: Palette, rnd: () => number): this {
    if (this.flat) return this;
    for (let k = 0; k < count; k++) {
      const a = turn + (k / count) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
      const out = new Vector3(Math.cos(a), 0, Math.sin(a));
      const drop = 0.32 + rnd() * 0.16;
      const along = out.clone().setY(-drop).normalize();
      const across = new Vector3(-out.z, 0, out.x);
      const half = length * 0.42;
      const base = new Vector3(0, y, 0).addScaledVector(out, 0.05);
      const tip = base.clone().addScaledVector(along, length);
      const top = new Color(palette.top), bottom = new Color(palette.bottom);
      // Основание лапы — у ствола (низ ячейки), кончик — снаружи.
      const quad: [Vector3, number, number, Color][] = [
        [base.clone().addScaledVector(across, -half), 0, 0, bottom], [base.clone().addScaledVector(across, half), 1, 0, bottom],
        [tip.clone().addScaledVector(across, half), 1, 1, top], [tip.clone().addScaledVector(across, -half), 0, 1, top],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [p, u, v, c] = quad[i];
        const n = out.clone().multiplyScalar(0.55).setY(0.85).normalize();
        this.pos.push(p.x, p.y, p.z);
        this.nrm.push(n.x, n.y, n.z);
        this.col.push(c.r, c.g, c.b);
        this.uv.push(...cellUv(CELL.spruce, u, v));
      }
    }
    return this;
  }

  cone(y: number, r: number, h: number, sides: number, palette: Palette): this {
    const k = this.flat ? 1.5 : 1;
    const a = new Color(palette.top).multiplyScalar(0.55 * k), b = new Color(palette.bottom).multiplyScalar(0.7 * k), out = new Color();
    return this.add(new ConeGeometry(r * (this.flat ? 2.2 : 1), h, sides, 1, true).translate(0, y + h / 2, 0), (yy) => out.copy(b).lerp(a, (yy - y) / h), () => cellUv(CELL.white, 0.5, 0.5));
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    return g;
  }
}

type Species = 'leaf' | 'birch' | 'pine' | 'spruce' | 'leafLow' | 'birchLow' | 'pineLow';

function models(flat: boolean): Record<Species, BufferGeometry> {
  const r = rng(77);
  const make = () => Object.assign(new Parts(), { flat });
  const G: Palette = { top: '#6f9a3c', bottom: '#2a4a1c' };
  const B: Palette = { top: '#9aba4c', bottom: '#4b6f2c' };
  const P: Palette = { top: '#3f6c48', bottom: '#162f22' };
  const S: Palette = { top: '#4a7446', bottom: '#19301f' };
  const BARK = '#5a4838', PINE_BARK = '#c57c44', WHITE = '#ffffff';

  const leaf = make().trunk(3.1, 0.27, 0.17, 7, BARK)
    .limb([0, 2.5, 0], [1.4, 4.3, 0.5], 0.13, 0.06, 5, BARK).limb([0, 2.7, 0], [-1.2, 4.5, -0.8], 0.13, 0.06, 5, BARK)
    .limb([0, 2.9, 0], [-0.3, 4.3, 1.4], 0.12, 0.05, 5, BARK).limb([0, 3.0, 0], [0.1, 5.2, -0.2], 0.15, 0.07, 5, BARK)
    .crown(0, 5.2, 0, 2.4, 0.9, CELL.leaf, G, r).crown(1.6, 4.4, 0.6, 1.8, 0.85, CELL.leaf, G, r)
    .crown(-1.4, 4.6, -0.9, 1.8, 0.85, CELL.leaf, G, r).crown(0.2, 6.6, -0.3, 1.7, 0.9, CELL.leaf, G, r)
    .crown(-0.4, 4.3, 1.6, 1.6, 0.85, CELL.leaf, G, r);

  // Берёза: тонкий белый ствол с чёрными отметинами, тёмный у земли; узкая высокая крона, пряди свисают.
  const birch = make().limb([0, 0, 0], [0, 0.7, 0], 0.2, 0.17, 6, '#4a4540')
    .limb([0, 0.6, 0], [0.06, 4.6, 0.04], 0.17, 0.1, 6, WHITE, CELL.birchBark).limb([0.06, 4.6, 0.04], [0.15, 8.8, 0.1], 0.1, 0.025, 5, WHITE, CELL.birchBark)
    .limb([0.04, 3.3, 0], [1.0, 4.6, 0.4], 0.05, 0.02, 4, WHITE, CELL.birchBark).limb([0.04, 3.9, 0], [-0.9, 5.3, -0.5], 0.05, 0.02, 4, WHITE, CELL.birchBark)
    .limb([0.06, 4.8, 0], [0.3, 6.1, 1.0], 0.045, 0.02, 4, WHITE, CELL.birchBark).limb([0.08, 5.6, 0], [-0.6, 6.9, 0.7], 0.04, 0.02, 4, WHITE, CELL.birchBark)
    .crown(0.5, 4.5, 0.2, 1.2, 1.05, CELL.birchLeaf, B, r, 1, 0.55).crown(-0.5, 5.3, -0.3, 1.25, 1.05, CELL.birchLeaf, B, r, 1, 0.55)
    .crown(0.2, 6.3, 0.5, 1.2, 1.05, CELL.birchLeaf, B, r, 1, 0.5).crown(-0.2, 7.3, 0.1, 1.05, 1.1, CELL.birchLeaf, B, r, 1, 0.4)
    .crown(0.12, 8.4, 0.1, 0.8, 1.2, CELL.birchLeaf, B, r, 1, 0.25);

  // Сосна: высокий голый ствол — серо-бурый снизу, рыжий выше; крона зонтиком на самом верху.
  const pine = make().limb([0, 0, 0], [0.05, 3.6, 0], 0.26, 0.2, 7, '#7d604a').limb([0.05, 3.6, 0], [0.2, 9.8, -0.1], 0.2, 0.08, 7, PINE_BARK)
    .limb([0.06, 4.2, 0], [0.7, 4.5, 0.3], 0.035, 0.015, 3, '#5a4a40').limb([0.1, 5.3, 0], [-0.6, 5.5, -0.4], 0.035, 0.015, 3, '#5a4a40')
    .limb([0.14, 7.0, 0], [1.7, 7.7, 0.4], 0.08, 0.035, 4, PINE_BARK).limb([0.15, 7.5, 0], [-1.5, 8.2, -0.7], 0.08, 0.035, 4, PINE_BARK)
    .limb([0.17, 8.0, 0], [0.3, 8.7, 1.5], 0.07, 0.03, 4, PINE_BARK).limb([0.18, 8.5, 0], [-0.2, 9.1, -1.4], 0.07, 0.03, 4, PINE_BARK)
    .crown(1.7, 7.9, 0.4, 1.25, 0.55, CELL.pine, P, r).crown(-1.5, 8.4, -0.7, 1.3, 0.55, CELL.pine, P, r)
    .crown(0.3, 8.9, 1.5, 1.15, 0.55, CELL.pine, P, r).crown(-0.2, 9.3, -1.4, 1.1, 0.55, CELL.pine, P, r)
    .crown(0.9, 9.5, -0.4, 1.2, 0.55, CELL.pine, P, r).crown(0.2, 10.2, 0.1, 1.55, 0.6, CELL.pine, P, r);

  const spruce = make().trunk(8.6, 0.2, 0.03, 6, BARK).cone(1.0, 1.0, 7.8, 7, S);
  for (let k = 0; k < 9; k++) spruce.tier(1.5 + k * 0.82, 2.9 * (1 - k / 10.5) + 0.25, k < 6 ? 7 : 5, k * 0.7, S, r);
  spruce.tier(8.75, 0.75, 4, 0.3, S, r);

  return {
    leaf: leaf.build(),
    birch: birch.build(),
    pine: pine.build(),
    spruce: spruce.build(),
    leafLow: make().trunk(3, 0.24, 0.16, 4, BARK)
      .crown(0, 5, 0, 2.5, 0.95, CELL.leaf, G, r, 0.45).crown(0.9, 6.2, 0.4, 1.6, 0.9, CELL.leaf, G, r, 0.45).build(),
    birchLow: make().trunk(7.6, 0.16, 0.04, 4, WHITE, CELL.birchBark)
      .crown(0, 5.4, 0, 1.3, 1.5, CELL.birchLeaf, B, r, 0.55, 0.4).crown(0.1, 7.6, 0.1, 0.95, 1.4, CELL.birchLeaf, B, r, 0.55, 0.3).build(),
    pineLow: make().limb([0, 0, 0], [0, 3.4, 0], 0.24, 0.19, 4, '#7d604a').limb([0, 3.4, 0], [0.1, 9.2, 0], 0.19, 0.08, 4, PINE_BARK)
      .crown(0.1, 9.4, 0, 2.0, 0.5, CELL.pine, P, r, 0.45).crown(1.0, 8.3, 0.3, 1.2, 0.5, CELL.pine, P, r, 0.45).crown(-0.9, 8.6, -0.5, 1.1, 0.5, CELL.pine, P, r, 0.45).build(),
  };
}

interface Tree {
  x: number;
  z: number;
  s: number;
  species: Species;
}

export interface TreeContext {
  world: World;
  hm: HeightMap;
  roads: RoadIndex;
  paths: RoadIndex;
  footprints: RingIndex;
  buildings: readonly Building[];
  /** Места, где деревьев быть не должно: [x, z, радиус]. */
  clearings: [number, number, number][];
  /** Деревья участков «обустроенного посёлка» — вместо случайных у домов. */
  yardTrees?: P2[];
}

function scatter(ctx: TreeContext): Tree[] {
  const { world, roads, paths, footprints } = ctx;
  const rnd = rng(world.territory.id.length * 7919 + 13);
  const trees: Tree[] = [];
  const free = (x: number, z: number, margin: number) =>
    footprints.find(x, z) < 0 && !roads.onRoad(x, z, margin) && !paths.onRoad(x, z, 0.8) &&
    !ctx.clearings.some((c) => Math.hypot(x - c[0], z - c[1]) < c[2]);
  const choose = (list: [Species, number][]): Species => {
    let t = rnd();
    for (const [s, w] of list) if ((t -= w) <= 0) return s;
    return list[0][0];
  };

  for (const [x, z] of world.trees) trees.push({ x, z, s: 0.85 + rnd() * 0.5, species: choose([['birch', 0.45], ['leaf', 0.35], ['pine', 0.2]]) });

  const blocked = world.ground.filter((g) => g.kind === 'pitch' || g.kind === 'water' || g.kind === 'parking');
  const inBlocked = (x: number, z: number) => blocked.some((g) => pointInPoly(x, z, g.rings));
  const woods = world.ground.filter((g) => g.kind === 'green' && g.cover === 'wood');
  const woodArea = woods.reduce((s, g) => s + signedArea(g.rings[0]), 0);
  const woodStep = Math.max(9, Math.sqrt(woodArea / 46_000));

  for (const g of world.ground) {
    if (g.kind !== 'green' || g.cover === 'meadow') continue;
    const wood = g.cover === 'wood';
    const step = wood ? woodStep : 12;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of g.rings[0]) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
      for (let gz = Math.floor(z0 / step) * step; gz <= z1; gz += step) {
        if (!wood && rnd() > 0.62) continue;
        const x = gx + rnd() * step * 0.9, z = gz + rnd() * step * 0.9;
        if (!pointInPoly(x, z, g.rings) || !free(x, z, wood ? 3 : 1.5) || (!wood && inBlocked(x, z))) continue;
        trees.push(
          wood
            ? { x, z, s: 1 + rnd() * 0.9, species: choose([['birchLow', 0.5], ['pineLow', 0.44], ['leafLow', 0.06]]) }
            : { x, z, s: 0.8 + rnd() * 0.7, species: choose([['birch', 0.42], ['pine', 0.26], ['leaf', 0.2], ['spruce', 0.12]]) },
        );
      }
    }
  }

  if (ctx.yardTrees) {
    for (const [x, z] of ctx.yardTrees) {
      if (footprints.find(x, z) >= 0) continue;
      const birch = rnd() < 0.3;
      trees.push({ x, z, s: birch ? 0.8 + rnd() * 0.4 : 0.42 + rnd() * 0.22, species: birch ? 'birch' : 'leaf' });
    }
  } else if (world.territory.kind === 'village') {
    for (const b of ctx.buildings) {
      if (b.layout !== 3) continue;
      const c = centroid(b.rings[0]);
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, d = b.box.L + 3 + rnd() * 9;
        const x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
        if (!free(x, z, 2.5)) continue;
        const small = rnd() < 0.4;
        trees.push({ x, z, s: small ? 0.45 + rnd() * 0.2 : 0.75 + rnd() * 0.5, species: small ? 'leaf' : choose([['birch', 0.55], ['pine', 0.25], ['leaf', 0.12], ['spruce', 0.08]]) });
      }
    }
  }
  return trees;
}

export function createTrees(ctx: TreeContext): { group: Group; count: number; update: (camera: { position: Vector3 }) => void; reseat: (area: { x0: number; z0: number; x1: number; z1: number }) => void; dispose: () => void } {
  const trees = scatter(ctx);
  const geometries = models(false);
  const distant = models(true);
  const atlas = foliageAtlas();
  const material = new MeshStandardMaterial({ vertexColors: true, map: atlas, alphaTest: 0.4, alphaToCoverage: true, side: DoubleSide, roughness: 0.86, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.17;
        float sway = sin(uTime * 1.5 + ph) * 0.03 + sin(uTime * 2.6 + ph * 1.7) * 0.018;
        float hgt = max(transformed.y - 1.5, 0.0);
        transformed.x += sway * hgt * 0.6;
        transformed.z += sway * hgt * 0.35;
        // Листва ещё и трепещет сама по себе.
        float flutter = sin(uTime * 3.4 + ph + position.x * 4.1 + position.y * 5.3 + position.z * 3.7);
        transformed += normal * flutter * 0.035 * step(2.2, position.y);
      #endif`,
    );
    // Лист освещён одинаково с обеих сторон: нормаль кроны, а не изнанки карточки.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
      // Вдали мелкие уровни текстуры «съедают» листву — возвращаем ей плотность.
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        {
          vec2 px = vMapUv * vec2(1024.0, 512.0);
          float lod = max(0.0, 0.5 * log2(max(dot(dFdx(px), dFdx(px)), dot(dFdy(px), dFdy(px)))));
          diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.45 * lod));
        }`,
      );
  };

  const TILE = 256;
  /** Дальше этого (до середины плитки) деревья рисуются упрощёнными. */
  const DETAIL = 300;
  const buckets = new Map<string, Tree[]>();
  for (const t of trees) {
    const key = `${t.species}|${Math.floor(t.x / TILE)}|${Math.floor(t.z / TILE)}`;
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }

  const group = new Group();
  group.name = 'trees';
  const placed: { mesh: InstancedMesh; list: Tree[]; species: Species }[] = [];
  const m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), pos = new Vector3(), scale = new Vector3(), tint = new Color();
  const rnd = rng(4242);
  for (const [key, list] of buckets) {
    const species = key.split('|')[0] as Species;
    const mesh = new InstancedMesh(geometries[species], material, list.length);
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const wide = t.s * (0.85 + rnd() * 0.3);
      m.compose(pos.set(t.x, ctx.hm.at(t.x, t.z) - 0.15, t.z), q, scale.set(wide, t.s, wide));
      mesh.setMatrixAt(i, m);
      const v = 0.82 + rnd() * 0.36;
      mesh.setColorAt(i, tint.setRGB(v * (0.95 + rnd() * 0.15), v, v * (0.9 + rnd() * 0.15)));
    });
    placed.push({ mesh, list, species });
    const hero = !species.endsWith('Low');
    mesh.castShadow = hero;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return {
    group,
    count: trees.length,
    update: (camera) => {
      for (const { mesh, species } of placed) {
        const c = mesh.boundingSphere!.center;
        const far = Math.hypot(c.x - camera.position.x, c.z - camera.position.z) > DETAIL;
        const geometry = (far ? distant : geometries)[species];
        if (mesh.geometry !== geometry) mesh.geometry = geometry;
      }
    },
    reseat: (area) => {
      for (const { mesh, list } of placed) {
        let changed = false;
        list.forEach((t, i) => {
          if (t.x < area.x0 || t.x > area.x1 || t.z < area.z0 || t.z > area.z1) return;
          mesh.getMatrixAt(i, m);
          m.elements[13] = ctx.hm.at(t.x, t.z) - 0.15;
          mesh.setMatrixAt(i, m);
          changed = true;
        });
        if (changed) mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose: () => {
      [...Object.values(geometries), ...Object.values(distant)].forEach((g) => g.dispose());
      material.dispose();
      atlas.dispose();
      group.children.forEach((c) => (c as InstancedMesh).dispose());
    },
  };
}
