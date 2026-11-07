// Собирает 3D-модель конной статуи (scripts/lib/salavat-statue.mjs) в public/models/salavat-yulaev.glb:
// сетка из поля расстояний (surface nets), тонкие детали трубками, нормали по градиенту поля,
// в цвете вершин — затенение в складках и патина (зеленее сверху, где бронзу моет дождь).
//
//   npm run models:statue            (или node scripts/sculpt-statue.mjs [--step=0.015])

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { statue, STATUE_BOX, TUBES } from './lib/salavat-statue.mjs';
import { surfaceNets } from './lib/surface-nets.mjs';
import { writeGlb } from './lib/glb.mjs';

const OUTPUT = 'public/models/salavat-yulaev.glb';
/** Высота статуи в сцене, м (от низа бронзового основания до верха камчи) — как у памятника. */
const HEIGHT = 9.8;
const stepFlag = process.argv.find((a) => a.startsWith('--step='));
/** Шаг решётки в натуральную величину: 2 см → ~5 см на статуе высотой 9,8 м (нормали — по полю, так что гладко). */
const STEP = stepFlag ? Number(stepFlag.split('=')[1]) : 0.02;

const BRONZE = [0.36, 0.25, 0.15];
const BRONZE_DARK = [0.16, 0.11, 0.07];
const PATINA = [0.33, 0.45, 0.38];

const started = Date.now();
const surface = surfaceNets(statue, STATUE_BOX, STEP);
console.log(`Сетка: ${surface.positions.length / 3} вершин, ${surface.indices.length / 3} треугольников за ${((Date.now() - started) / 1000).toFixed(1)} с`);

// --- нормали, затенение и цвет вершин поверхности ----------------------------------------------
const count = surface.positions.length / 3;
const normals = new Float32Array(count * 3);
const colors = new Uint8Array(count * 4);
const e = STEP * 0.25;
for (let v = 0; v < count; v++) {
  const x = surface.positions[v * 3];
  const y = surface.positions[v * 3 + 1];
  const z = surface.positions[v * 3 + 2];
  let nx = statue(x + e, y, z) - statue(x - e, y, z);
  let ny = statue(x, y + e, z) - statue(x, y - e, z);
  let nz = statue(x, y, z + e) - statue(x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  normals.set([nx, ny, nz], v * 3);
  // Затенение в складках: насколько поле вдоль нормали «недобирает» расстояние.
  let occlusion = 0;
  for (let i = 1; i <= 5; i++) {
    const h = 0.012 * i;
    occlusion += ((h - statue(x + nx * h, y + ny * h, z + nz * h)) / h) * (1 / 2 ** i);
  }
  const ao = Math.min(1, Math.max(0, 1 - occlusion * 1.6));
  colors.set(bronzeColor(nz, ao), v * 4);
}
fixWinding(surface.positions, surface.indices, normals);

// --- трубки: камча, поводья, уздечка, стремена --------------------------------------------------
const tubes = TUBES.map((tube) => tubeMesh(tube.points, tube.radius, tube.closed));
const parts = [{ positions: surface.positions, normals, colors, indices: surface.indices }, ...tubes];
const merged = merge(parts);

// --- в координаты glTF: y — вверх, вперёд коня — −z; масштаб до HEIGHT --------------------------
let top = -Infinity;
for (let v = 0; v < merged.positions.length; v += 3) top = Math.max(top, merged.positions[v + 2]);
const scale = HEIGHT / top;
/** Начало координат модели — центр пьедестала под статуей (чуть позади копыт). */
const ORIGIN_Y = -0.12;
const positions = new Float32Array(merged.positions.length);
const normalsOut = new Float32Array(merged.normals.length);
for (let v = 0; v < merged.positions.length; v += 3) {
  const [x, y, z] = [merged.positions[v], merged.positions[v + 1], merged.positions[v + 2]];
  positions.set([x * scale, z * scale, -(y - ORIGIN_Y) * scale], v);
  const [nx, ny, nz] = [merged.normals[v], merged.normals[v + 1], merged.normals[v + 2]];
  normalsOut.set([nx, nz, -ny], v);
}

const glb = writeGlb({
  positions,
  normals: normalsOut,
  colors: merged.colors,
  indices: merged.indices,
  material: { name: 'bronze', metallicFactor: 0.55, roughnessFactor: 0.5 },
  generator: 'Citia scripts/sculpt-statue.mjs',
});
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, glb);
console.log(
  `Готово: ${OUTPUT} — ${(glb.length / 1024 / 1024).toFixed(1)} МБ, ${positions.length / 3} вершин, ` +
    `${merged.indices.length / 3} треугольников, масштаб ×${scale.toFixed(2)} за ${((Date.now() - started) / 1000).toFixed(1)} с`,
);

// --- помощники -------------------------------------------------------------------------------------

/** Цвет бронзы: тёмная в складках, патина на открытых сверху местах. */
function bronzeColor(up, ao) {
  const patina = Math.max(0, Math.min(1, (up - 0.15) * 1.1)) * 0.55 * ao;
  const out = [0, 1, 2].map((k) => {
    const base = BRONZE_DARK[k] + (BRONZE[k] - BRONZE_DARK[k]) * ao;
    return base + (PATINA[k] - base) * patina;
  });
  // В вершинах — линейный цвет 0..255 (glTF COLOR_0 линейный).
  return [...out.map((c) => Math.round(Math.min(1, c) * 255)), 255];
}

/** Треугольники поворачиваем наружу: по нормали поля в вершинах. */
function fixWinding(positions, indices, normals) {
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    let dot = 0;
    for (const i of [a, b, c]) dot += fx * normals[i * 3] + fy * normals[i * 3 + 1] + fz * normals[i * 3 + 2];
    if (dot < 0) {
      indices[t + 1] = c;
      indices[t + 2] = b;
    }
  }
}

/** Трубка вдоль гладкой кривой через точки (Катмулл — Ром), 8 граней, концы закрыты. */
function tubeMesh(points, radius, closed = false) {
  const pts = closed ? [...points, points[0]] : points;
  const curve = [];
  const at = (i) => (closed ? pts[(i + pts.length - 1) % (pts.length - 1)] : pts[Math.max(0, Math.min(pts.length - 1, i))]);
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s < 6; s++) {
      const t = s / 6;
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      curve.push([0, 1, 2].map((k) => catmull(p0[k], p1[k], p2[k], p3[k], t)));
    }
  }
  curve.push(closed ? curve[0] : pts[pts.length - 1]);
  const SIDES = 8;
  const positions = [];
  const normals = [];
  const indices = [];
  let prevSide;
  curve.forEach((p, i) => {
    const q = curve[Math.min(i + 1, curve.length - 1)];
    const o = curve[Math.max(i - 1, 0)];
    const dir = norm([q[0] - o[0], q[1] - o[1], q[2] - o[2]]);
    // Поперечная ось без скачков: проекция предыдущей на новую плоскость.
    let side = prevSide ?? (Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    side = norm(sub(side, scaleVec(dir, dotVec(side, dir))));
    prevSide = side;
    const other = cross(dir, side);
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      const n = [0, 1, 2].map((c) => side[c] * Math.cos(a) + other[c] * Math.sin(a));
      positions.push(...p.map((c, j) => c + n[j] * radius));
      normals.push(...n);
    }
  });
  for (let i = 0; i < curve.length - 1; i++) {
    for (let k = 0; k < SIDES; k++) {
      const a = i * SIDES + k;
      const b = i * SIDES + ((k + 1) % SIDES);
      indices.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
    }
  }
  if (!closed) {
    for (const [ring, sign] of [[0, -1], [curve.length - 1, 1]]) {
      const centre = positions.length / 3;
      const p = curve[ring];
      const q = curve[ring - sign] ?? curve[ring];
      const dir = norm([p[0] - q[0], p[1] - q[1], p[2] - q[2]]);
      positions.push(...p.map((c, j) => c + dir[j] * radius * 0.5));
      normals.push(...dir);
      for (let k = 0; k < SIDES; k++) {
        const a = ring * SIDES + k;
        const b = ring * SIDES + ((k + 1) % SIDES);
        indices.push(...(sign > 0 ? [a, b, centre] : [b, a, centre]));
      }
    }
  }
  const n = positions.length / 3;
  const color = bronzeColor(0.3, 0.9);
  const colors = new Uint8Array(n * 4);
  for (let v = 0; v < n; v++) colors.set(color, v * 4);
  const mesh = { positions: new Float32Array(positions), normals: new Float32Array(normals), colors, indices: new Uint32Array(indices) };
  fixWinding(mesh.positions, mesh.indices, mesh.normals);
  return mesh;
}

function merge(parts) {
  const vertexCount = parts.reduce((s, p) => s + p.positions.length / 3, 0);
  const indexCount = parts.reduce((s, p) => s + p.indices.length, 0);
  const out = {
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    colors: new Uint8Array(vertexCount * 4),
    indices: new Uint32Array(indexCount),
  };
  let v = 0;
  let i = 0;
  for (const p of parts) {
    out.positions.set(p.positions, v * 3);
    out.normals.set(p.normals, v * 3);
    out.colors.set(p.colors, v * 4);
    for (let k = 0; k < p.indices.length; k++) out.indices[i + k] = p.indices[k] + v;
    v += p.positions.length / 3;
    i += p.indices.length;
  }
  return out;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}
function sub(a, b) {
  return a.map((x, i) => x - b[i]);
}
function scaleVec(a, s) {
  return a.map((x) => x * s);
}
function dotVec(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
