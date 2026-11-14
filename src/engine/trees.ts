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

/** Атлас 4×2 (ячейки 0 и 2 свободны): листва берёзы, еловая лапа, кора, кора берёзы, белое. */
const CELL = { birchLeaf: 1, spruce: 3, bark: 4, birchBark: 5, white: 6 } as const;
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
  at(CELL.birchLeaf, () => leaves(520, 15, 9, 108, true));
  at(CELL.spruce, () => {
    // Еловая лапа: стержень снизу вверх, веточки с хвоей — клином от широкого основания к кончику.
    ctx.lineCap = 'round';
    for (let i = 0; i < 900; i++) {
      const t = Math.pow(r(), 0.8);
      const y = S - 8 - t * (S - 20);
      const half = (1 - t) * 104 + 10;
      const x = S / 2 + (r() * 2 - 1) * half;
      const out = Math.sign(x - S / 2) || 1;
      const b = -Math.PI / 2 + out * (0.5 + r() * 0.7);
      ctx.strokeStyle = tone(40 + r() * 48);
      ctx.lineWidth = 2.6;
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
      n.y += 0.7;
      n.normalize();
      const c = out.copy(b).lerp(a, Math.min(1, Math.max(0, n.y * 0.6 + lift)));
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(...cellUv(cell, (i + 1) / 2, (j + 1) / 2));
    }
    return this;
  }

  /**
   * Крона одним объёмом: листва на карточках по яйцевидной форме вокруг ствола (самое широкое место — ниже
   * середины, кверху сужается), внутри узкая тёмная сердцевина, чтобы крона не просвечивала насквозь.
   */
  canopy(y0: number, y1: number, radius: number, cell: Cell, palette: Palette, rnd: () => number, count: number, size: number, droop: number): this {
    const mid = (y0 + y1) / 2, half = (y1 - y0) / 2;
    const profile = (t: number) => radius * Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.pow(t, 0.72))));
    const egg = (r: number, shade: number) => {
      // Дальняя модель и сердцевина лесной — самые грубые: таких деревьев десятки тысяч.
      const g = new IcosahedronGeometry(1, this.flat || count <= 40 ? 0 : 1);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) + 1) / 2;
        const k = (profile(Math.min(0.97, Math.max(0.03, t))) / radius) * r;
        const flat = Math.hypot(p.getX(i), p.getZ(i)) || 1;
        p.setXYZ(i, (p.getX(i) / flat) * k * Math.min(1, flat * 1.6), y0 + t * (y1 - y0), (p.getZ(i) / flat) * k * Math.min(1, flat * 1.6));
      }
      // Под листвой сердцевина — цвета тени, целиком тёмная; у дальней модели она и есть крона.
      const top = new Color(shade < 0.6 ? palette.bottom : palette.top).multiplyScalar(shade < 0.6 ? 0.42 : shade), bottom = new Color(palette.bottom).multiplyScalar(shade < 0.6 ? 0.32 : shade), out = new Color();
      this.add(g, (_y, ny) => out.copy(bottom).lerp(top, Math.min(1, Math.max(0, ny * 0.6 + 0.5))), () => cellUv(CELL.white, 0.5, 0.5), new Vector3(0, mid - half * 0.3, 0));
    };
    if (this.flat) {
      egg(radius * 0.95, 0.85);
      return this;
    }
    egg(radius * 0.36, 0.42);
    const centre = new Vector3(0, mid - half * 0.25, 0);
    for (let i = 0; i < count; i++) {
      const t = 0.04 + 0.94 * (i + rnd()) / count;
      const a = rnd() * Math.PI * 2;
      const r = profile(t) * (0.3 + 0.7 * Math.sqrt(rnd()));
      const at = new Vector3(Math.cos(a) * r, y0 + t * (y1 - y0), Math.sin(a) * r);
      const normal = new Vector3(Math.cos(a), (t - 0.45) * 0.9, Math.sin(a)).multiplyScalar(0.8).add(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)).normalize();
      // Нижние пряди берёзы висят: карточка стоит вертикально и опущена.
      if (rnd() < droop * (1.2 - t)) {
        normal.y *= 0.12;
        normal.normalize();
        at.y -= size * 0.45;
      }
      this.card(at, normal, size * (0.75 + rnd() * 0.5), rnd() * Math.PI * 2, cell, palette, centre);
    }
    return this;
  }

  /**
   * Шапка листвы на конце ветки: шар из карточек вокруг centre (чуть приплюснутый) с тёмной сердцевиной.
   * Из нескольких шапок крона получается неровной и «кустистой», а не одним яйцом. droop — доля прядей,
   * свисающих вниз (берёза).
   */
  clump(centre: Vector3, radius: number, count: number, size: number, palette: Palette, rnd: () => number, droop = 0, cell: Cell = CELL.birchLeaf): this {
    const squash = 0.78;
    const core = (r: number, shade: number) => {
      const g = new IcosahedronGeometry(r, 0).scale(1, squash, 1).translate(centre.x, centre.y, centre.z);
      const top = new Color(palette.top).multiplyScalar(shade), bottom = new Color(palette.bottom).multiplyScalar(shade * 0.75), out = new Color();
      this.add(g, (_y, ny) => out.copy(bottom).lerp(top, Math.min(1, Math.max(0, ny * 0.6 + 0.5))), () => cellUv(CELL.white, 0.5, 0.5), centre);
    };
    if (this.flat) {
      core(radius * 0.92, 0.9);
      return this;
    }
    core(radius * 0.5, 0.45);
    for (let i = 0; i < count; i++) {
      // Равномерно по сфере (золотая спираль) с разбросом; низ шапки реже — там тень.
      const k = (i + 0.5) / count;
      const y = 1 - 2 * k * (0.85 + rnd() * 0.15);
      const a = i * 2.39996 + rnd() * 0.6;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const dir = new Vector3(Math.cos(a) * rr, y * squash, Math.sin(a) * rr);
      const at = centre.clone().addScaledVector(dir, radius * (0.55 + rnd() * 0.45));
      const normal = dir.clone().add(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.7)).normalize();
      if (rnd() < droop * (0.6 - y * 0.4)) {
        normal.y *= 0.1;
        normal.normalize();
        at.y -= size * 0.55;
      }
      this.card(at, normal, size * (0.7 + rnd() * 0.55), rnd() * Math.PI * 2, cell, palette, centre, 0.42);
    }
    return this;
  }

  /**
   * Лиственное дерево: ствол, ветви вверх-наружу и шапки листвы на их концах. o.lobes — сколько шапок,
   * o.spread — как далеко от ствола, o.lean — наклон ствола; кроны разные по зерну rnd.
   */
  broadleaf(o: {
    trunkH: number; trunkR: number; bark: string; barkCell?: Cell; top: number; lobes: number; spread: number; lobeR: number;
    cards: number; size: number; palette: Palette; droop: number; lean: number; rnd: () => number; base?: string;
  }): this {
    const { rnd } = o;
    const leanA = rnd() * Math.PI * 2;
    const lean = new Vector3(Math.cos(leanA) * o.lean, 0, Math.sin(leanA) * o.lean);
    const trunkTop = new Vector3(lean.x * o.trunkH, o.trunkH, lean.z * o.trunkH);
    if (o.base) this.limb([0, 0, 0], [0, 0.6, 0], o.trunkR * 1.1, o.trunkR, 6, o.base);
    this.limb(o.base ? [0, 0.55, 0] : [0, 0, 0], [trunkTop.x, trunkTop.y, trunkTop.z], o.trunkR, o.trunkR * 0.55, this.flat ? 4 : 6, o.bark, o.barkCell);
    // Вершина продолжает ствол.
    const apex = new Vector3(trunkTop.x * 1.3, o.top - o.lobeR * 0.8, trunkTop.z * 1.3);
    this.limb([trunkTop.x, trunkTop.y, trunkTop.z], [apex.x, apex.y, apex.z], o.trunkR * 0.55, o.trunkR * 0.2, this.flat ? 3 : 5, o.bark, o.barkCell);
    const lobes: Vector3[] = [apex];
    for (let k = 1; k < o.lobes; k++) {
      const t = k / o.lobes;
      const a = k * 2.39996 + rnd() * 0.7;
      const h = o.trunkH + (o.top - o.lobeR - o.trunkH) * (0.15 + 0.8 * (1 - t) * (0.6 + rnd() * 0.4));
      const reach = o.spread * (0.55 + rnd() * 0.45) * (0.7 + 0.3 * t);
      const end = new Vector3(Math.cos(a) * reach + lean.x * h, h, Math.sin(a) * reach + lean.z * h);
      // Ветка — от ствола (чуть ниже шапки) к шапке.
      const fromY = Math.min(h - 0.4, o.trunkH + (h - o.trunkH) * 0.35);
      const from = new Vector3(lean.x * fromY, fromY, lean.z * fromY);
      if (!this.flat) this.limb([from.x, from.y, from.z], [end.x * 0.8, end.y - o.lobeR * 0.2, end.z * 0.8], o.trunkR * 0.42, o.trunkR * 0.15, 4, o.bark, o.barkCell);
      lobes.push(end);
    }
    for (const c of lobes) {
      const r = o.lobeR * (0.8 + rnd() * 0.4);
      this.clump(c, r, Math.max(6, Math.round((o.cards / o.lobes) * (r / o.lobeR) ** 2)), o.size, o.palette, rnd, o.droop);
    }
    return this;
  }

  /** Ярус еловых лап: карточки расходятся от ствола, свисают и перекрывают друг друга. */
  tier(y: number, length: number, count: number, turn: number, palette: Palette, rnd: () => number): this {
    if (this.flat) return this;
    for (let k = 0; k < count; k++) {
      const a = turn + (k / count) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
      const out = new Vector3(Math.cos(a), 0, Math.sin(a));
      const reach = length * (0.82 + rnd() * 0.3);
      const along = out.clone().setY(-(0.34 + rnd() * 0.2)).normalize();
      const across = new Vector3(-out.z, 0, out.x);
      const half = reach * 0.5;
      const base = new Vector3(0, y + (rnd() - 0.5) * 0.25, 0);
      const tip = base.clone().addScaledVector(along, reach);
      const top = new Color(palette.top).multiplyScalar(0.85 + rnd() * 0.3), bottom = new Color(palette.bottom);
      // Основание лапы — у ствола (низ ячейки), кончик — снаружи; лапа чуть выгнута «домиком».
      const quad: [Vector3, number, number, Color][] = [
        [base.clone().addScaledVector(across, -half).setY(base.y - reach * 0.12), 0, 0, bottom], [base.clone().addScaledVector(across, half).setY(base.y - reach * 0.12), 1, 0, bottom],
        [tip.clone().addScaledVector(across, half * 0.9), 1, 1, top], [tip.clone().addScaledVector(across, -half * 0.9), 0, 1, top],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [p, u, v, c] = quad[i];
        const n = out.clone().multiplyScalar(0.6).setY(0.8).normalize();
        this.pos.push(p.x, p.y, p.z);
        this.nrm.push(n.x, n.y, n.z);
        this.col.push(c.r, c.g, c.b);
        this.uv.push(...cellUv(CELL.spruce, u, v));
      }
    }
    return this;
  }

  /** Ель целиком: ствол, тёмный конус внутри, ярусы лап от земли до макушки и острая верхушка. */
  spruce(height: number, radius: number, tiers: number, perTier: number, palette: Palette, bark: string, rnd: () => number): this {
    this.trunk(height * 0.96, radius * 0.075, 0.02, this.flat ? 4 : 6, bark);
    const skirt = height * 0.1;
    const cone = (r: number, shade: number) => {
      const a = new Color(palette.top).multiplyScalar(shade), b = new Color(palette.bottom).multiplyScalar(shade), out = new Color();
      this.add(new ConeGeometry(r, height - skirt, this.flat ? 7 : 8, 1, true).translate(0, skirt + (height - skirt) / 2, 0), (y) => out.copy(b).lerp(a, (y - skirt) / (height - skirt)), () => cellUv(CELL.white, 0.5, 0.5));
    };
    if (this.flat) {
      cone(radius * 0.86, 1.25);
      return this;
    }
    cone(radius * 0.3, 0.42);
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      // Лапы короче кверху, ярусы наверху чаще.
      this.tier(skirt + 0.35 + (height - skirt - 0.9) * Math.pow(t, 0.9), radius * (1 - t * 0.9) + 0.15, Math.max(4, Math.round(perTier * (1 - t * 0.45))), k * 0.83, palette, rnd);
    }
    // Макушка: две вертикальные карточки крест-накрест.
    for (const a of [0.4, 0.4 + Math.PI / 2]) {
      const across = new Vector3(Math.cos(a), 0, Math.sin(a));
      const base = height - 1.5, w = 0.55;
      const c = new Color(palette.top);
      const quad: [Vector3, number, number][] = [
        [new Vector3(0, base, 0).addScaledVector(across, -w), 0, 0], [new Vector3(0, base, 0).addScaledVector(across, w), 1, 0],
        [new Vector3(0, height + 0.25, 0).addScaledVector(across, w * 0.9), 1, 1], [new Vector3(0, height + 0.25, 0).addScaledVector(across, -w * 0.9), 0, 1],
      ];
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [p, u, v] = quad[i];
        this.pos.push(p.x, p.y, p.z);
        this.nrm.push(0, 1, 0);
        this.col.push(c.r, c.g, c.b);
        this.uv.push(...cellUv(CELL.spruce, u, v));
      }
    }
    return this;
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

type Species = 'birch' | 'spruce' | 'birchLow' | 'spruceLow' | 'apple' | 'linden';

/** Сколько вариантов у каждой породы: соседние деревья — не копии друг друга. */
const VARIANTS = 3;

function models(flat: boolean): Record<Species, BufferGeometry[]> {
  const make = () => Object.assign(new Parts(), { flat });
  const B: Palette = { top: '#a3c257', bottom: '#4f7a2f' };
  const S: Palette = { top: '#5a8a55', bottom: '#1d3524' };
  const BARK = '#4c3d30', WHITE = '#ffffff';
  const list = <T,>(f: (r: () => number, v: number) => T): T[] => Array.from({ length: VARIANTS }, (_, v) => f(rng(77 + v * 131), v));

  return {
    // Берёза: тонкий белый ствол (тёмный у земли), ажурная крона из нескольких шапок, нижние пряди свисают.
    birch: list((r) =>
      make().broadleaf({ trunkH: 3.6 + r() * 0.8, trunkR: 0.17, bark: WHITE, barkCell: CELL.birchBark, base: '#4a4540', top: 9.4 + r() * 0.6, lobes: 7, spread: 1.8, lobeR: 1.35, cards: 150, size: 1.35, palette: B, droop: 0.7, lean: 0.03 + r() * 0.04, rnd: r }).build(),
    ),
    spruce: list((r, v) => make().spruce(10.2, 2.9 + v * 0.25, 19, 13, S, BARK, r).build()),
    birchLow: list((r) => make().trunk(8.4, 0.16, 0.035, 4, WHITE, CELL.birchBark).canopy(3.0, 9.2, 1.9, CELL.birchLeaf, B, r, 18, 2.6, 0.6).build()),
    spruceLow: list((r) => make().spruce(10.0, 2.8, 5, 5, S, BARK, r).build()),
    // Яблоня: короткий кривой ствол, низкая раскидистая крона из шапок.
    apple: list((r) =>
      make().broadleaf({ trunkH: 1.2 + r() * 0.3, trunkR: 0.12, bark: '#5a4a3c', top: 4.3 + r() * 0.4, lobes: 5, spread: 1.5, lobeR: 1.05, cards: 80, size: 1.05, palette: { top: '#82a847', bottom: '#3f6a2b' }, droop: 0.05, lean: 0.08 + r() * 0.06, rnd: r }).build(),
    ),
    // Липа: прямой тёмный ствол, густой высокий купол.
    linden: list((r) =>
      make().broadleaf({ trunkH: 3.6 + r() * 0.6, trunkR: 0.27, bark: '#3f3832', top: 11.6 + r() * 0.8, lobes: 9, spread: 2.6, lobeR: 2.0, cards: 220, size: 1.6, palette: { top: '#8ab14b', bottom: '#3e6a2c' }, droop: 0.12, lean: 0.015, rnd: r }).build(),
    ),
  };
}

/** Вариант модели по месту дерева — устойчиво, без генератора случайных чисел. */
const variantAt = (x: number, z: number) => Math.abs(Math.floor(x * 7.31) * 73856093 ^ Math.floor(z * 5.17) * 19349663) % VARIANTS;

interface Tree {
  x: number;
  z: number;
  s: number;
  /** Ширина кроны относительно высоты (1 — как у модели); нет — случайная. */
  wide?: number;
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

  // Настоящие деревья по своей съёмке: место, высота и ширина кроны — как в жизни. В лесу — упрощённые модели.
  const forests = world.ground.filter((g) => g.kind === 'green' && g.cover === 'wood');
  for (const t of world.surveyTrees) {
    if (footprints.find(t.x, t.z) >= 0) continue;
    const dense = t.dense ?? forests.some((g) => pointInPoly(t.x, t.z, g.rings));
    // Модели: берёза — 9,6 м высотой и 2 м радиусом, ель — 10,2 и 2,9 м.
    const s = Math.min(2.6, Math.max(0.25, t.height / (t.spruce ? 10.2 : 9.6)));
    const wide = Math.min(1.7, Math.max(t.spruce ? 0.8 : 0.65, t.radius / (t.spruce ? 2.9 : 2.0) / s));
    trees.push({ x: t.x, z: t.z, s, wide, species: t.spruce ? (dense ? 'spruceLow' : 'spruce') : dense ? 'birchLow' : 'birch' });
  }
  /** Здесь съёмка уже показала, где деревья есть, а где нет — наугад не сажаем. */
  const known = (x: number, z: number) => world.surveyTrees.length > 0 && world.surveyed(x, z);

  for (const [x, z] of world.trees) trees.push({ x, z, s: 0.85 + rnd() * 0.5, species: choose([['birch', 0.68], ['spruce', 0.32]]) });

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
        if (known(x, z) || !pointInPoly(x, z, g.rings) || !free(x, z, wood ? 3 : 1.5) || (!wood && inBlocked(x, z))) continue;
        trees.push(
          wood
            ? { x, z, s: 1 + rnd() * 0.9, species: choose([['birchLow', 0.62], ['spruceLow', 0.38]]) }
            : { x, z, s: 0.8 + rnd() * 0.7, species: choose([['birch', 0.62], ['spruce', 0.38]]) },
        );
      }
    }
  }

  if (ctx.yardTrees) {
    for (const [x, z] of ctx.yardTrees) {
      if (known(x, z) || footprints.find(x, z) >= 0) continue;
      const birch = rnd() < 0.3;
      trees.push({ x, z, s: birch ? 0.8 + rnd() * 0.4 : 0.4 + rnd() * 0.22, species: birch || rnd() < 0.7 ? 'birch' : 'spruce' });
    }
  } else if (world.territory.kind === 'village') {
    for (const b of ctx.buildings) {
      if (b.layout !== 3) continue;
      const c = centroid(b.rings[0]);
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2, d = b.box.L + 3 + rnd() * 9;
        const x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
        if (known(x, z) || !free(x, z, 2.5)) continue;
        const small = rnd() < 0.4;
        trees.push({ x, z, s: small ? 0.45 + rnd() * 0.2 : 0.75 + rnd() * 0.5, species: choose([['birch', 0.72], ['spruce', 0.28]]) });
      }
    }
  }
  return trees;
}

/** Своё дерево из правок: место (мир, м), порода, масштаб. */
export interface OwnTree {
  id: string;
  x: number;
  z: number;
  species: 'birch' | 'spruce' | 'apple' | 'linden';
  s: number;
}

export interface TreesLayer {
  group: Group;
  count: number;
  update: (camera: { position: Vector3 }) => void;
  reseat: (area: { x0: number; z0: number; x1: number; z1: number }) => void;
  /** Свои деревья — пересобрать целиком (их немного). */
  setOwn: (trees: readonly OwnTree[]) => void;
  /** Деревья с карты, убранные ластиком: в этих кругах [x, z, r] не рисовать. */
  setCleared: (circles: readonly [number, number, number][]) => void;
  /** Свои деревья для выбора: id и точка в середине кроны (мир). */
  ownCrowns: () => { id: string; x: number; y: number; z: number }[];
  dispose: () => void;
}

export function createTrees(ctx: TreeContext): TreesLayer {
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
  const DETAIL = 220;
  const buckets = new Map<string, Tree[]>();
  for (const t of trees) {
    const key = `${t.species}|${variantAt(t.x, t.z)}|${Math.floor(t.x / TILE)}|${Math.floor(t.z / TILE)}`;
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }

  const group = new Group();
  group.name = 'trees';
  const placed: { mesh: InstancedMesh; list: Tree[]; species: Species; variant: number; hidden: boolean[]; saved: (Matrix4 | undefined)[] }[] = [];
  const ownMeshes: InstancedMesh[] = [];
  let own: readonly OwnTree[] = [];
  const mesh0 = new Matrix4();
  const m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), pos = new Vector3(), scale = new Vector3(), tint = new Color();
  const rnd = rng(4242);
  for (const [key, list] of buckets) {
    const [speciesKey, variantKey] = key.split('|');
    const species = speciesKey as Species;
    const variant = Number(variantKey);
    const mesh = new InstancedMesh(geometries[species][variant]!, material, list.length);
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, rnd() * Math.PI * 2);
      const wide = t.s * (t.wide ?? 0.85 + rnd() * 0.3);
      m.compose(pos.set(t.x, ctx.hm.at(t.x, t.z) - 0.15, t.z), q, scale.set(wide, t.s, wide));
      mesh.setMatrixAt(i, m);
      const v = 0.82 + rnd() * 0.36;
      mesh.setColorAt(i, tint.setRGB(v * (0.95 + rnd() * 0.15), v, v * (0.9 + rnd() * 0.15)));
    });
    placed.push({ mesh, list, species, variant, hidden: [], saved: [] });
    const hero = !species.endsWith('Low');
    mesh.castShadow = hero;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  const layer: TreesLayer = {
    group,
    count: trees.length,
    update: (camera) => {
      for (const { mesh, species, variant } of placed) {
        const c = mesh.boundingSphere!.center;
        const far = Math.hypot(c.x - camera.position.x, c.z - camera.position.z) > DETAIL;
        const geometry = (far ? distant : geometries)[species][variant]!;
        if (mesh.geometry !== geometry) mesh.geometry = geometry;
      }
    },
    reseat: (area) => {
      for (const { mesh, list } of placed) {
        let changed = false;
        list.forEach((t, i) => {
          if (t.x < area.x0 || t.x > area.x1 || t.z < area.z0 || t.z > area.z1) return;
          const saved = placed.find((p) => p.mesh === mesh)!;
          if (saved.hidden[i]) {
            saved.saved[i]!.elements[13] = ctx.hm.at(t.x, t.z) - 0.15;
            return;
          }
          mesh.getMatrixAt(i, m);
          m.elements[13] = ctx.hm.at(t.x, t.z) - 0.15;
          mesh.setMatrixAt(i, m);
          changed = true;
        });
        if (changed) mesh.instanceMatrix.needsUpdate = true;
      }
      // Свои деревья тоже садятся на новую землю.
      if (own.some((t) => t.x >= area.x0 && t.x <= area.x1 && t.z >= area.z0 && t.z <= area.z1)) layer.setOwn(own);
    },
    setOwn: (list) => {
      for (const mesh of ownMeshes) {
        group.remove(mesh);
        mesh.dispose();
      }
      ownMeshes.length = 0;
      own = list;
      const bySpecies = new Map<string, OwnTree[]>();
      for (const t of list) {
        const key = `${t.species}|${Math.floor(hashUnit(t.id) * VARIANTS)}`;
        bySpecies.set(key, [...(bySpecies.get(key) ?? []), t]);
      }
      for (const [key, trees] of bySpecies) {
        const [species, variant] = key.split('|') as [Species, string];
        const mesh = new InstancedMesh(geometries[species][Number(variant)]!, material, trees.length);
        trees.forEach((t, i) => {
          // Поворот и оттенок — от id: дерево не «мигает», когда соседнее двигают.
          const h = hashUnit(t.id);
          q.setFromAxisAngle(up, h * Math.PI * 2);
          const wide = t.s * (0.9 + h * 0.2);
          m.compose(pos.set(t.x, ctx.hm.at(t.x, t.z) - 0.15, t.z), q, scale.set(wide, t.s, wide));
          mesh.setMatrixAt(i, m);
          const v = 0.88 + h * 0.24;
          mesh.setColorAt(i, tint.setRGB(v, v, v * 0.97));
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        mesh.name = 'own-trees';
        group.add(mesh);
        ownMeshes.push(mesh);
      }
    },
    setCleared: (circles) => {
      const inside = (x: number, z: number) => circles.some(([cx, cz, r]) => (x - cx) ** 2 + (z - cz) ** 2 < r * r);
      for (const p of placed) {
        let changed = false;
        p.list.forEach((t, i) => {
          const hide = inside(t.x, t.z);
          if (hide === !!p.hidden[i]) return;
          p.hidden[i] = hide;
          if (hide) {
            mesh0.copy(m.identity().makeScale(0, 0, 0));
            p.mesh.getMatrixAt(i, p.saved[i] ??= new Matrix4());
            p.mesh.setMatrixAt(i, mesh0);
          } else if (p.saved[i]) p.mesh.setMatrixAt(i, p.saved[i]!);
          changed = true;
        });
        if (changed) p.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    ownCrowns: () =>
      own.map((t) => ({ id: t.id, x: t.x, y: ctx.hm.at(t.x, t.z) + (t.species === 'apple' ? 2.6 : t.species === 'linden' ? 7 : 5.5) * t.s, z: t.z })),
    dispose: () => {
      for (const mesh of ownMeshes) mesh.dispose();
      [...Object.values(geometries), ...Object.values(distant)].flat().forEach((g) => g.dispose());
      material.dispose();
      atlas.dispose();
      group.children.forEach((c) => (c as InstancedMesh).dispose());
    },
  };
  return layer;
}

/** Число 0…1 по строке — устойчивое «случайное» для своего дерева. */
function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}
