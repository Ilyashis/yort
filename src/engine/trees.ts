// Деревья: модели в стиле первой версии (src/engine/treeModels.ts), расставленные инстансами по плиткам.
// Отдельные деревья из OSM, парки, лес (упрощённые модели) и деревья во дворах деревни.

import { Color, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { World } from '../core/data';
import { centroid, pointInPoly, rng, signedArea, type P2 } from '../core/geo';
import type { RingIndex, RoadIndex } from '../core/spatial';
import type { Building } from './buildings';
import { shared } from './shared';
import { solidTreeModels, VARIANTS, type Species } from './treeModels';
import type { HeightMap } from './terrain';

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
    // Упрощённые (лесные) — только в лесных массивах; в деревне — полноценные деревья, как в первой версии.
    const dense = forests.some((g) => pointInPoly(t.x, t.z, g.rings));
    // Модели: берёза — 9,6 м высотой и 2 м радиусом, ель — 10,2 и 2,9 м.
    const s = Math.min(2.6, Math.max(0.25, t.height / (t.spruce ? 10.2 : 9.6)));
    // Сплошные кроны (как в первой версии) не сжимаем в узкие «яйца»: ширина — в пределах 0,9…1,35 высоты модели.
    const wide = Math.min(1.35, Math.max(0.9, t.radius / (t.spruce ? 2.9 : 2.0) / s));
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
  const geometries = solidTreeModels(false);
  const distant = solidTreeModels(true);
  // Сплошные кроны без карточек листвы: не мерцают на ходу, тени — от объёма.
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
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
