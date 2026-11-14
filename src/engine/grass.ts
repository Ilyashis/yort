// Трава: пучки травинок плитками вокруг камеры. Где расти и какого цвета быть, пучок узнаёт в шейдере
// по тем же маскам, что и земля (поэтому правка дороги сразу «выкашивает» траву), а высоту земли и
// контуры домов — на процессоре, когда плитка создаётся. Вдали пучки редеют и сходят на нет: дальше
// землю красит сам материал рельефа тем же цветом.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  type Camera,
} from 'three';
import { rng } from '../core/geo';
import type { RingIndex } from '../core/spatial';
import { ORTHO_GLSL, type OrthoUniforms } from './ortho';
import { NOISE_GLSL, shared, type Rect } from './shared';
import { groundColours, type HeightMap, type Masks } from './terrain';

/** Сторона плитки, м. */
const TILE = 16;
/** Пучков на квадратный метр. */
const DENSITY = 7;
/** Дальше этого травы нет, м. */
const FAR = 56;
/** Выше этого над землёй траву не рисуем: её всё равно не видно. */
const MAX_ALTITUDE = FAR * 0.85;
const BLADES = 7;

/** Ключ прореживания пучка — тот же, что в шейдере. */
const thinKey = (seed: number) => (seed * 7.31) % 1;
/** Доля пучков, которая остаётся на расстоянии d (как в шейдере). */
function keptAt(d: number): number {
  const t = Math.min(1, Math.max(0, (d - 9) / (FAR * 0.7 - 9)));
  return 1 - 0.88 * t * t * (3 - 2 * t);
}

/** Один пучок: травинки веером, каждая — сужающаяся полоска из двух звеньев. Высота 0..1. */
function tuftGeometry(): { position: Float32Array; side: Float32Array; index: number[] } {
  const r = rng(909);
  const position: number[] = [], side: number[] = [], index: number[] = [];
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + r() * 0.9;
    const d = 0.05 + r() * 0.3;
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
    // Травинка клонится наружу от середины пучка, поперёк — её ширина.
    const lean = 0.1 + r() * 0.22;
    const lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const turn = a + Math.PI / 2 + (r() - 0.5) * 1.2;
    const wx = Math.cos(turn) * 0.021, wz = Math.sin(turn) * 0.021;
    const shade = r();
    const tall = 0.45 + r() * 0.55;
    const base = position.length / 3;
    const rows: [number, number][] = [[0, 1], [0.5, 0.72], [1, 0]];
    for (const [t, w] of rows) {
      const x = cx + lx * t * t, y = t * tall, z = cz + lz * t * t;
      if (w === 0) {
        position.push(x, y, z);
        side.push(0, 0, shade);
      } else {
        position.push(x, y, z, x, y, z);
        side.push(-wx * w, -wz * w, shade, wx * w, wz * w, shade);
      }
    }
    index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  return { position: new Float32Array(position), side: new Float32Array(side), index };
}

export interface Grass {
  group: Group;
  /** Каждый кадр: подтянуть плитки к камере. */
  update: (camera: Camera) => void;
  /** Земля в прямоугольнике поменялась: плитки пересоздаются. */
  refresh: (area: Rect) => void;
  /** Поменялись дома (правки): плитки пересоздаются с новыми контурами. */
  setFootprints: (footprints: RingIndex) => void;
  /** Спрятать вместе с домами и деревьями (сверка с подложкой). */
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}

export function createGrass(hm: HeightMap, masks: Masks, rect: Rect, city: boolean, footprints: RingIndex, ortho: OrthoUniforms): Grass {
  const group = new Group();
  group.name = 'grass';
  const tuft = tuftGeometry();
  const normals = new Float32Array(tuft.position.length).map((_, i) => (i % 3 === 1 ? 1 : 0));

  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: DoubleSide });
  const uniforms = {
    uMaskA: { value: masks.a },
    uMaskB: { value: masks.b },
    uMaskC: { value: masks.c },
    uRect: { value: [rect.x0, rect.z0, rect.x1 - rect.x0, rect.z1 - rect.z0] },
    uGroundA: { value: groundColours(city).a },
    uGroundB: { value: groundColours(city).b },
    uLawn: { value: groundColours(city).lawn },
    uWood: { value: groundColours(city).wood },
    uTime: shared.uTime,
    uTall: { value: city ? 0.26 : 0.42 },
    uFar: { value: FAR },
    ...ortho,
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec4 aRoot;
        attribute vec3 aSide;
        uniform sampler2D uMaskA, uMaskB, uMaskC;
        uniform vec4 uRect;
        uniform vec3 uGroundA, uGroundB, uLawn, uWood;
        uniform float uTime, uTall, uFar;
        varying vec3 vGrass;
        ${NOISE_GLSL}
        ${ORTHO_GLSL}`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 root = aRoot.xyz;
        float seed = aRoot.w;
        vec2 muv = (root.xz - uRect.xy) / uRect.zw;
        float inMask = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
        vec3 mA = texture2D(uMaskA, muv).rgb * inMask;
        vec3 mB = texture2D(uMaskB, muv).rgb * inMask;
        vec3 mC = texture2D(uMaskC, muv).rgb * inMask;
        float bare = max(max(mA.r, mA.g), max(max(mA.b, mB.b), mC.b));
        float lawn = smoothstep(0.3, 0.7, mB.r);
        float wood = smoothstep(0.3, 0.7, mB.g);
        float nBig = fbm(root.xz * 0.011);
        float nMid = vnoise(root.xz * 0.31);
        float patchy = vnoise(root.xz * 0.085 + 31.0);
        float camD = distance(root, cameraPosition);

        // Вдали пучков меньше, зато они шире — поле остаётся сплошным.
        float thin = smoothstep(9.0, uFar * 0.7, camD);
        // Пучок не пропадает разом, а плавно уходит в землю: иначе на ходу поле мерцает.
        float keep = clamp((1.0 - 0.88 * thin - fract(seed * 7.31)) / 0.14, 0.0, 1.0);
        // Изредка — высокий пучок бурьяна, на газоне трава ровная и короткая.
        float weed = step(0.93, fract(seed * 29.3)) * (1.0 - lawn);
        float tall = mix(uTall * (0.35 + 1.25 * patchy), 0.14, lawn) * (1.0 - 0.4 * wood) * (0.6 + 0.8 * fract(seed * 13.7)) * (1.0 + 1.3 * weed);
        tall *= (1.0 - smoothstep(0.2, 0.42, bare)) * keep * (1.0 - smoothstep(uFar * 0.72, uFar, camD));
        float widen = 1.0 + 3.2 * thin;
        // По снимку с дрона: трава цвета настоящей земли, а на вытоптанном и голом (не зелёном) — ниже и реже.
        vec4 photo = orthoAt(root.xz);
        float photoK = photo.a * (1.0 - smoothstep(0.2, 0.6, mC.g));
        float green = smoothstep(-0.03, 0.04, photo.g - max(photo.r, photo.b));
        tall *= mix(1.0, 0.15 + 0.85 * green, photoK);

        float ang = seed * 50.0;
        float ca = cos(ang), sa = sin(ang);
        vec3 local = vec3(position.x + aSide.x * widen, position.y, position.z + aSide.y * widen);
        local.xz = vec2(local.x * ca - local.z * sa, local.x * sa + local.z * ca) * (0.8 + 0.5 * fract(seed * 3.7));
        float y = position.y;

        // Ветер: по полю идут волны порывов, каждая травинка ещё и дрожит сама.
        vec2 wdir = normalize(vec2(1.0, 0.35));
        float gust = vnoise(root.xz * 0.055 - wdir * uTime * 0.55);
        float wave = (gust - 0.35) * 0.9 + sin(uTime * 2.4 + root.x * 0.9 + root.z * 1.3 + seed * 6.0) * 0.1;
        vec3 transformed = root + vec3(local.x, 0.0, local.z) * step(0.001, tall);
        transformed.y += y * tall;
        transformed.xz += wdir * wave * y * y * tall * 0.75;
        transformed.y -= abs(wave) * y * y * tall * 0.14;

        vec3 g = mix(uGroundA, uGroundB, smoothstep(0.32, 0.68, nBig)) * (0.84 + 0.26 * nMid);
        g = mix(g, uLawn * (0.86 + 0.24 * nMid), lawn);
        g = mix(g, uWood * (0.8 + 0.4 * nMid), wood);
        g = mix(g, photo.rgb, photoK);
        float tone = 0.72 + 0.56 * fract(seed * 17.9) * (0.6 + 0.8 * aSide.z);
        vec3 tip = mix(g * 1.38, vec3(0.14, 0.27, 0.065), 0.6) * tone + vec3(0.004, 0.02, 0.0);
        tip = mix(tip, vec3(0.34, 0.3, 0.12), (0.2 + 0.6 * weed) * step(0.55, fract(seed * 3.3 + aSide.z)) * (1.0 - lawn));
        vGrass = mix(g * 0.42, tip, smoothstep(0.0, 0.85, y)) * (1.0 + 0.3 * (gust - 0.4) * y);
        vGrass *= 1.0 - 0.55 * mC.g;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGrass;')
      // Травинка освещена как земля под ней, с какой стороны на неё ни смотри.
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };

  interface Tile {
    mesh: Mesh;
    cx: number;
    cz: number;
    count: number;
  }
  const tiles = new Map<string, Tile>();
  let prints = footprints;
  const perTile = Math.round(TILE * TILE * DENSITY);

  const build = (ix: number, iz: number): Tile | null => {
    const x0 = ix * TILE, z0 = iz * TILE;
    const r = rng(((ix * 73856093) ^ (iz * 19349663)) >>> 0);
    // Пучки идут по порядку «кто дольше остаётся при прореживании»: вдали плитке хватает первых из них.
    const seeds = Array.from({ length: perTile }, () => r()).sort((a, b) => thinKey(a) - thinKey(b));
    const roots = new Float32Array(perTile * 4);
    let n = 0, lo = Infinity, hi = -Infinity;
    for (const seed of seeds) {
      const x = x0 + r() * TILE, z = z0 + r() * TILE;
      if (prints.find(x, z) >= 0) continue;
      const y = hm.at(x, z);
      roots.set([x, y, z, seed], n * 4);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
      n++;
    }
    if (!n) return null;
    const geometry = new InstancedBufferGeometry();
    // Буферы у каждой плитки свои: общий удалился бы вместе с первой убранной плиткой.
    geometry.setAttribute('position', new BufferAttribute(tuft.position, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('aSide', new BufferAttribute(tuft.side, 3));
    geometry.setIndex(tuft.index);
    geometry.setAttribute('aRoot', new InstancedBufferAttribute(roots.subarray(0, n * 4), 4));
    geometry.instanceCount = n;
    geometry.boundingSphere = new Sphere(new Vector3(x0 + TILE / 2, (lo + hi) / 2, z0 + TILE / 2), TILE * 0.75 + (hi - lo) / 2 + 1);
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    return { mesh, cx: x0 + TILE / 2, cz: z0 + TILE / 2, count: n };
  };

  const drop = (key: string) => {
    const tile = tiles.get(key);
    if (!tile) return;
    group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tiles.delete(key);
  };
  /** Пустые плитки (целиком под домом) помним, чтобы не пересоздавать каждый кадр. */
  const empty = new Set<string>();
  const clear = () => {
    for (const key of [...tiles.keys()]) drop(key);
    empty.clear();
  };

  const forward = new Vector3();
  let shown = true;
  return {
    group,
    update: (camera) => {
      const p = camera.position;
      const altitude = p.y - hm.at(p.x, p.z);
      const high = altitude > MAX_ALTITUDE;
      group.visible = shown && !high;
      if (!group.visible) return;
      camera.getWorldDirection(forward);
      // С высоты трава видна только в круге под камерой: дальше она уже сошла на нет.
      const reach = Math.sqrt(Math.max(0, FAR * FAR - altitude * altitude)) + TILE;
      const cx = p.x, cz = p.z;
      // Сначала ближние плитки, не больше нескольких за кадр — чтобы не было рывка.
      const missing: [number, number, number][] = [];
      for (let ix = Math.floor((cx - reach) / TILE); ix <= Math.floor((cx + reach) / TILE); ix++) {
        for (let iz = Math.floor((cz - reach) / TILE); iz <= Math.floor((cz + reach) / TILE); iz++) {
          const key = `${ix},${iz}`;
          if (tiles.has(key) || empty.has(key)) continue;
          const d = Math.hypot((ix + 0.5) * TILE - p.x, (iz + 0.5) * TILE - p.z);
          if (d <= reach) missing.push([d, ix, iz]);
        }
      }
      missing.sort((m, n) => m[0] - n[0]);
      for (const [, ix, iz] of missing.slice(0, tiles.size ? 4 : 12)) {
        const tile = build(ix, iz);
        if (tile) tiles.set(`${ix},${iz}`, tile);
        else empty.add(`${ix},${iz}`);
      }
      for (const tile of tiles.values()) {
        const flat = Math.max(0, Math.hypot(tile.cx - p.x, tile.cz - p.z) - TILE * 0.75);
        const nearest = Math.hypot(flat, altitude);
        (tile.mesh.geometry as InstancedBufferGeometry).instanceCount = Math.min(tile.count, Math.ceil(tile.count * (keptAt(nearest) + 0.04)));
      }
      if (tiles.size > 140) {
        for (const [key, tile] of tiles) if (Math.hypot(tile.cx - p.x, tile.cz - p.z) > reach * 1.6) drop(key);
      }
    },
    refresh: (area) => {
      for (const [key, tile] of tiles) {
        if (tile.cx + TILE / 2 >= area.x0 && tile.cx - TILE / 2 <= area.x1 && tile.cz + TILE / 2 >= area.z0 && tile.cz - TILE / 2 <= area.z1) drop(key);
      }
    },
    setVisible: (visible) => {
      shown = visible;
    },
    setFootprints: (next) => {
      prints = next;
      clear();
    },
    dispose: () => {
      clear();
      material.dispose();
    },
  };
}
