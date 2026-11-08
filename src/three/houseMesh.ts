// Деревенский дом из частей (world/village/houseParts) в three.js: один меш со стенами, крышей и резьбой
// (цвет вершин + рисунок поверхности — брёвна, обшивка, доски, профнастил, шифер, кирпич, войлок, орнамент —
// рисует шейдер по координатам на поверхности, без текстур) и один меш стёкол: отражают небо, на части
// окон тюль, вечером в окнах загорается свет (общий «ночной» множитель).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  ShapeUtils,
  SRGBColorSpace,
  Vector2,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import type { HousePlan } from '../world/village/houseModels';
import { polygonNormal, SURFACE_CODES, type BlobPart, type BoxPart, type CylinderPart, type GlassPart, type HousePart, type SlabPart, type Vec3 } from '../world/village/houseParts';
import { NIGHT } from './nightUniforms';
import { hookMaterial, type ShaderHook } from './shaderHooks';

// --- векторы (локальные оси дома: x — восток, y — север, z — вверх) ----------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const Z: Vec3 = [0, 0, 1];

/** Координаты рисунка на грани: s — по горизонтали вдоль грани, t — вверх по грани (или по второй оси). */
function faceAxes(n: Vec3, angle = 0): [Vec3, Vec3] {
  if (Math.abs(n[2]) > 0.95) return [[Math.cos(angle), Math.sin(angle), 0], [-Math.sin(angle), Math.cos(angle), 0]];
  const h = norm([n[1], -n[0], 0]);
  const up = norm(sub(Z, mul(n, dot(n, Z))));
  return [h, up];
}

class Buffers {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly color: number[] = [];
  readonly extra: number[] = [];
  constructor(readonly extraSize: number) {}

  /** Треугольник: обход выправляется по нормали n (лицо — наружу). */
  tri(a: Vec3, b: Vec3, c: Vec3, n: Vec3 | [Vec3, Vec3, Vec3], color: Color, extra: [number[], number[], number[]]): void {
    const flat = typeof n[0] === 'number';
    const faceN = flat ? (n as Vec3) : norm(add(add((n as Vec3[])[0]!, (n as Vec3[])[1]!), (n as Vec3[])[2]!));
    let verts: [Vec3, Vec3, Vec3] = [a, b, c];
    let normals: [Vec3, Vec3, Vec3] = flat ? [n as Vec3, n as Vec3, n as Vec3] : (n as [Vec3, Vec3, Vec3]);
    let ex = extra;
    if (dot(cross(sub(b, a), sub(c, a)), faceN) < 0) {
      verts = [a, c, b];
      normals = [normals[0], normals[2], normals[1]];
      ex = [extra[0], extra[2], extra[1]];
    }
    for (let i = 0; i < 3; i++) {
      const p = verts[i]!;
      const q = normals[i]!;
      // Локальные оси → three.js: (x, z, −y).
      this.position.push(p[0], p[2], -p[1]);
      this.normal.push(q[0], q[2], -q[1]);
      this.color.push(color.r, color.g, color.b);
      this.extra.push(...ex[i]!);
    }
  }

  geometry(extraName: string): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.position), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normal), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.color), 3));
    g.setAttribute(extraName, new BufferAttribute(new Float32Array(this.extra), this.extraSize));
    g.computeBoundingSphere();
    return g;
  }
}

const colorCache = new Map<string, Color>();
const toColor = (hex: string) => {
  let c = colorCache.get(hex);
  if (!c) {
    c = new Color(hex);
    colorCache.set(hex, c);
  }
  return c;
};

/** Грань-четырёхугольник с рисунком поверхности (координаты рисунка — по осям грани). */
function quad(buf: Buffers, a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, color: Color, code: number, angle = 0): void {
  const [sAxis, tAxis] = faceAxes(n, angle);
  const st = (p: Vec3) => [code, dot(p, sAxis), dot(p, tAxis)];
  buf.tri(a, b, c, n, color, [st(a), st(b), st(c)]);
  buf.tri(a, c, d, n, color, [st(a), st(c), st(d)]);
}

function boxCorners(p: BoxPart | GlassPart): { corner: (i: number, j: number, k: number) => Vec3; ax: Vec3; ay: Vec3 } {
  const c = Math.cos(p.angle ?? 0);
  const s = Math.sin(p.angle ?? 0);
  const ax: Vec3 = [c, s, 0];
  const ay: Vec3 = [-s, c, 0];
  const [sx, sy, sz] = p.size;
  const corner = (i: number, j: number, k: number) => add(p.center, add(add(mul(ax, (i * sx) / 2), mul(ay, (j * sy) / 2)), [0, 0, (k * sz) / 2]));
  return { corner, ax, ay };
}

/** Шесть граней ящика: emit(4 угла, нормаль). */
function boxFaces(p: BoxPart | GlassPart, emit: (a: Vec3, b: Vec3, c: Vec3, d: Vec3, n: Vec3, axis: 'x' | 'y' | 'z') => void): void {
  const { corner: k, ax, ay } = boxCorners(p);
  emit(k(1, -1, -1), k(1, 1, -1), k(1, 1, 1), k(1, -1, 1), ax, 'x');
  emit(k(-1, 1, -1), k(-1, -1, -1), k(-1, -1, 1), k(-1, 1, 1), mul(ax, -1), 'x');
  emit(k(1, 1, -1), k(-1, 1, -1), k(-1, 1, 1), k(1, 1, 1), ay, 'y');
  emit(k(-1, -1, -1), k(1, -1, -1), k(1, -1, 1), k(-1, -1, 1), mul(ay, -1), 'y');
  emit(k(-1, -1, 1), k(1, -1, 1), k(1, 1, 1), k(-1, 1, 1), Z, 'z');
  emit(k(-1, 1, -1), k(1, 1, -1), k(1, -1, -1), k(-1, -1, -1), [0, 0, -1], 'z');
}

function addBox(buf: Buffers, p: BoxPart): void {
  const color = toColor(p.color);
  const code = SURFACE_CODES[p.surface ?? 'plain'];
  boxFaces(p, (a, b, c, d, n) => quad(buf, a, b, c, d, n, color, code, p.angle ?? 0));
}

function addCylinder(buf: Buffers, p: CylinderPart): void {
  const color = toColor(p.color);
  const code = SURFACE_CODES[p.surface ?? 'plain'];
  const axis = sub(p.to, p.from);
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-4) return;
  const dir = mul(axis, 1 / len);
  const e1 = Math.abs(dir[2]) < 0.9 ? norm(cross(dir, Z)) : norm(cross(dir, [0, 1, 0]));
  const e2 = cross(e1, dir);
  const r0 = p.radius;
  const r1 = p.radiusTop ?? p.radius;
  const n = p.segments ?? 12;
  const vertical = Math.abs(dir[2]) > 0.7;
  const arcR = (r0 + r1) / 2;
  const radial = (k: number): Vec3 => {
    const a = (k / n) * Math.PI * 2;
    return add(mul(e1, Math.cos(a)), mul(e2, Math.sin(a)));
  };
  const st = (q: Vec3, k: number) => {
    const arc = (k / n) * Math.PI * 2 * arcR;
    return vertical ? [code, arc, q[2]] : [code, dot(q, dir), arc];
  };
  for (let k = 0; k < n; k++) {
    const ra = radial(k);
    const rb = radial(k + 1);
    const na = norm(add(mul(ra, len), mul(dir, r0 - r1)));
    const nb = norm(add(mul(rb, len), mul(dir, r0 - r1)));
    const a0 = add(p.from, mul(ra, r0));
    const b0 = add(p.from, mul(rb, r0));
    const a1 = add(p.to, mul(ra, r1));
    const b1 = add(p.to, mul(rb, r1));
    buf.tri(a0, b0, b1, [na, nb, nb], color, [st(a0, k), st(b0, k + 1), st(b1, k + 1)]);
    buf.tri(a0, b1, a1, [na, nb, na], color, [st(a0, k), st(b1, k + 1), st(a1, k)]);
  }
  if (p.caps === false) return;
  const capColor = toColor(p.caps ?? p.color);
  const capCode = p.caps && p.surface === 'wood' ? SURFACE_CODES.endgrain : code;
  for (const [center, r, nrm] of [
    [p.from, r0, mul(dir, -1)],
    [p.to, r1, dir],
  ] as [Vec3, number, Vec3][]) {
    if (r < 0.005) continue;
    const local = (q: Vec3) => [capCode, dot(sub(q, center), e1), dot(sub(q, center), e2)];
    for (let k = 0; k < n; k++) {
      const a = add(center, mul(radial(k), r));
      const b = add(center, mul(radial(k + 1), r));
      buf.tri(center, a, b, nrm, capColor, [local(center), local(a), local(b)]);
    }
  }
}

function addSlab(buf: Buffers, p: SlabPart): void {
  const color = toColor(p.color);
  const code = SURFACE_CODES[p.surface ?? 'plain'];
  const n = norm(polygonNormal(p.points));
  const [sAxis, tAxis] = faceAxes(n);
  const top = p.points;
  const bottom = top.map((q) => sub(q, mul(n, p.thickness)));
  const flat = top.map((q) => new Vector2(dot(q, sAxis), dot(q, tAxis)));
  const triangles = ShapeUtils.triangulateShape(flat, []);
  const st = (q: Vec3) => [code, dot(q, sAxis), dot(q, tAxis)];
  const back = mul(n, -1);
  for (const [i, j, k] of triangles) {
    const a = top[i!]!;
    const b = top[j!]!;
    const c = top[k!]!;
    buf.tri(a, b, c, n, color, [st(a), st(b), st(c)]);
    const a2 = bottom[i!]!;
    const b2 = bottom[j!]!;
    const c2 = bottom[k!]!;
    buf.tri(a2, c2, b2, back, color, [st(a2), st(c2), st(b2)]);
  }
  for (let i = 0; i < top.length; i++) {
    const a = top[i]!;
    const b = top[(i + 1) % top.length]!;
    const edge = sub(b, a);
    if (Math.hypot(edge[0], edge[1], edge[2]) < 1e-5) continue;
    const side = norm(cross(edge, n));
    quad(buf, a, b, bottom[(i + 1) % top.length]!, bottom[i]!, side, color, code);
  }
}

function addGlass(buf: Buffers, p: GlassPart): void {
  const color = toColor('#2e3c48');
  const { ax } = boxCorners(p);
  const [sx, , sz] = p.size;
  boxFaces(p, (a, b, c, d, n, axis) => {
    const pane = (q: Vec3) => {
      const d0 = sub(q, p.center);
      return axis === 'y' ? [dot(d0, ax) / sx + 0.5, d0[2] / sz + 0.5, p.lit, p.curtain ? 1 : 0] : [0, 0, p.lit, 0];
    };
    buf.tri(a, b, c, n, color, [pane(a), pane(b), pane(c)]);
    buf.tri(a, c, d, n, color, [pane(a), pane(c), pane(d)]);
  });
}

// --- шейдеры ---------------------------------------------------------------------------------------

const SURFACE_GLSL = /* glsl */ `
varying vec3 vSurface;
float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// Плавный шум (без «пикселей»).
float cNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cHash(i), cHash(i + vec2(1.0, 0.0)), f.x), mix(cHash(i + vec2(0.0, 1.0)), cHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Сглаживание: когда рисунок мельче пикселя — среднее значение (без ряби вдали).
float cFar(float coord) { return smoothstep(0.25, 0.6, fwidth(coord)); }

vec3 citiaSurface(vec3 c, vec3 sf) {
  float kind = floor(sf.x + 0.5);
  vec2 st = sf.yz;
  if (kind == 1.0) {
    // Бревно: волокна вдоль, сучки, лёгкая неровность.
    float grain = sin(st.y * 95.0 + sin(st.x * 2.1) * 3.0 + sin(st.x * 7.3) * 0.6) * 0.5 + 0.5;
    grain = mix(grain, 0.5, cFar(st.y * 15.0));
    float blotch = cHash(floor(vec2(st.x * 0.9, st.y * 9.0)));
    return c * (0.9 + 0.12 * grain) * (0.95 + 0.08 * blotch);
  }
  if (kind == 2.0) {
    // Обшивка внахлёст: доска 16 см, тень под нижней кромкой каждой доски.
    float y = st.y / 0.16;
    float f = fract(y);
    float shadow = 1.0 - smoothstep(0.0, 0.2, f);
    shadow = mix(shadow, 0.12, cFar(y));
    return c * (1.0 - 0.34 * shadow) * (0.96 + 0.07 * cHash(vec2(floor(y), 3.0)));
  }
  if (kind == 3.0) {
    // Доски стоймя по 15 см: тёмные щели, разный тон досок.
    float x = st.x / 0.15;
    float f = fract(x);
    float gap = 1.0 - smoothstep(0.0, 0.06, min(f, 1.0 - f));
    gap = mix(gap, 0.1, cFar(x));
    return c * (1.0 - 0.38 * gap) * (0.93 + 0.11 * cHash(vec2(floor(x), 7.0)));
  }
  if (kind == 4.0) {
    // Профнастил: трапециевидные рёбра через 20 см вдоль ската.
    float x = st.x / 0.2;
    float f = fract(x);
    float rib = smoothstep(0.36, 0.42, f) * (1.0 - smoothstep(0.58, 0.64, f));
    float flank = smoothstep(0.3, 0.36, f) * (1.0 - smoothstep(0.36, 0.42, f));
    float v = 0.94 + 0.16 * rib - 0.12 * flank;
    v = mix(v, 0.98, cFar(x));
    return c * v;
  }
  if (kind == 5.0) {
    // Шифер: мелкая волна, листы внахлёст рядами (тень под кромкой), листы чуть разного тона.
    float x = st.x / 0.115;
    float wave = sin(x * 6.2832) * (1.0 - cFar(x));
    float y = st.y / 0.85;
    float lap = (1.0 - smoothstep(0.0, 0.06, fract(y))) * (1.0 - cFar(y * 6.0));
    float sheet = cHash(floor(vec2(st.x / 1.13 + 0.5 * floor(y), y)));
    return c * (0.93 + 0.08 * wave) * (1.0 - 0.28 * lap) * (0.9 + 0.15 * sheet);
  }
  if (kind == 6.0) {
    // Кирпич 250 × 65, швы 12 мм, перевязка вполкирпича.
    float yr = st.y / 0.077;
    float row = floor(yr);
    float x = st.x / 0.262 + 0.5 * mod(row, 2.0);
    float fx = fract(x);
    float fy = fract(yr);
    float joint = max(1.0 - smoothstep(0.02, 0.05, min(fx, 1.0 - fx)), 1.0 - smoothstep(0.06, 0.13, min(fy, 1.0 - fy)));
    joint = mix(joint, 0.22, cFar(yr));
    float b = cHash(vec2(floor(x), row));
    vec3 brick = c * (0.84 + 0.26 * b);
    return mix(brick, c * 0.35 + vec3(0.35, 0.34, 0.31), joint * 0.8);
  }
  if (kind == 7.0) {
    // Войлок: мягкие пятна, тонкие швы полотнищ.
    float n = cNoise(st * 2.5) * 0.6 + cNoise(st * 9.0) * 0.4;
    float seam = (1.0 - smoothstep(0.0, 0.03, abs(fract(st.x / 1.6) - 0.5) * 2.0 - 0.94)) * (1.0 - cFar(st.x * 5.0));
    return c * (0.94 + 0.08 * n) * (1.0 - 0.08 * (1.0 - seam));
  }
  if (kind == 8.0) {
    // Башкирский орнамент: цепочка ромбов с «рогами», светлые кромки пояса.
    vec2 q = vec2(fract(st.x / 0.3) - 0.5, fract(st.y / 0.3) - 0.5);
    float d = abs(q.x) + abs(q.y);
    float far = cFar(st.x / 0.3 * 6.0);
    float ring = (1.0 - smoothstep(0.33, 0.36, d)) * smoothstep(0.2, 0.23, d);
    float core = 1.0 - smoothstep(0.1, 0.13, d);
    float horn = (1.0 - smoothstep(0.03, 0.05, abs(abs(q.x) - 0.38))) * (1.0 - smoothstep(0.08, 0.1, abs(q.y)));
    float edge = 1.0 - smoothstep(0.04, 0.07, min(fract(st.y / 0.3), 1.0 - fract(st.y / 0.3)));
    float m = max(max(ring, core), max(horn, edge));
    vec3 gold = vec3(0.84, 0.66, 0.30);
    return mix(mix(c, gold, m), mix(c, gold, 0.3), far);
  }
  if (kind == 9.0) {
    // Торец бревна: годовые кольца, тёмная кромка коры.
    float r = length(st);
    float rings = sin(r / 0.011 * 6.2832) * 0.5 + 0.5;
    rings = mix(rings, 0.5, cFar(r / 0.011));
    return c * (0.88 + 0.14 * rings) * (1.0 - 0.3 * smoothstep(0.08, 0.13, r));
  }
  if (kind == 11.0) {
    // Трава: крупные пятна посочнее и посуше, мелкая рябь.
    float big = cNoise(st / 3.0) * 0.55 + cNoise(st / 1.1) * 0.3;
    float small = mix(cNoise(st * 7.0), 0.5, cFar(st.x * 7.0));
    vec3 dry = c * vec3(1.12, 1.06, 0.82);
    return mix(c, dry, big * 0.8) * (0.93 + 0.12 * small);
  }
  if (kind == 12.0) {
    // Грунтовка: колеи вдоль дороги, мелкий гравий.
    float rut = exp(-pow((fract(st.y / 6.0) - 0.32) / 0.05, 2.0)) + exp(-pow((fract(st.y / 6.0) - 0.68) / 0.05, 2.0));
    float grit = mix(cNoise(st * 14.0), 0.5, cFar(st.x * 14.0)) * 0.6 + cNoise(st * 0.8) * 0.4;
    return c * (1.0 - 0.14 * rut) * (0.9 + 0.16 * grit);
  }
  if (kind == 13.0) {
    // Сруб издалека: венцы — светлые выпуклые полосы с тёмными пазами.
    float y = st.y / 0.22;
    float f = fract(y);
    float bulge = 0.78 + 0.3 * sin(f * 3.14159);
    bulge = mix(bulge, 0.95, cFar(y));
    return c * bulge * (0.95 + 0.08 * cHash(vec2(floor(y), 5.0)));
  }
  if (kind == 10.0) {
    // Штукатурка, побелка: мягкая неровность.
    float n = cNoise(st * 3.0) * 0.6 + cNoise(st * 14.0) * 0.4;
    return c * (0.95 + 0.06 * n);
  }
  return c;
}
`;

const surfaceHook: ShaderHook = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 surface;\nvarying vec3 vSurface;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface = surface;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${SURFACE_GLSL}`)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = citiaSurface(diffuseColor.rgb, vSurface);')
    .replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
float citiaKind = floor(vSurface.x + 0.5);
if (citiaKind == 4.0) { roughnessFactor = 0.42; metalnessFactor = 0.35; }
else if (citiaKind == 5.0 || citiaKind == 7.0) { roughnessFactor = 0.97; }`,
    );
};

const glassHook: ShaderHook = (shader) => {
  shader.uniforms['citiaWindows'] = NIGHT.windows;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 pane;\nvarying vec4 vPane;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPane = pane;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec4 vPane;\nuniform float citiaWindows;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
float citiaCurtain = 0.0;
if (vPane.w > 0.5) {
  // Тюль: подхваченные по бокам полотнища и ламбрекен сверху, мелкий узор кружева.
  float u = vPane.x;
  float v = vPane.y;
  float tie = exp(-pow((v - 0.42) / 0.12, 2.0));
  float side = 0.24 - 0.1 * tie;
  float drape = max(1.0 - smoothstep(side - 0.02, side, u), smoothstep(1.0 - side, 1.0 - side + 0.02, u));
  float valance = smoothstep(0.83, 0.85, v);
  float lace = 0.82 + 0.18 * sin(u * 150.0) * sin(v * 150.0);
  citiaCurtain = max(drape, valance) * 0.88;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.78, 0.74) * lace, citiaCurtain);
}`,
    )
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.9, citiaCurtain);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, citiaCurtain);')
    .replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
// Вечером горит часть окон: у каждого своё время; за тюлем свет мягче и шире.
float citiaLit = step(vPane.z, citiaWindows * 0.6);
vec3 citiaLamp = mix(vec3(1.0, 0.52, 0.2), vec3(1.0, 0.7, 0.38), fract(vPane.z * 7.0));
totalEmissiveRadiance += citiaLamp * citiaLit * (1.1 + 0.9 * citiaCurtain);`,
    );
};

export interface HouseMaterials {
  solid: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  /** Материал таблички с надписью (кэш по тексту и цветам). */
  sign(text: string, background: string, color: string, aspect: number): MeshStandardMaterial;
  dispose(): void;
}

export function createHouseMaterials(csm: CSM | undefined): HouseMaterials {
  const solid = new MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 });
  hookMaterial(solid, 'village-house', surfaceHook, csm);
  const glass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.45, envMapIntensity: 1.3 });
  hookMaterial(glass, 'village-glass', glassHook, csm);
  const signs = new Map<string, MeshStandardMaterial>();
  return {
    solid,
    glass,
    sign(text, background, color, aspect) {
      const key = `${text}|${background}|${color}|${aspect.toFixed(1)}`;
      let material = signs.get(key);
      if (!material) {
        const map = signTexture(text, background, color, aspect);
        // Вечером надписи чуть подсвечены (как вывески на фасадах города).
        material = new MeshStandardMaterial({ map, roughness: 0.55, emissiveMap: map, emissive: '#ffffff', emissiveIntensity: 0 });
        hookMaterial(material, 'village-sign', signHook, csm);
        signs.set(key, material);
      }
      return material;
    },
    dispose() {
      solid.dispose();
      glass.dispose();
      for (const material of signs.values()) {
        material.map?.dispose();
        material.dispose();
      }
    },
  };
}

/** Вечером табличка светится слегка — как подсвеченная вывеска. */
const signHook: ShaderHook = (shader) => {
  shader.uniforms['citiaWindows'] = NIGHT.windows;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float citiaWindows;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * citiaWindows * 0.35;');
};

/** Надпись на табличке: фон, светлая рамка, текст по центру (строки — через «\n»), подобранный по ширине. */
function signTexture(text: string, background: string, color: string, aspect: number): CanvasTexture {
  const lines = text.split('\n');
  // Пропорции холста — как у таблички (ширина / высота), иначе буквы сплющит.
  const width = 1024;
  const height = Math.max(48, Math.min(1024, Math.round(width / Math.max(aspect, 0.25))));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  const inset = Math.max(4, Math.round(height * 0.08));
  ctx.lineWidth = Math.max(3, Math.round(height * 0.035));
  ctx.strokeRect(inset, inset, width - 2 * inset, height - 2 * inset);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rowH = height / lines.length;
  lines.forEach((line, i) => {
    let size = Math.min(rowH * (lines.length > 1 ? 0.72 : 0.62), 140);
    ctx.font = `700 ${size}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    while (ctx.measureText(line).width > width - 48 && size > 12) {
      size -= 2;
      ctx.font = `700 ${size}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    }
    ctx.fillText(line, width / 2, rowH * (i + 0.5) + 2);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export interface HouseMesh {
  group: Group;
  triangles: number;
  dispose(): void;
}

/** Меши дома в осях three.js (дом в начале координат, улица — со стороны +z). */
export function buildHouseMesh(plan: HousePlan, materials: HouseMaterials): HouseMesh {
  return buildPartsMesh(plan.parts, materials, `house:${plan.id}`);
}

/** Геометрия из частей: стены, крыша, резьба (атрибут surface) и стёкла (атрибут pane). */
export function buildHouseGeometries(parts: readonly HousePart[]): { solid: BufferGeometry; glass: BufferGeometry; triangles: number } {
  const solid = new Buffers(3);
  const glass = new Buffers(4);
  for (const part of parts) addPart(solid, glass, part);
  return {
    solid: solid.geometry('surface'),
    glass: glass.geometry('pane'),
    triangles: (solid.position.length + glass.position.length) / 9,
  };
}

/** Меши из любых частей (дом, двор, земля под ним). */
export function buildPartsMesh(parts: readonly HousePart[], materials: HouseMaterials, name: string): HouseMesh {
  const built = buildHouseGeometries(parts);
  const group = new Group();
  group.name = name;
  const meshes = [new Mesh(built.solid, materials.solid), new Mesh(built.glass, materials.glass)];
  // Таблички: плоскость с надписью лицом наружу (в осях three: (x, z, −y), поворот вокруг вертикали).
  for (const part of parts) {
    if (part.type !== 'sign') continue;
    const mesh = new Mesh(new PlaneGeometry(part.size[0], part.size[2]), materials.sign(part.text, part.background, part.color, part.size[0] / part.size[2]));
    mesh.position.set(part.center[0], part.center[2], -part.center[1]);
    mesh.rotation.y = part.angle;
    meshes.push(mesh);
  }
  for (const mesh of meshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return {
    group,
    triangles: built.triangles,
    dispose() {
      for (const mesh of meshes) mesh.geometry.dispose();
    },
  };
}

/** Единичный икосаэдр (треугольники в осях дома: x, y, z — вверх) для кустов и крон. */
const UNIT_BLOBS = ([0, 1] as const).map((detail) => {
  const g = new IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  const points: Vec3[] = [];
  // У three ось вверх — y: переводим в оси дома (x, −z, y).
  for (let i = 0; i < p.count; i++) points.push([p.getX(i), -p.getZ(i), p.getY(i)]);
  g.dispose();
  return points;
});

/** Низкополигональный эллипсоид с плоскими гранями — как кроны деревьев в сцене. */
function addBlob(buf: Buffers, p: BlobPart): void {
  const color = toColor(p.color);
  const c = Math.cos(p.angle ?? 0);
  const s = Math.sin(p.angle ?? 0);
  const [rx, ry, rz] = p.radii;
  const place = ([x, y, z]: Vec3): Vec3 => {
    const lx = x * rx;
    const ly = y * ry;
    return [p.center[0] + lx * c - ly * s, p.center[1] + lx * s + ly * c, p.center[2] + z * rz];
  };
  const unit = UNIT_BLOBS[p.detail ?? 1]!;
  const st = (q: Vec3) => [0, q[0], q[1]];
  for (let i = 0; i + 2 < unit.length; i += 3) {
    const a = place(unit[i]!);
    const b = place(unit[i + 1]!);
    const d = place(unit[i + 2]!);
    // Нормаль грани — наружу от центра (обход выправит Buffers).
    let n = norm(cross(sub(b, a), sub(d, a)));
    const mid = mul(add(add(a, b), d), 1 / 3);
    if (dot(n, sub(mid, p.center)) < 0) n = mul(n, -1);
    buf.tri(a, b, d, n, color, [st(a), st(b), st(d)]);
  }
}

function addPart(solid: Buffers, glass: Buffers, part: HousePart): void {
  if (part.type === 'box') addBox(solid, part);
  else if (part.type === 'blob') addBlob(solid, part);
  else if (part.type === 'cylinder') addCylinder(solid, part);
  else if (part.type === 'slab') addSlab(solid, part);
  else if (part.type === 'glass') addGlass(glass, part);
  // Таблички рисуются отдельными мешами с текстурой (buildPartsMesh).
}
