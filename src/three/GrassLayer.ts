// Трава у самых ног: пучки травинок вокруг камеры (на прогулке, за рулём и при низком облёте).
// Пучки разложены по клеткам мира (у каждой клетки — свой посев, поэтому трава не «плывёт» за камерой)
// и рисуются одним InstancedMesh. Где расти — решает сама земля: шейдер берёт цвет покрытия под пучком
// из текстуры земли и оставляет траву только на зелёном (на дорогах, дворах, грядках и воде её нет),
// а цвет травинок — от того же покрытия, поэтому трава не спорит с землёй. Освещение — как у земли
// (нормаль вверх), вдали пучки плавно уменьшаются до нуля.

import { BufferAttribute, BufferGeometry, DoubleSide, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type CanvasTexture, type Vector4 } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import type { CityScene } from './CityScene';
import type { GroundArea } from './merged';
import { hookMaterial } from './shaderHooks';

/** Клетка посева, м. */
const CELL = 8;
/** Радиус травы вокруг точки у ног, м (дальше — земля с текстурой). */
const RADIUS = 38;
/** Выше этого над землёй травы не видно — слой не рисуется, м. */
const MAX_EYE = 140;
/** Сколько клеток держать в памяти. */
const CACHE = 600;

export type GrassDensity = 'high' | 'normal';
const TUFTS_PER_M2: Record<GrassDensity, number> = { high: 4, normal: 1.8 };

const UP = new Vector3(0, 1, 0);

/** Посев клетки: x, высота земли, y (локальные метры), поворот, размер — по 5 чисел на пучок. */
type Cell = Float32Array;

function seeded(ix: number, iy: number): () => number {
  let s = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Пучок: несколько травинок разной высоты и наклона (высота пучка — 1, ширина — по месту). */
function tuftGeometry(): BufferGeometry {
  const r = seeded(7, 11);
  const positions: number[] = [];
  const tips: number[] = [];
  const BLADES = 9;
  for (let b = 0; b < BLADES; b++) {
    const angle = (b / BLADES) * Math.PI * 2 + r() * 0.8;
    const dist = 0.02 + r() * 0.1;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const h = 0.55 + r() * 0.45;
    const w = 0.022 + r() * 0.014;
    // Травинка смотрит в свою сторону и клонится наружу.
    const face = angle + Math.PI / 2 + (r() - 0.5) * 0.9;
    const fx = Math.cos(face) * w;
    const fz = Math.sin(face) * w;
    const lean = 0.12 + r() * 0.22;
    const lx = Math.cos(angle) * lean;
    const lz = Math.sin(angle) * lean;
    const mid = 0.55;
    // Низ — четырёхугольник до середины, верх — треугольник к кончику.
    const v = (px: number, py: number, pz: number, t: number) => {
      positions.push(px, py, pz);
      tips.push(t);
    };
    const m = (k: number) => [x + lx * k * k, h * k, z + lz * k * k] as const;
    const [mx, my, mz] = m(mid);
    const [tx, ty, tz] = m(1);
    v(x - fx, 0, z - fz, 0), v(x + fx, 0, z + fz, 0), v(mx + fx * 0.7, my, mz + fz * 0.7, mid);
    v(x - fx, 0, z - fz, 0), v(mx + fx * 0.7, my, mz + fz * 0.7, mid), v(mx - fx * 0.7, my, mz - fz * 0.7, mid);
    v(mx - fx * 0.7, my, mz - fz * 0.7, mid), v(mx + fx * 0.7, my, mz + fz * 0.7, mid), v(tx, ty, tz, 1);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  // Нормаль — вверх: трава освещена как земля под ней и не «мигает» гранями.
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('tip', new BufferAttribute(new Float32Array(tips), 1));
  return geometry;
}

export class GrassLayer {
  readonly group = new Group();
  private readonly mesh: InstancedMesh;
  private readonly material: MeshStandardMaterial;
  private readonly cells = new Map<string, Cell>();
  private readonly time = { value: 0 };
  private readonly radius = { value: RADIUS };
  private readonly capacity: number;
  private shown = '';
  private enabled = true;
  private readonly stopAnimator: () => void;

  constructor(
    private readonly city: CityScene,
    private readonly heightAt: (x: number, y: number) => number,
    lands: readonly { texture: CanvasTexture; rect: Vector4 }[],
    csm: CSM,
    private density: GrassDensity = 'high',
  ) {
    const span = Math.ceil(RADIUS / CELL) * 2 + 2;
    this.capacity = Math.ceil(span * span * CELL * CELL * TUFTS_PER_M2.high * 0.85);
    this.material = new MeshStandardMaterial({ roughness: 1, metalness: 0, side: DoubleSide });
    hookMaterial(
      this.material,
      'grass',
      (shader) => {
        lands.forEach((level, i) => {
          shader.uniforms[`landMap${i}`] = { value: level.texture };
          shader.uniforms[`landRect${i}`] = { value: level.rect };
        });
        shader.uniforms['grassTime'] = this.time;
        shader.uniforms['grassRadius'] = this.radius;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            /* glsl */ `#include <common>
attribute float tip;
uniform sampler2D landMap0;
uniform sampler2D landMap1;
uniform sampler2D landMap2;
uniform sampler2D landMap3;
uniform vec4 landRect0;
uniform vec4 landRect1;
uniform vec4 landRect2;
uniform vec4 landRect3;
uniform float grassTime;
uniform float grassRadius;
varying vec3 vGrass;
vec2 grassUv(vec2 p, vec4 r) { return (p - r.xy) / max(r.zw - r.xy, vec2(1e-3)); }
float grassWeight(vec2 uv) { vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, 0.06, min(e.x, e.y)); }`,
          )
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
vec3 rootW = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
vec2 landP = vec2(rootW.x, -rootW.z);
vec2 u0 = grassUv(landP, landRect0), u1 = grassUv(landP, landRect1), u2 = grassUv(landP, landRect2), u3 = grassUv(landP, landRect3);
vec4 land = textureLod(landMap0, u0, 0.0);
land = mix(land, textureLod(landMap1, u1, 0.0), grassWeight(u1) * step(1.0, landRect1.z - landRect1.x));
land = mix(land, textureLod(landMap2, u2, 0.0), grassWeight(u2) * step(1.0, landRect2.z - landRect2.x));
land = mix(land, textureLod(landMap3, u3, 0.0), grassWeight(u3) * step(1.0, landRect3.z - landRect3.x));
// Трава — только на зелёном: дороги серые, дворы и грядки бурые, вода синяя.
float green = smoothstep(0.004, 0.03, land.g - max(land.r, land.b * 1.05));
float fade = 1.0 - smoothstep(grassRadius * 0.62, grassRadius, distance(rootW.xz, cameraPosition.xz));
float grow = green * fade;
transformed *= grow;
// Ветер: кончики качаются, у каждого пучка — своя фаза.
float sway = sin(grassTime * 1.6 + rootW.x * 0.35 + rootW.z * 0.27) + 0.45 * sin(grassTime * 3.1 + rootW.x * 0.9);
transformed.xz += vec2(0.055, 0.035) * sway * tip * tip * grow;
// Цвет — от земли: у корня темнее, к кончику — светлее и чуть желтее.
// Земля в текстуре бледнее живой травы: насыщенность чуть поднимаем.
vec3 leaf = land.rgb * mix(0.5, 1.12, tip);
float grey = dot(leaf, vec3(0.299, 0.587, 0.114));
vGrass = max(mix(vec3(grey), leaf, 1.45), 0.0) + vec3(-0.004, 0.006, -0.006) * tip;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = vGrass;');
      },
      csm,
    );
    this.mesh = new InstancedMesh(tuftGeometry(), this.material, this.capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.group.name = 'grass';
    this.group.add(this.mesh);
    city.scene.add(this.group);
    this.stopAnimator = city.addAnimator(() => {
      this.update();
      return false;
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.update();
    this.city.requestRender();
  }

  setDensity(density: GrassDensity): void {
    if (density === this.density) return;
    this.density = density;
    this.cells.clear();
    this.shown = '';
    this.update();
    this.city.requestRender();
  }

  /** Земля поменялась (кисть рельефа): посев в этом месте — заново, на новой высоте. */
  shiftGround(_delta: unknown, area: GroundArea): void {
    for (const key of [...this.cells.keys()]) {
      const [ix, iy] = key.split(':').map(Number) as [number, number];
      if ((ix + 1) * CELL < area.x0 || ix * CELL > area.x1 || (iy + 1) * CELL < area.y0 || iy * CELL > area.y1) continue;
      this.cells.delete(key);
    }
    this.shown = '';
  }

  private update(): void {
    this.time.value = performance.now() / 1000;
    const camera = this.city.camera.position;
    const x = camera.x;
    const y = -camera.z;
    const eye = camera.y - this.heightAt(x, y);
    const visible = this.enabled && eye < MAX_EYE;
    if (this.mesh.visible !== visible) this.mesh.visible = visible;
    if (!visible) return;
    // Середина травы — чуть впереди камеры (сзади её не видно).
    const look = new Vector3();
    this.city.camera.getWorldDirection(look);
    const flat = Math.hypot(look.x, look.z) || 1;
    const ahead = RADIUS * 0.35;
    const cx = x + (look.x / flat) * ahead;
    const cy = y - (look.z / flat) * ahead;
    const i0 = Math.floor((cx - RADIUS) / CELL);
    const i1 = Math.floor((cx + RADIUS) / CELL);
    const j0 = Math.floor((cy - RADIUS) / CELL);
    const j1 = Math.floor((cy + RADIUS) / CELL);
    const key = `${i0}:${j0}:${i1}:${j1}`;
    if (key === this.shown) return;
    this.shown = key;
    const matrix = new Matrix4();
    const rotation = new Quaternion();
    const position = new Vector3();
    const scale = new Vector3();
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        // Только клетки, задевающие круг радиуса RADIUS.
        const dx = Math.max(0, Math.abs(cx - (i + 0.5) * CELL) - CELL / 2);
        const dy = Math.max(0, Math.abs(cy - (j + 0.5) * CELL) - CELL / 2);
        if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
        const cell = this.cell(i, j);
        for (let k = 0; k < cell.length && n < this.capacity; k += 5) {
          position.set(cell[k]!, cell[k + 1]!, -cell[k + 2]!);
          rotation.setFromAxisAngle(UP, cell[k + 3]!);
          const s = cell[k + 4]!;
          scale.set(s * 1.6, s, s * 1.6);
          this.mesh.setMatrixAt(n++, matrix.compose(position, rotation, scale));
        }
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private cell(i: number, j: number): Cell {
    const key = `${i}:${j}`;
    let cell = this.cells.get(key);
    if (cell) {
      // Свежие — в конец (вытесняются самые давние).
      this.cells.delete(key);
      this.cells.set(key, cell);
      return cell;
    }
    const r = seeded(i, j);
    const count = Math.round(CELL * CELL * TUFTS_PER_M2[this.density] * (0.8 + r() * 0.4));
    cell = new Float32Array(count * 5);
    for (let k = 0; k < count; k++) {
      const x = (i + r()) * CELL;
      const y = (j + r()) * CELL;
      // Высота пучка 0,25–0,6 м; изредка — высокий бурьян.
      const size = r() < 0.04 ? 0.6 + r() * 0.3 : 0.18 + r() * 0.24;
      cell.set([x, this.heightAt(x, y) - 0.03, y, r() * Math.PI * 2, size], k * 5);
    }
    this.cells.set(key, cell);
    if (this.cells.size > CACHE) this.cells.delete(this.cells.keys().next().value!);
    return cell;
  }

  destroy(): void {
    this.stopAnimator();
    this.city.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
