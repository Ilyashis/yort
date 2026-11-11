// Рельеф: сетка высот в метрах мира, маски покрытий (асфальт, плитка, грунт, газон, лес, вода),
// нарисованные на холсте, и материал, который по этим маскам красит землю.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  type Texture,
} from 'three';
import type { Footprint, World } from '../core/data';
import type { P2 } from '../core/geo';
import { UNDERLAY_GLSL, type GroundUnderlay } from '../three/groundUnderlay';
import { NOISE_GLSL, shared, type Rect } from './shared';

/** Высоты земли: регулярная сетка, между узлами — те же треугольники, что и у видимой сетки. */
export class HeightMap {
  readonly nx: number;
  readonly nz: number;
  /** Текущие высоты (с правками кистью) и исходные. */
  readonly data: Float32Array;
  readonly base: Float32Array;
  readonly rect: Rect;
  private readonly baseAlt: number;

  constructor(
    private readonly world: World,
    rect: Rect,
    readonly step: number,
    /** Высота над уровнем моря по долготе и широте; нет — общий рельеф (Copernicus). */
    heightAt?: (lon: number, lat: number) => number,
  ) {
    this.nx = Math.ceil((rect.x1 - rect.x0) / step) + 1;
    this.nz = Math.ceil((rect.z1 - rect.z0) / step) + 1;
    this.rect = { x0: rect.x0, z0: rect.z0, x1: rect.x0 + (this.nx - 1) * step, z1: rect.z0 + (this.nz - 1) * step };
    const { frame, dem } = world;
    this.baseAlt = dem.at(frame.lon0, frame.lat0);
    const data = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      const lat = frame.lat(rect.z0 + j * step);
      for (let i = 0; i < this.nx; i++) {
        const lon = frame.lon(rect.x0 + i * step);
        data[j * this.nx + i] = (heightAt ? heightAt(lon, lat) : dem.at(lon, lat)) - this.baseAlt;
      }
    }
    this.data = data;
    this.base = data.slice();
  }

  /** Поправки кисти рельефа: высоты узлов в прямоугольнике = исходные + offset(x, z). */
  applyOffsets(offset: (x: number, z: number) => number, area: Rect = this.rect): void {
    const r = this.rect;
    const i0 = Math.max(0, Math.floor((area.x0 - r.x0) / this.step)), i1 = Math.min(this.nx - 1, Math.ceil((area.x1 - r.x0) / this.step));
    const j0 = Math.max(0, Math.floor((area.z0 - r.z0) / this.step)), j1 = Math.min(this.nz - 1, Math.ceil((area.z1 - r.z0) / this.step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        this.data[k] = this.base[k] + offset(r.x0 + i * this.step, r.z0 + j * this.step);
      }
    }
  }

  /** Высота без правок кистью. */
  atBase(x: number, z: number): number {
    return this.sample(this.base, x, z);
  }

  at(x: number, z: number): number {
    return this.sample(this.data, x, z);
  }

  private sample(d: Float32Array, x: number, z: number): number {
    const r = this.rect;
    if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) {
      return this.world.dem.at(this.world.frame.lon(x), this.world.frame.lat(z)) - this.baseAlt;
    }
    const fx = (x - r.x0) / this.step;
    const fz = (z - r.z0) / this.step;
    const i = Math.min(Math.floor(fx), this.nx - 2);
    const j = Math.min(Math.floor(fz), this.nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * this.nx + i;
    const h00 = d[k], h10 = d[k + 1], h01 = d[k + this.nx], h11 = d[k + this.nx + 1];
    return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }
}

export interface Masks {
  a: Texture;
  b: Texture;
  c: Texture;
  dispose: () => void;
}

function canvasFor(rect: Rect, maxSize: number, software = true): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; scale: number } {
  const w = rect.x1 - rect.x0;
  const h = rect.z1 - rect.z0;
  const scale = maxSize / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  // Маски рисуем на процессоре: тысячи контуров на огромном холсте подвешивают видеокарту.
  const ctx = canvas.getContext('2d', { willReadFrequently: software })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, (-rect.x0 * canvas.width) / w, (-rect.z0 * canvas.height) / h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  return { canvas, ctx, scale };
}

function fillRings(ctx: CanvasRenderingContext2D, rings: readonly P2[][]): void {
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }
  ctx.fill('evenodd');
}

function strokeLine(ctx: CanvasRenderingContext2D, pts: readonly P2[], width: number): void {
  ctx.lineWidth = width;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.stroke();
}

function maskTexture(canvas: HTMLCanvasElement, anisotropy: number): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.flipY = false;
  t.colorSpace = NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = anisotropy;
  return t;
}

/** В деревне асфальт — только на проходящей дороге, остальное — грунтовки. */
export const isPaved = (world: World, highway: string) => world.territory.kind === 'city' || highway === 'tertiary' || highway === 'secondary' || highway === 'primary';

export interface MaskExtras {
  /** Утоптанная земля (подъезды к воротам). */
  dirt: P2[][];
  /** Огороды. */
  gardens: P2[][];
  /** Контуры дворовых построек — затенение у стен. */
  pads: P2[][];
}

export function paintMasks(world: World, rect: Rect, lamps: readonly P2[], footprints: readonly Footprint[], anisotropy: number, extras?: MaskExtras, into?: Masks): Masks {
  const city = world.territory.kind === 'city';
  const R = '#ff0000', G = '#00ff00', B = '#0000ff';

  // A: асфальт (R), плитка и тротуары (G), грунт (B).
  const A = canvasFor(rect, 4096);
  A.ctx.globalCompositeOperation = 'lighter';
  const minW = 2.2 / A.scale;
  for (const g of world.ground) {
    if (g.kind === 'parking') A.ctx.fillStyle = R;
    else if (g.kind === 'sidewalk' || g.kind === 'paving' || (g.kind === 'footway' && city)) A.ctx.fillStyle = G;
    else continue;
    fillRings(A.ctx, g.rings);
  }
  for (const road of world.roads) {
    const paved = isPaved(world, road.highway);
    A.ctx.strokeStyle = paved ? R : B;
    strokeLine(A.ctx, road.pts, Math.max(minW, paved ? road.width : road.width * 0.7));
  }
  A.ctx.fillStyle = B;
  for (const ring of extras?.dirt ?? []) fillRings(A.ctx, [ring]);
  for (const path of world.paths) {
    A.ctx.strokeStyle = city ? G : B;
    strokeLine(A.ctx, path.pts, Math.max(minW, city ? path.width : 1.6));
  }

  // B: газон (R), лес (G), вода (B).
  const Bm = canvasFor(rect, 2048);
  Bm.ctx.globalCompositeOperation = 'lighter';
  for (const g of world.ground) {
    if (g.kind === 'water') Bm.ctx.fillStyle = B;
    else if (g.kind === 'pitch' || (g.kind === 'green' && !g.cover)) Bm.ctx.fillStyle = R;
    else if (g.kind === 'green' && g.cover === 'wood') Bm.ctx.fillStyle = G;
    else continue;
    fillRings(Bm.ctx, g.rings);
  }

  // C: свет фонарей на земле (R), затенение у стен домов (G), огороды (B).
  const C = canvasFor(rect, 2048);
  C.ctx.globalCompositeOperation = 'lighter';
  for (const [x, z] of lamps) {
    const grad = C.ctx.createRadialGradient(x, z, 0, x, z, 15);
    grad.addColorStop(0, 'rgba(255,0,0,0.85)');
    grad.addColorStop(0.35, 'rgba(255,0,0,0.4)');
    grad.addColorStop(1, 'rgba(255,0,0,0)');
    C.ctx.fillStyle = grad;
    C.ctx.fillRect(x - 15, z - 15, 30, 30);
  }
  C.ctx.fillStyle = B;
  for (const ring of extras?.gardens ?? []) fillRings(C.ctx, [ring]);
  // Затенение у стен: контуры домов — на отдельный холст, затем одним размытым слоем.
  const F = canvasFor(rect, 2048);
  F.ctx.fillStyle = G;
  for (const f of footprints) if (f.props.minHeight < 2) fillRings(F.ctx, f.rings);
  for (const ring of extras?.pads ?? []) fillRings(F.ctx, [ring]);
  C.ctx.setTransform(1, 0, 0, 1, 0, 0);
  C.ctx.filter = `blur(${Math.max(1.5, 2.2 * C.scale).toFixed(1)}px)`;
  C.ctx.drawImage(F.canvas, 0, 0);
  C.ctx.filter = 'none';

  if (into) {
    // Перерисовка (правки дорог и дворов): те же текстуры, новые холсты.
    [[into.a, A.canvas], [into.b, Bm.canvas], [into.c, C.canvas]].forEach(([t, canvas]) => {
      (t as Texture).image = canvas;
      (t as Texture).needsUpdate = true;
    });
    return into;
  }
  const a = maskTexture(A.canvas, anisotropy);
  const b = maskTexture(Bm.canvas, anisotropy);
  const c = maskTexture(C.canvas, 1);
  return { a, b, c, dispose: () => [a, b, c].forEach((t) => t.dispose()) };
}

/** План района для мини-карты (тёмная схема). */
export function paintMiniMap(world: World, rect: Rect, footprints: readonly Footprint[]): HTMLCanvasElement {
  const city = world.territory.kind === 'city';
  const { canvas, ctx, scale } = canvasFor(rect, 2048, false);
  ctx.fillStyle = city ? '#20252d' : '#222b24';
  ctx.fillRect(rect.x0, rect.z0, rect.x1 - rect.x0, rect.z1 - rect.z0);
  const fills: Record<string, string> = { green: '#27402c', pitch: '#2d4a33', water: '#234a6b', parking: '#2b313a', paving: '#2f353e', sidewalk: '#2f353e' };
  for (const g of world.ground) {
    const colour = g.cover === 'wood' ? '#1e3a26' : fills[g.kind];
    if (!colour) continue;
    ctx.fillStyle = colour;
    fillRings(ctx, g.rings);
  }
  ctx.strokeStyle = '#3a424d';
  for (const path of world.paths) strokeLine(ctx, path.pts, Math.max(1.2 / scale, path.width));
  ctx.strokeStyle = city ? '#5b6675' : '#6b6456';
  for (const road of world.roads) strokeLine(ctx, road.pts, Math.max(1.6 / scale, road.width));
  ctx.fillStyle = '#8b96a6';
  for (const f of footprints) fillRings(ctx, f.rings);
  return canvas;
}

export function createTerrainMaterial(masks: Masks, rect: Rect, city: boolean, underlay: GroundUnderlay): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const uniforms = {
    uMaskA: { value: masks.a },
    uMaskB: { value: masks.b },
    uMaskC: { value: masks.c },
    uRect: { value: [rect.x0, rect.z0, rect.x1 - rect.x0, rect.z1 - rect.z0] },
    uGroundA: { value: city ? new Color().setRGB(0.17, 0.2, 0.1) : new Color().setRGB(0.17, 0.24, 0.075) },
    uGroundB: { value: city ? new Color().setRGB(0.25, 0.235, 0.17) : new Color().setRGB(0.27, 0.29, 0.1) },
    uTime: shared.uTime,
    uLamps: shared.uLamps,
    ...underlay.uniforms,
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vNrmW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;\nvNrmW = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWPos;
        varying vec3 vNrmW;
        uniform sampler2D uMaskA, uMaskB, uMaskC;
        uniform vec4 uRect;
        uniform vec3 uGroundA, uGroundB;
        uniform float uTime, uLamps;
        ${NOISE_GLSL}
        ${UNDERLAY_GLSL}
        float cov(float c) {
          float w = clamp(fwidth(c) * 1.2, 0.03, 0.3);
          return smoothstep(0.5 - w, 0.5 + w, c);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec2 muv = (vWPos.xz - uRect.xy) / uRect.zw;
        float inMask = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
        vec3 mA = texture2D(uMaskA, muv).rgb * inMask;
        vec3 mB = texture2D(uMaskB, muv).rgb * inMask;
        vec3 mC = texture2D(uMaskC, muv).rgb * inMask;
        float camD = length(vWPos - cameraPosition);
        float nearF = 1.0 - smoothstep(25.0, 110.0, camD);
        float nBig = fbm(vWPos.xz * 0.011);
        float nMid = vnoise(vWPos.xz * 0.31);
        float nFine = (vnoise(vWPos.xz * 5.7) - 0.5) * nearF;
        float grainF = 1.0 - smoothstep(5.0, 45.0, camD);
        float nGrain = (vnoise(vWPos.xz * 37.0) + vnoise(vWPos.xz * 113.0) - 1.0) * grainF;
        vec3 col = mix(uGroundA, uGroundB, smoothstep(0.32, 0.68, nBig)) * (0.84 + 0.26 * nMid + 0.22 * nFine + 0.3 * nGrain);
        float slope = 1.0 - normalize(vNrmW).y;
        col = mix(col, vec3(0.3, 0.25, 0.17) * (0.8 + 0.4 * nMid), smoothstep(0.1, 0.28, slope));
        float lawn = cov(mB.r);
        col = mix(col, vec3(0.105, 0.2, 0.06) * (0.86 + 0.24 * nMid + 0.25 * nFine + 0.3 * nGrain), lawn);
        float wood = cov(mB.g);
        col = mix(col, vec3(0.075, 0.13, 0.05) * (0.8 + 0.4 * nMid), wood);
        float veg = cov(mC.b);
        float bed = 0.5 + 0.5 * sin((vWPos.x * 0.8 + vWPos.z * 0.6) * 5.2);
        col = mix(col, mix(vec3(0.16, 0.115, 0.075), vec3(0.11, 0.2, 0.06), smoothstep(0.35, 0.75, bed) * (0.6 + 0.4 * nMid)) * (0.85 + 0.3 * nGrain), veg);
        float dirt = cov(mA.b + (nMid - 0.5) * 0.25 + nFine * 0.2);
        col = mix(col, vec3(0.34, 0.27, 0.185) * (0.78 + 0.34 * nMid + 0.3 * nFine + 0.3 * nGrain), dirt);
        float pave = cov(mA.g);
        vec2 tile = abs(fract(vWPos.xz / 0.7) - 0.5);
        float joint = smoothstep(0.455, 0.5, max(tile.x, tile.y)) * (1.0 - smoothstep(8.0, 40.0, camD));
        col = mix(col, vec3(0.42, 0.41, 0.39) * (0.88 + 0.16 * nMid) * (1.0 - 0.3 * joint), pave);
        float asph = cov(mA.r);
        col = mix(col, vec3(0.075, 0.077, 0.082) * (0.84 + 0.28 * nMid + 0.4 * nFine + 0.5 * nGrain), asph);
        float water = cov(mB.b);
        col = mix(col, vec3(0.025, 0.075, 0.1), water);
        col *= 1.0 - 0.55 * mC.g * (1.0 - water);
        diffuseColor.rgb = col;
        applyUnderlay(diffuseColor, vec2(vWPos.x, -vWPos.z));
        col = diffuseColor.rgb;`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(mix(roughnessFactor, 0.82, asph), 0.06, water);')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          vec2 wp = vWPos.xz * 0.3;
          float t = uTime * 0.7;
          float wx = sin(wp.x * 1.3 + t) * 0.5 + sin(wp.x * 2.9 - wp.y * 1.7 + t * 1.7) * 0.3 + vnoise(wp * 3.0 + t) - 0.5;
          float wz = cos(wp.y * 1.1 - t * 0.8) * 0.5 + sin(wp.y * 3.1 + wp.x * 2.3 + t * 1.3) * 0.3 + vnoise(wp * 3.0 - t + 9.0) - 0.5;
          normal = normalize(normal + water * 0.05 * (1.0 - smoothstep(150.0, 700.0, length(vWPos - cameraPosition))) * (viewMatrix * vec4(wx, 0.0, wz, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += (col + 0.02) * vec3(1.0, 0.72, 0.42) * mC.r * uLamps * 2.2;',
      );
  };
  return material;
}

/** Ближняя сетка рельефа кусками (для отсечения по кадру), «юбка» по краю и грубое кольцо до горизонта. */
export interface TerrainMeshes {
  group: Group;
  /** Высоты поменялись (кисть рельефа): обновить сетку в прямоугольнике. */
  refresh: (area: Rect) => void;
}

export function createTerrainMeshes(hm: HeightMap, material: MeshStandardMaterial): TerrainMeshes {
  const group = new Group();
  group.name = 'terrain';
  const { nx, nz, step, rect, data } = hm;
  const CH = 96;
  const chunks: { i0: number; j0: number; w: number; h: number; geometry: BufferGeometry }[] = [];
  const hAt = (i: number, j: number) => data[Math.min(nz - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];

  for (let j0 = 0; j0 < nz - 1; j0 += CH) {
    for (let i0 = 0; i0 < nx - 1; i0 += CH) {
      const w = Math.min(CH, nx - 1 - i0) + 1;
      const h = Math.min(CH, nz - 1 - j0) + 1;
      const pos = new Float32Array(w * h * 3);
      const nrm = new Float32Array(w * h * 3);
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const gi = i0 + i;
          const gj = j0 + j;
          const o = (j * w + i) * 3;
          pos[o] = rect.x0 + gi * step;
          pos[o + 1] = data[gj * nx + gi];
          pos[o + 2] = rect.z0 + gj * step;
          const dx = (hAt(gi + 1, gj) - hAt(gi - 1, gj)) / (2 * step);
          const dz = (hAt(gi, gj + 1) - hAt(gi, gj - 1)) / (2 * step);
          const l = Math.hypot(dx, 1, dz);
          nrm[o] = -dx / l;
          nrm[o + 1] = 1 / l;
          nrm[o + 2] = -dz / l;
        }
      }
      const idx = new Uint16Array((w - 1) * (h - 1) * 6);
      let k = 0;
      for (let j = 0; j < h - 1; j++) {
        for (let i = 0; i < w - 1; i++) {
          const a = j * w + i;
          idx[k++] = a;
          idx[k++] = a + w;
          idx[k++] = a + 1;
          idx[k++] = a + 1;
          idx[k++] = a + w;
          idx[k++] = a + w + 1;
        }
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new BufferAttribute(nrm, 3));
      geometry.setIndex(new BufferAttribute(idx, 1));
      const mesh = new Mesh(geometry, material);
      mesh.receiveShadow = true;
      group.add(mesh);
      chunks.push({ i0, j0, w, h, geometry });
    }
  }

  // «Юбка» по периметру: закрывает ступеньку между ближней сеткой и грубым кольцом.
  const skirt: number[] = [];
  const edge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    skirt.push(ax, ay, az, ax, ay - 25, az, bx, by, bz, bx, by, bz, ax, ay - 25, az, bx, by - 25, bz);
  };
  for (let i = 0; i < nx - 1; i++) {
    const xa = rect.x0 + i * step, xb = xa + step;
    edge(xb, hAt(i + 1, 0), rect.z0, xa, hAt(i, 0), rect.z0);
    edge(xa, hAt(i, nz - 1), rect.z1, xb, hAt(i + 1, nz - 1), rect.z1);
  }
  for (let j = 0; j < nz - 1; j++) {
    const za = rect.z0 + j * step, zb = za + step;
    edge(rect.x0, hAt(0, j), za, rect.x0, hAt(0, j + 1), zb);
    edge(rect.x1, hAt(nx - 1, j + 1), zb, rect.x1, hAt(nx - 1, j), za);
  }
  const skirtGeometry = new BufferGeometry();
  skirtGeometry.setAttribute('position', new BufferAttribute(new Float32Array(skirt), 3));
  const up = new Float32Array(skirt.length);
  for (let i = 1; i < up.length; i += 3) up[i] = 1;
  skirtGeometry.setAttribute('normal', new BufferAttribute(up, 3));
  group.add(new Mesh(skirtGeometry, material));

  // Кольцо до горизонта: шаг 160 м, под ближней сеткой — дыра.
  const FAR = 9000;
  const S = 160;
  const ox0 = rect.x0 - FAR, oz0 = rect.z0 - FAR;
  const onx = Math.ceil((rect.x1 - rect.x0 + 2 * FAR) / S) + 1;
  const onz = Math.ceil((rect.z1 - rect.z0 + 2 * FAR) / S) + 1;
  const opos = new Float32Array(onx * onz * 3);
  const onrm = new Float32Array(onx * onz * 3);
  for (let j = 0; j < onz; j++) {
    for (let i = 0; i < onx; i++) {
      const o = (j * onx + i) * 3;
      const x = ox0 + i * S, z = oz0 + j * S;
      opos[o] = x;
      opos[o + 1] = hm.at(x, z) - 3;
      opos[o + 2] = z;
      const dx = (hm.at(x + S, z) - hm.at(x - S, z)) / (2 * S);
      const dz = (hm.at(x, z + S) - hm.at(x, z - S)) / (2 * S);
      const l = Math.hypot(dx, 1, dz);
      onrm[o] = -dx / l;
      onrm[o + 1] = 1 / l;
      onrm[o + 2] = -dz / l;
    }
  }
  const oidx: number[] = [];
  for (let j = 0; j < onz - 1; j++) {
    for (let i = 0; i < onx - 1; i++) {
      const x = ox0 + i * S, z = oz0 + j * S;
      if (x > rect.x0 + S && x + S < rect.x1 - S && z > rect.z0 + S && z + S < rect.z1 - S) continue;
      const a = j * onx + i;
      oidx.push(a, a + onx, a + 1, a + 1, a + onx, a + onx + 1);
    }
  }
  const outer = new BufferGeometry();
  outer.setAttribute('position', new BufferAttribute(opos, 3));
  outer.setAttribute('normal', new BufferAttribute(onrm, 3));
  outer.setIndex(oidx);
  const outerMesh = new Mesh(outer, material);
  outerMesh.receiveShadow = false;
  group.add(outerMesh);

  const refresh = (area: Rect) => {
    const gi0 = Math.floor((area.x0 - rect.x0) / step) - 1, gi1 = Math.ceil((area.x1 - rect.x0) / step) + 1;
    const gj0 = Math.floor((area.z0 - rect.z0) / step) - 1, gj1 = Math.ceil((area.z1 - rect.z0) / step) + 1;
    for (const c of chunks) {
      if (c.i0 > gi1 || c.i0 + c.w - 1 < gi0 || c.j0 > gj1 || c.j0 + c.h - 1 < gj0) continue;
      const pos = c.geometry.getAttribute('position') as BufferAttribute;
      const nrm = c.geometry.getAttribute('normal') as BufferAttribute;
      for (let j = Math.max(0, gj0 - c.j0); j <= Math.min(c.h - 1, gj1 - c.j0); j++) {
        for (let i = Math.max(0, gi0 - c.i0); i <= Math.min(c.w - 1, gi1 - c.i0); i++) {
          const gi = c.i0 + i, gj = c.j0 + j;
          const dx = (hAt(gi + 1, gj) - hAt(gi - 1, gj)) / (2 * step);
          const dz = (hAt(gi, gj + 1) - hAt(gi, gj - 1)) / (2 * step);
          const l = Math.hypot(dx, 1, dz);
          pos.setY(j * c.w + i, data[gj * nx + gi]);
          nrm.setXYZ(j * c.w + i, -dx / l, 1 / l, -dz / l);
        }
      }
      pos.needsUpdate = true;
      nrm.needsUpdate = true;
      c.geometry.computeBoundingSphere();
    }
  };
  return { group, refresh };
}
