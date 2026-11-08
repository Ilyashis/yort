// Земля района: четыре уровня текстуры из векторного рисовальщика (LandTextureRenderer).
// Уровень 0 — весь район (~0,8 м/px), 1 — 512 м вокруг взгляда (0,25 м/px), 2 — 128 м (6 см/px:
// бордюры, плитка, разметка), 3 — 64 м у ног пешехода (3 см/px: травинки, швы плитки).
// Уровни перерисовываются кусками по 256 px в свободное время кадра — когда точка взгляда уходит
// от их центра или поменялись покрытия (правки дорог); готовый уровень подменяется целиком, без мигания.
// Поверх покрытий — подложка (свой снимок для обводки): её пиксель ищется прямо в шейдере по гомографии,
// поэтому и перспективный кадр с дрона ложится точно в каждой точке земли.

import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  Matrix3,
  MeshStandardMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { LandTextureRenderer } from '../world/base/landTexture';
import { applyH, imageMatrix, invertH, isProjective, type ImageSize, type Mat3, type UnderlayPlacement } from '../world/edit/underlay';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import { NIGHT } from './nightUniforms';
import type { LocalRect } from './terrain';

const SLICE = 256;

interface Level {
  size: [number, number];
  /** Сколько метров покрывает (уровни 1–3; уровень 0 — весь район). */
  span?: number;
  texture: CanvasTexture;
  rect: LocalRect;
  uniform: Vector4;
  job?: Job;
}

interface Job {
  canvas: HTMLCanvasElement;
  rect: LocalRect;
  next: number;
  total: number;
}

/** Сколько фонарей светят на землю одновременно (ближайшие к взгляду). */
const MAX_LAMP_SPOTS = 48;

export class GroundTexture {
  private readonly lampSpots = Array.from({ length: MAX_LAMP_SPOTS }, () => new Vector3());
  private readonly lampSpotCount = { value: 0 };
  readonly material: MeshStandardMaterial;
  /** Подложка поверх покрытий (своя выборка в том же шейдере). */
  readonly underlay: GroundUnderlay;
  private readonly levels: Level[];
  private readonly scratch = document.createElement('canvas');

  constructor(
    private renderer: LandTextureRenderer,
    private readonly frame: LocalFrame,
    private readonly area: LocalRect,
    anisotropy: number,
  ) {
    this.scratch.width = SLICE;
    this.scratch.height = SLICE;
    const width = area.x1 - area.x0;
    const height = area.y1 - area.y0;
    const long = 4096;
    const base: [number, number] = width >= height ? [long, Math.round((long * height) / width)] : [Math.round((long * width) / height), long];
    const make = (size: [number, number], rect: LocalRect, span?: number): Level => {
      const canvas = document.createElement('canvas');
      canvas.width = size[0];
      canvas.height = size[1];
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = anisotropy;
      texture.minFilter = LinearMipmapLinearFilter;
      return { size, span, texture, rect, uniform: new Vector4(rect.x0, rect.y0, rect.x1, rect.y1) };
    };
    const empty = { x0: 0, y0: 0, x1: 0, y1: 0 };
    this.levels = [make(base, area), make([2048, 2048], empty, 512), make([2048, 2048], empty, 128), make([2048, 2048], empty, 64)];
    this.material = new MeshStandardMaterial({ roughness: 1, metalness: 0 });
    this.underlay = new GroundUnderlay(anisotropy);
  }

  /** Вставка в шейдер материала земли (подключается через hookMaterial). */
  readonly hook = (shader: ShaderSource) => {
    this.levels.forEach((level, i) => {
      shader.uniforms[`landMap${i}`] = { value: level.texture };
      shader.uniforms[`landRect${i}`] = { value: level.uniform };
    });
    Object.assign(shader.uniforms, this.underlay.uniforms);
    shader.uniforms['citiaLamps'] = NIGHT.lamps;
    shader.uniforms['lampSpots'] = { value: this.lampSpots };
    shader.uniforms['lampSpotCount'] = this.lampSpotCount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLand = vec2(position.x, -position.z);');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec2 vLand;
uniform sampler2D landMap0;
uniform sampler2D landMap1;
uniform sampler2D landMap2;
uniform sampler2D landMap3;
uniform vec4 landRect0;
uniform vec4 landRect1;
uniform vec4 landRect2;
uniform vec4 landRect3;
vec2 landUv(vec4 r) { return (vLand - r.xy) / max(r.zw - r.xy, vec2(1e-3)); }
// 1 — внутри уровня, к краю плавно в 0: на границе уровни перетекают друг в друга.
float landWeight(vec2 uv) { vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, 0.06, min(e.x, e.y)); }
// Ночью под фонарями — тёплые пятна света (ближайшие к взгляду фонари, локальные метры и сила).
uniform float citiaLamps;
uniform vec3 lampSpots[${MAX_LAMP_SPOTS}];
uniform int lampSpotCount;
${UNDERLAY_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec2 uv0 = landUv(landRect0);
vec2 uv1 = landUv(landRect1);
vec2 uv2 = landUv(landRect2);
vec2 uv3 = landUv(landRect3);
// Выборки — без ветвлений: так у текстур верные производные и мип-уровни.
vec4 land = texture2D(landMap0, uv0);
vec4 land1 = texture2D(landMap1, uv1);
vec4 land2 = texture2D(landMap2, uv2);
vec4 land3 = texture2D(landMap3, uv3);
land = mix(land, land1, landWeight(uv1) * step(1.0, landRect1.z - landRect1.x));
land = mix(land, land2, landWeight(uv2) * step(1.0, landRect2.z - landRect2.x));
land = mix(land, land3, landWeight(uv3) * step(1.0, landRect3.z - landRect3.x));
diffuseColor *= land;
applyUnderlay(diffuseColor);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
if (citiaLamps > 0.001) {
  float pool = 0.0;
  for (int i = 0; i < ${MAX_LAMP_SPOTS}; i++) {
    if (i >= lampSpotCount) break;
    vec2 d = vLand - lampSpots[i].xy;
    pool += lampSpots[i].z * exp(-dot(d, d) / 28.0);
  }
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.76, 0.48) * min(pool, 1.6) * citiaLamps * 1.5;
}`,
      );
  };

  /** Пятна света фонарей: ближайшие к точке взгляда (локальные метры). */
  setLampSpots(spots: readonly Vec2[], near: Vec2): void {
    const sorted = [...spots].sort((a, b) => Math.hypot(a[0] - near[0], a[1] - near[1]) - Math.hypot(b[0] - near[0], b[1] - near[1]));
    const count = Math.min(sorted.length, MAX_LAMP_SPOTS);
    for (let i = 0; i < count; i++) this.lampSpots[i]!.set(sorted[i]![0], sorted[i]![1], 1);
    this.lampSpotCount.value = count;
  }

  /** Уровень 0 целиком, сразу (при загрузке, ~0,5–1 с). */
  drawBase(): void {
    const level = this.levels[0]!;
    this.draw(level.texture.image as HTMLCanvasElement, level.rect, 0, Number.MAX_SAFE_INTEGER, level.size);
    level.texture.needsUpdate = true;
  }

  /** Покрытия поменялись (правки дорог, огороды): все уровни перерисуются в фоне. */
  setRenderer(renderer: LandTextureRenderer): void {
    this.renderer = renderer;
    for (const level of this.levels) {
      const rect = level.span ? level.job?.rect ?? level.rect : this.area;
      if (rect.x1 - rect.x0 < 1) continue;
      this.startJob(level, rect);
    }
  }

  /**
   * Куда смотрит камера: pointAhead(d) — точка земли в d метрах впереди (локальные метры).
   * Каждый уровень центрируется на четверть своего размера впереди и перерисовывается, если ушёл далеко.
   */
  focus(pointAhead: (distance: number) => Vec2): void {
    for (const level of this.levels) {
      const span = level.span;
      if (!span) continue;
      const [x, y] = pointAhead(span / 4);
      const current = level.job?.rect ?? level.rect;
      const empty = current.x1 - current.x0 < 1;
      const cx = (current.x0 + current.x1) / 2;
      const cy = (current.y0 + current.y1) / 2;
      if (!empty && Math.hypot(x - cx, y - cy) < span / 4) continue;
      // Центр — по сетке в 1/8 размера: мелкие движения камеры не заставляют перерисовывать.
      const snap = span / 8;
      const sx = Math.round(x / snap) * snap;
      const sy = Math.round(y / snap) * snap;
      this.startJob(level, { x0: sx - span / 2, y0: sy - span / 2, x1: sx + span / 2, y1: sy + span / 2 });
    }
  }

  /** Дорисовать сколько успеем за budgetMs; true — уровень готов и подменён (нужен кадр). */
  tick(budgetMs: number): boolean {
    const end = performance.now() + budgetMs;
    let changed = false;
    // Сначала мелкие уровни: они у самых ног.
    for (const level of [...this.levels].reverse()) {
      const job = level.job;
      if (!job) continue;
      while (job.next < job.total && performance.now() < end) {
        job.next = this.draw(job.canvas, job.rect, job.next, job.next + 1, level.size);
      }
      if (job.next >= job.total) {
        const old = level.texture.image as HTMLCanvasElement;
        level.texture.image = job.canvas;
        level.texture.needsUpdate = true;
        level.rect = job.rect;
        level.uniform.set(job.rect.x0, job.rect.y0, job.rect.x1, job.rect.y1);
        level.job = undefined;
        old.width = 1;
        changed = true;
      }
      if (performance.now() >= end) break;
    }
    return changed;
  }

  get busy(): boolean {
    return this.levels.some((level) => level.job);
  }

  dispose(): void {
    for (const level of this.levels) level.texture.dispose();
    this.underlay.dispose();
    this.material.dispose();
  }

  private startJob(level: Level, rect: LocalRect): void {
    const canvas = level.job?.canvas ?? document.createElement('canvas');
    canvas.width = level.size[0];
    canvas.height = level.size[1];
    level.job = { canvas, rect, next: 0, total: Math.ceil(level.size[0] / SLICE) * Math.ceil(level.size[1] / SLICE) };
  }

  /** Куски [from, to) по 256 px в холст размера size, покрывающий rect; возвращает следующий номер. */
  private draw(canvas: HTMLCanvasElement, rect: LocalRect, from: number, to: number, size: [number, number]): number {
    const ctx = canvas.getContext('2d');
    if (!ctx) return to;
    const cols = Math.ceil(size[0] / SLICE);
    const rows = Math.ceil(size[1] / SLICE);
    const mx = (rect.x1 - rect.x0) / size[0];
    const my = (rect.y1 - rect.y0) / size[1];
    const last = Math.min(to, cols * rows);
    for (let k = from; k < last; k++) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const px0 = col * SLICE;
      const py0 = row * SLICE;
      const w = Math.min(SLICE, size[0] - px0);
      const h = Math.min(SLICE, size[1] - py0);
      // Строки холста идут с севера на юг.
      const west = rect.x0 + px0 * mx;
      const east = west + SLICE * mx;
      const north = rect.y1 - py0 * my;
      const south = north - SLICE * my;
      const [lonW, latS] = this.frame.toLonLat([west, south]);
      const [lonE, latN] = this.frame.toLonLat([east, north]);
      this.renderer.draw(this.scratch, { west: lonW, south: latS, east: lonE, north: latN });
      ctx.drawImage(this.scratch, 0, 0, w, h, px0, py0, w, h);
    }
    return last;
  }
}

// --- подложка -------------------------------------------------------------------------------------

/** Исходники шейдера в onBeforeCompile — то, что меняют наши вставки. */
interface ShaderSource {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

/**
 * Подложка поверх цвета земли: точка земли (vLand, локальные метры) → пиксель снимка по гомографии.
 * За краем снимка и за «горизонтом» перспективы (w ≤ 0) — ничего; прозрачное в снимке — тоже.
 */
const UNDERLAY_GLSL = /* glsl */ `
uniform sampler2D underlayMap;
uniform mat3 underlayMatrix;
uniform vec2 underlaySize;
uniform float underlayOpacity;
void applyUnderlay(inout vec4 surface) {
  // Условие одно на весь кадр: выборка ниже — с верными производными и мип-уровнями.
  if (underlayOpacity <= 0.0) return;
  vec3 p = underlayMatrix * vec3(vLand, 1.0);
  vec2 uv = p.xy / (max(p.z, 1e-6) * underlaySize);
  vec4 photo = texture2D(underlayMap, uv);
  // Край снимка сглажен на пиксель экрана.
  vec2 edge = clamp(min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-7)) + 0.5, 0.0, 1.0);
  float k = underlayOpacity * edge.x * edge.y * step(1e-6, p.z);
  // Цвет у прозрачных мест снимка (пустое у ортофото) чёрный, на краях — умножен на альфу: смешиваем как предумноженный.
  surface.rgb = surface.rgb * (1.0 - k * photo.a) + photo.rgb * k;
}`;

/** Подложка на земле — всё, что нужно шейдеру: снимок, его привязка и прозрачность. */
export interface UnderlayView {
  bitmap: ImageBitmap;
  /** Размер снимка, px (в этих пикселях задана привязка). */
  size: ImageSize;
  placement: UnderlayPlacement;
  opacity: number;
  visible: boolean;
}

/**
 * Подложка в шейдере земли: текстура снимка (мип-уровни и анизотропия — чётко и вдали, и под углом)
 * и матрица «локальные метры → пиксели снимка». Uniform-ы общие у всех материалов земли.
 */
export class GroundUnderlay {
  readonly uniforms = {
    underlayMap: { value: null as Texture | null },
    underlayMatrix: { value: new Matrix3() },
    underlaySize: { value: new Vector2(1, 1) },
    underlayOpacity: { value: 0 },
  };
  private texture?: Texture;

  constructor(private readonly anisotropy: number) {}

  /** Показать снимок (тот же снимок — текстура не перезагружается, меняются только uniform-ы) или убрать. */
  set(view: UnderlayView | undefined): void {
    if (!view) {
      this.dispose();
      return;
    }
    if (this.texture?.image !== view.bitmap) {
      this.texture?.dispose();
      const texture = new Texture(view.bitmap);
      // ImageBitmap грузится без переворота: верхняя строка снимка — v = 0, как у пикселей снимка (y вниз).
      texture.flipY = false;
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.anisotropy;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      this.texture = texture;
      this.uniforms.underlayMap.value = texture;
    }
    const matrix = localToImageMatrix(view.size, view.placement);
    if (matrix) this.uniforms.underlayMatrix.value.set(...matrix);
    this.uniforms.underlaySize.value.set(view.size[0], view.size[1]);
    this.uniforms.underlayOpacity.value = view.visible && matrix ? view.opacity : 0;
  }

  /** Вставка в шейдер кольца земли до горизонта: там нет уровней покрытий, только подложка. */
  readonly hookOuter = (shader: ShaderSource) => {
    Object.assign(shader.uniforms, this.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLand;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLand = vec2(position.x, -position.z);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vLand;\n${UNDERLAY_GLSL}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\napplyUnderlay(diffuseColor);');
  };

  dispose(): void {
    this.texture?.dispose();
    this.texture = undefined;
    this.uniforms.underlayMap.value = null;
    this.uniforms.underlayOpacity.value = 0;
  }
}

/**
 * Матрица для шейдера (по строкам): локальные метры → пиксели снимка в однородных координатах.
 * Обратная к привязке снимка (у подобия — тоже 3×3), нормирована на w = 1 в центре снимка:
 * тогда по всему снимку w > 0, а за «горизонтом» перспективы w < 0. undefined — привязка вырождена.
 */
export function localToImageMatrix(size: ImageSize, placement: UnderlayPlacement): Mat3 | undefined {
  let forward: Mat3;
  if (isProjective(placement)) forward = placement.homography;
  else {
    const [a, b, c, d, e, f] = imageMatrix(size, placement);
    forward = [a, c, e, b, d, f, 0, 0, 1];
  }
  const inverse = invertH(forward);
  if (!inverse) return undefined;
  const [cx, cy] = applyH(forward, [size[0] / 2, size[1] / 2]);
  const w = inverse[6] * cx + inverse[7] * cy + inverse[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return undefined;
  return inverse.map((value) => value / w) as Mat3;
}
