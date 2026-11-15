// Зимние украшения: гирлянды из разноцветных лампочек по карнизам домов (с провисанием между креплениями)
// и ёлка в центре деревни — ярусы хвои, лампочки по спирали, звезда. Лампочки светятся сами: ночью ярко
// (с ореолом от свечения сцены), днём — просто цветные. Все лампочки — одним инстанс-мешем.

import { Color, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { siteOnSlope } from '../world/base/siting';
import { modelPlacement } from '../world/edit/edits';
import { findHouseModel, type HouseModelId } from '../world/village/houseModels';
import { polygonNormal, type HousePart } from '../world/village/houseParts';
import { fitPreset } from '../world/village/villagePlan';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toThree } from './coords';
import { buildHouseGeometries } from './houseMesh';
import type { GroundArea, GroundDelta } from './merged';
import { NIGHT } from './nightUniforms';
import { hookMaterial } from './shaderHooks';

/** Дом с моделью: прямоугольник (первая сторона — фасад), модель, зерно. */
export interface GarlandHouse {
  rect: readonly Vec2[];
  model: HouseModelId;
  seed: number;
}

const BULB_STEP = 0.32;
/** Гирлянда — чуть снаружи стен, под свесом крыши, м. */
const OUTSIDE = 0.32;
const HOOK_STEP = 1.6;
const COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ff9f0a', '#fff4d6'].map((c) => new Color(c));
const TREE_HEIGHT = 9;

/** Карниз модели: самая низкая точка скатов (плит, смотрящих вверх), м от пола. Плоская крыша — её высота. */
function eaveOf(parts: readonly HousePart[]): number | undefined {
  let eave = Infinity;
  for (const p of parts) {
    if (p.type !== 'slab' || p.points.length < 3) continue;
    const n = polygonNormal(p.points);
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    if (n[2] / len < 0.25) continue;
    // Мелкие плиты (козырьки крылец, наличники) — не крыша.
    if (Math.hypot(n[0], n[1], n[2]) / 2 < 6) continue;
    for (const q of p.points) eave = Math.min(eave, q[2]);
  }
  return Number.isFinite(eave) && eave > 1.5 ? eave : undefined;
}

export class GarlandsLayer {
  private readonly group = new Group();
  private readonly bulbMaterial: MeshBasicMaterial;
  private bulbs?: InstancedMesh;
  private tree?: Mesh;
  private readonly treeMaterial: MeshStandardMaterial;
  private readonly eaves = new Map<string, number | undefined>();
  /** Точки лампочек (локальные метры, высота) — для сдвига с землёй. */
  private spots: { x: number; y: number }[] = [];

  constructor(
    private readonly city: CityScene,
    private readonly heightAt: (x: number, y: number) => number,
    csm: CSM | undefined,
  ) {
    this.group.name = 'garlands';
    this.bulbMaterial = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    // Ночью — в разы ярче (свечение сцены даёт ореол), днём — просто цветные.
    hookMaterial(
      this.bulbMaterial,
      'garland-bulbs',
      (shader) => {
        shader.uniforms['citiaLamps'] = NIGHT.lamps;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float citiaLamps;')
          .replace('#include <opaque_fragment>', 'outgoingLight *= 0.8 + 3.2 * citiaLamps;\n#include <opaque_fragment>');
      },
      undefined,
    );
    this.treeMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    // Ёлка: хвоя, на верхушках ярусов — немного снега.
    hookMaterial(
      this.treeMaterial,
      'garland-tree',
      (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
{ vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.89, 0.94), 0.55 * smoothstep(0.82, 0.95, dot(normal, upView))); }`,
        );
      },
      csm,
    );
    this.group.visible = false;
    city.scene.add(this.group);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  /** Гирлянды на этих домах и ёлка в точке tree (локальные метры). */
  build(houses: readonly GarlandHouse[], tree: Vec2 | undefined): void {
    const matrices: Matrix4[] = [];
    const colors: Color[] = [];
    this.spots = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const one = new Vector3(1, 1, 1);
    const bulb = (x: number, y: number, z: number, color: Color, scale = 1) => {
      matrices.push(m.compose(toThree(x, y, z), q, scale === 1 ? one : new Vector3(scale, scale, scale)).clone());
      colors.push(color);
      this.spots.push({ x, y });
    };

    for (const house of houses) {
      const model = findHouseModel(house.model);
      if (!model || (model.group !== 'house' && model.group !== 'public')) continue;
      const place = modelPlacement(house.rect);
      const fit = fitPreset(house.model, place.width, place.depth);
      const key = `${house.model}:${fit.preset}:${house.seed}`;
      if (!this.eaves.has(key)) this.eaves.set(key, eaveOf(model.plan({ seed: house.seed, width: fit.size[0], depth: fit.size[1] }).parts));
      const eave = this.eaves.get(key);
      if (eave === undefined) continue;
      const floor = siteOnSlope(house.rect, this.heightAt).floor;
      const hw = (fit.size[0] * fit.scale[0]) / 2 + OUTSIDE;
      const hd = (fit.size[1] * fit.scale[1]) / 2 + OUTSIDE;
      const t: Vec2 = [Math.cos(place.angle), Math.sin(place.angle)];
      const n: Vec2 = [-t[1], t[0]];
      const at = (u: number, v: number): Vec2 => [place.center[0] + t[0] * u + n[0] * v, place.center[1] + t[1] * u + n[1] * v];
      // По периметру: фасад, бок, зад, другой бок — провисание между креплениями.
      const corners: Vec2[] = [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)];
      let k = (house.seed * 7) % COLORS.length;
      for (let side = 0; side < 4; side++) {
        const a = corners[side]!;
        const b = corners[(side + 1) % 4]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const count = Math.max(2, Math.round(len / BULB_STEP));
        for (let i = 0; i < count; i++) {
          const s = (i / count) * len;
          const sag = 0.16 * Math.sin(Math.PI * ((s % HOOK_STEP) / HOOK_STEP));
          const x = a[0] + ((b[0] - a[0]) * s) / len;
          const y = a[1] + ((b[1] - a[1]) * s) / len;
          bulb(x, y, floor + eave - 0.12 - sag, COLORS[k++ % COLORS.length]!);
        }
      }
    }

    // Ёлка: ствол, ярусы хвои, лампочки по спирали и звезда.
    if (this.tree) {
      this.group.remove(this.tree);
      this.tree.geometry.dispose();
      this.tree = undefined;
    }
    if (tree) {
      const [tx, ty] = tree;
      const ground = this.heightAt(tx, ty);
      const parts: HousePart[] = [{ type: 'cylinder', from: [0, 0, -0.3], to: [0, 0, 1.4], radius: 0.22, segments: 8, color: '#5a4030', surface: 'wood' }];
      const tiers = 6;
      for (let i = 0; i < tiers; i++) {
        const z0 = 1.1 + i * ((TREE_HEIGHT - 2.2) / tiers);
        const r = 2.6 * (1 - i / (tiers + 0.6));
        parts.push({ type: 'cylinder', from: [0, 0, z0], to: [0, 0, z0 + 2.2], radius: r, radiusTop: 0.05, segments: 14, color: i % 2 ? '#1f5a34' : '#245f39' });
      }
      // Хвоя — своим материалом без общего снега (иначе пологие ярусы целиком белые), лишь припорошена.
      const geometry = buildHouseGeometries(parts).solid;
      this.tree = new Mesh(geometry, this.treeMaterial);
      this.tree.castShadow = true;
      this.tree.receiveShadow = true;
      this.tree.name = 'christmas-tree';
      this.tree.position.copy(toThree(tx, ty, ground));
      this.group.add(this.tree);
      // Спираль лампочек — по поверхности ярусов.
      const turns = 7;
      const total = 260;
      for (let i = 0; i < total; i++) {
        const f = i / total;
        const z = 1.4 + f * (TREE_HEIGHT - 1.9);
        const tier = Math.min(tiers - 1, Math.floor((z - 1.1) / ((TREE_HEIGHT - 2.2) / tiers)));
        const z0 = 1.1 + tier * ((TREE_HEIGHT - 2.2) / tiers);
        const r = 2.6 * (1 - tier / (tiers + 0.6)) * Math.max(0.15, 1 - (z - z0) / 2.2) + 0.08;
        const a = f * turns * Math.PI * 2;
        bulb(tx + Math.cos(a) * r, ty + Math.sin(a) * r, ground + z, COLORS[i % COLORS.length]!, 1.3);
      }
      bulb(tx, ty, ground + TREE_HEIGHT + 0.25, new Color('#ffd60a'), 5);
    }

    if (this.bulbs) {
      this.group.remove(this.bulbs);
      this.bulbs.dispose();
    }
    this.bulbs = new InstancedMesh(new IcosahedronGeometry(0.055, 0), this.bulbMaterial, Math.max(1, matrices.length));
    this.bulbs.name = 'garland-bulbs';
    this.bulbs.count = matrices.length;
    matrices.forEach((matrix, i) => {
      this.bulbs!.setMatrixAt(i, matrix);
      // Яркость выше 1 — для свечения ночью.
      this.bulbs!.setColorAt(i, colors[i]!.clone().multiplyScalar(1.6));
    });
    this.bulbs.instanceMatrix.needsUpdate = true;
    if (this.bulbs.instanceColor) this.bulbs.instanceColor.needsUpdate = true;
    this.bulbs.computeBoundingSphere();
    this.group.add(this.bulbs);
    this.city.requestRender();
  }

  get count(): number {
    return this.bulbs?.count ?? 0;
  }

  /** Земля поменялась (кисть рельефа): лампочки и ёлка — вместе с ней. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    const bulbs = this.bulbs;
    if (bulbs) {
      const m = new Matrix4();
      let changed = false;
      this.spots.forEach(({ x, y }, i) => {
        if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) return;
        const d = delta(x, y);
        if (!d) return;
        bulbs.getMatrixAt(i, m);
        m.elements[13]! += d;
        bulbs.setMatrixAt(i, m);
        changed = true;
      });
      if (changed) bulbs.instanceMatrix.needsUpdate = true;
    }
    if (this.tree) {
      const p = this.tree.position;
      const [x, y] = [p.x, -p.z];
      if (x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1) p.y += delta(x, y);
    }
  }

  destroy(): void {
    this.city.scene.remove(this.group);
    this.bulbs?.geometry.dispose();
    this.bulbs?.dispose();
    this.bulbMaterial.dispose();
    this.tree?.geometry.dispose();
    this.treeMaterial.dispose();
  }
}
