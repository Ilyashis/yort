// Деревья: несколько процедурных моделей, расставленных инстансами по плиткам.
// Отдельные деревья из OSM, парки, лес (упрощённые модели) и деревья во дворах деревни.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { World } from '../core/data';
import { centroid, pointInPoly, rng, signedArea, type P2 } from '../core/geo';
import type { RingIndex, RoadIndex } from '../core/spatial';
import type { Building } from './buildings';
import { shared } from './shared';
import type { HeightMap } from './terrain';

class Parts {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];

  add(geometry: BufferGeometry, colour: (y: number, ny: number) => Color, sphere?: Vector3): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
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
    }
    return this;
  }

  trunk(height: number, r0: number, r1: number, sides: number, hex: string): this {
    const c = new Color(hex);
    return this.add(new CylinderGeometry(r1, r0, height, sides, 1, true).translate(0, height / 2, 0), () => c);
  }

  /** Крона-«облако»: помятый шар, снизу темнее. */
  blob(x: number, y: number, z: number, r: number, ry: number, detail: number, top: string, bottom: string, rnd: () => number): this {
    const g = new IcosahedronGeometry(1, detail);
    const p = g.getAttribute('position');
    const bump = new Map<string, number>();
    for (let i = 0; i < p.count; i++) {
      const key = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
      let k = bump.get(key);
      if (k === undefined) bump.set(key, (k = 0.82 + rnd() * 0.36));
      p.setXYZ(i, x + p.getX(i) * r * k, y + p.getY(i) * r * ry * k, z + p.getZ(i) * r * k);
    }
    const a = new Color(top), b = new Color(bottom), out = new Color();
    return this.add(g, (_y, ny) => out.copy(b).lerp(a, Math.min(1, Math.max(0, ny * 0.6 + 0.5))), new Vector3(x, y - r * 0.2, z));
  }

  cone(y: number, r: number, h: number, sides: number, top: string, bottom: string): this {
    const a = new Color(top), b = new Color(bottom), out = new Color();
    return this.add(new ConeGeometry(r, h, sides, 1, true).translate(0, y + h / 2, 0), (yy) => out.copy(b).lerp(a, (yy - y) / h));
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    return g;
  }
}

type Species = 'leaf' | 'birch' | 'pine' | 'spruce' | 'leafLow' | 'birchLow' | 'pineLow';

function models(): Record<Species, BufferGeometry> {
  const r = rng(77);
  const G = { top: '#5d8a38', bottom: '#27461c' };
  const B = { top: '#7fa244', bottom: '#3a5c26' };
  const P = { top: '#4a6f3a', bottom: '#1f3a22' };
  return {
    leaf: new Parts().trunk(3, 0.24, 0.16, 6, '#4a3a2c')
      .blob(0, 5, 0, 2.5, 0.9, 1, G.top, G.bottom, r).blob(1.5, 4.2, 0.6, 1.8, 0.85, 1, G.top, G.bottom, r)
      .blob(-1.3, 4.4, -0.9, 1.8, 0.85, 1, G.top, G.bottom, r).blob(0.2, 6.5, -0.3, 1.7, 0.9, 1, G.top, G.bottom, r)
      .blob(-0.4, 4.1, 1.5, 1.6, 0.85, 1, G.top, G.bottom, r).build(),
    birch: new Parts().trunk(4.6, 0.14, 0.09, 5, '#d9d6cc')
      .blob(0, 6.2, 0, 1.7, 1.25, 1, B.top, B.bottom, r).blob(0.8, 5, 0.3, 1.3, 1.2, 1, B.top, B.bottom, r)
      .blob(-0.7, 5.3, -0.4, 1.3, 1.2, 1, B.top, B.bottom, r).blob(0, 7.7, 0, 1.0, 1.2, 1, B.top, B.bottom, r).build(),
    pine: new Parts().trunk(6.4, 0.2, 0.12, 6, '#8a5a3a')
      .blob(0, 7.6, 0, 2.0, 0.7, 1, P.top, P.bottom, r).blob(1.0, 6.7, 0.4, 1.4, 0.7, 1, P.top, P.bottom, r)
      .blob(-0.9, 6.9, -0.5, 1.4, 0.7, 1, P.top, P.bottom, r).build(),
    spruce: new Parts().trunk(1.6, 0.2, 0.16, 5, '#4a3a2c')
      .cone(1.2, 2.3, 3.4, 8, '#3f6a3a', '#1c3622').cone(3.2, 1.8, 3.0, 8, '#3f6a3a', '#1c3622')
      .cone(5.0, 1.25, 2.6, 8, '#457040', '#1c3622').cone(6.6, 0.75, 2.2, 7, '#4a7545', '#22402a').build(),
    leafLow: new Parts().trunk(3, 0.22, 0.16, 4, '#4a3a2c')
      .blob(0, 5, 0, 2.6, 0.95, 0, G.top, G.bottom, r).blob(0.9, 6.2, 0.4, 1.7, 0.9, 0, G.top, G.bottom, r).build(),
    birchLow: new Parts().trunk(4.6, 0.14, 0.09, 4, '#d9d6cc')
      .blob(0, 6, 0, 1.8, 1.3, 0, B.top, B.bottom, r).blob(0.3, 7.6, 0.2, 1.1, 1.2, 0, B.top, B.bottom, r).build(),
    pineLow: new Parts().trunk(6.2, 0.2, 0.12, 4, '#8a5a3a')
      .blob(0, 7.4, 0, 2.0, 0.75, 0, P.top, P.bottom, r).blob(0.7, 6.4, -0.3, 1.3, 0.7, 0, P.top, P.bottom, r).build(),
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

  for (const [x, z] of world.trees) trees.push({ x, z, s: 0.85 + rnd() * 0.5, species: rnd() < 0.75 ? 'leaf' : 'birch' });

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
            ? { x, z, s: 1 + rnd() * 0.9, species: choose([['birchLow', 0.5], ['pineLow', 0.35], ['leafLow', 0.15]]) }
            : { x, z, s: 0.8 + rnd() * 0.7, species: choose([['leaf', 0.6], ['birch', 0.2], ['spruce', 0.2]]) },
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
        trees.push({ x, z, s: small ? 0.45 + rnd() * 0.2 : 0.75 + rnd() * 0.5, species: small ? 'leaf' : choose([['birch', 0.6], ['leaf', 0.3], ['spruce', 0.1]]) });
      }
    }
  }
  return trees;
}

export function createTrees(ctx: TreeContext): { group: Group; count: number; reseat: (area: { x0: number; z0: number; x1: number; z1: number }) => void; dispose: () => void } {
  const trees = scatter(ctx);
  const geometries = models();
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
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
      #endif`,
    );
  };

  const TILE = 256;
  const buckets = new Map<string, Tree[]>();
  for (const t of trees) {
    const key = `${t.species}|${Math.floor(t.x / TILE)}|${Math.floor(t.z / TILE)}`;
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }

  const group = new Group();
  group.name = 'trees';
  const placed: { mesh: InstancedMesh; list: Tree[] }[] = [];
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
    placed.push({ mesh, list });
    const hero = !species.endsWith('Low');
    mesh.castShadow = hero;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return {
    group,
    count: trees.length,
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
      Object.values(geometries).forEach((g) => g.dispose());
      material.dispose();
      group.children.forEach((c) => (c as InstancedMesh).dispose());
    },
  };
}
