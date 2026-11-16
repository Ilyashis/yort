// Деревья (лиственные с кроной из нескольких «облаков», ели ярусами, лесные —
// упрощённые): по одному InstancedMesh на форму — десятки тысяч деревьев за несколько вызовов
// отрисовки. Деревья на пятне новых домов и дорог прячутся (экземпляр сжимается в точку).

import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import type { TreePoint } from '../world/base/environment';
import { pointsInsideAreas } from '../world/base/hiding';
import { planTree, type TreeShape } from '../world/base/treeParts';
import type { LonLat } from '../world/user/plot';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import type { GroundArea, GroundDelta } from './merged';
import { hookMaterial } from './shaderHooks';
import { LITE } from '../config/device';

const UP = new Vector3(0, 1, 0);
const ZERO = new Matrix4().makeScale(0, 0, 0);
/**
 * Деревья — кусками по TILE м (на каждый кусок и форму — свой InstancedMesh): невидимые куски отсекаются
 * и в кадре, и в каждом каскаде теней. Раньше все деревья формы были одним мешем — его рисовали целиком
 * везде, в том числе четыре раза в тени.
 */
const TILE = 250;
/** Тени отбрасывают куски ближе этого к камере, м: дальние тени в дымке не видны, а стоят дорого. */
const SHADOW_REACH = LITE ? 250 : 450;
/** Куски дальше этого не рисуем вовсе — вдали их и так съедает дымка, м: в обзоре (телефон) и на улице. */
export const treeReach = (street: boolean): number => (street ? (LITE ? 800 : 1500) : LITE ? 2200 : Infinity);
/** Пересчитать, кто отбрасывает тень, когда камера сдвинулась на столько, м. */
const SHADOW_RECHECK = 25;

export class TreesLayer {
  private readonly unskipAo: () => void;
  readonly group = new Group();
  /** Меши по ключу «форма:кусок». */
  private readonly meshes = new Map<string, InstancedMesh>();
  private readonly matrices = new Map<string, Matrix4[]>();
  /** У каждого дерева — его части: (ключ меша, номер экземпляра). */
  private readonly parts: [string, number][][] = [];
  private readonly lastCheck = new Vector3(Infinity, 0, 0);
  /** Лиственные кроны: летние цвета экземпляров (зимой кроны серо-бурые, без листвы — с инеем сверху). */
  private readonly summerColors = new Map<InstancedMesh, Float32Array>();
  private winter = false;
  private readonly removeAnimator: () => void;
  private readonly positions: LonLat[];
  private hidden: boolean[];
  private viewReach = treeReach(false);

  constructor(
    private readonly city: CityScene,
    points: readonly TreePoint[],
    /** С этого номера — лесные деревья (упрощённые). */
    forestFrom: number,
    frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    csm: CSM,
  ) {
    // Телефон: кроны и стволы грубее — деревьев тысячи, это большая часть треугольников сцены.
    const geometries: Record<TreeShape, BufferGeometry> = LITE
      ? {
          trunk: new CylinderGeometry(0.022, 0.03, 0.42, 4),
          blob: new SphereGeometry(1, 7, 5),
          cone: new ConeGeometry(1, 1, 7),
          forestCrown: new SphereGeometry(1, 5, 4),
          forestCone: new ConeGeometry(1, 1, 5),
        }
      : {
          trunk: new CylinderGeometry(0.022, 0.03, 0.42, 6),
          blob: new SphereGeometry(1, 9, 7),
          cone: new ConeGeometry(1, 1, 9),
          forestCrown: new SphereGeometry(1, 7, 5),
          forestCone: new ConeGeometry(1, 1, 7),
        };
    const colors = new Map<string, Color[]>();
    const shapeOf = new Map<string, TreeShape>();
    const palette = new Map<string, Color>();
    const base = new Matrix4();
    const part = new Matrix4();
    const rotation = new Quaternion();
    this.positions = points.map(([lon, lat]) => [lon, lat]);
    this.hidden = points.map(() => false);

    points.forEach((point, i) => {
      const plan = planTree(point, i >= forestFrom);
      const [x, y] = frame.toLocal([point[0], point[1]]);
      base.compose(new Vector3(x, heightAt(x, y), -y), rotation.setFromAxisAngle(UP, plan.rotation), new Vector3(plan.height, plan.height, plan.height));
      const refs: [string, number][] = [];
      const tile = `${Math.floor(x / TILE)}:${Math.floor(y / TILE)}`;
      for (const p of plan.parts) {
        part.compose(new Vector3(p.at[0], p.at[2], -p.at[1]), new Quaternion(), new Vector3(p.scale[0], p.scale[2], p.scale[1]));
        let color = palette.get(p.color);
        if (!color) palette.set(p.color, (color = new Color(p.color)));
        const key = `${p.shape}:${tile}`;
        shapeOf.set(key, p.shape);
        const list = this.matrices.get(key) ?? [];
        refs.push([key, list.length]);
        list.push(base.clone().multiply(part));
        this.matrices.set(key, list);
        const colorList = colors.get(key) ?? [];
        colorList.push(color);
        colors.set(key, colorList);
      }
      this.parts.push(refs);
    });

    this.group.name = 'trees';
    // Материал — один на форму (на все куски).
    const materials = new Map<TreeShape, MeshStandardMaterial>();
    for (const [key, list] of this.matrices) {
      const shape = shapeOf.get(key)!;
      let material = materials.get(shape);
      if (!material) {
        material = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
        hookMaterial(material, `tree-${shape}`, undefined, csm);
        materials.set(shape, material);
      }
      const mesh = new InstancedMesh(geometries[shape], material, list.length);
      const shapeColors = colors.get(key)!;
      list.forEach((matrix, k) => {
        mesh.setMatrixAt(k, matrix);
        mesh.setColorAt(k, shapeColors[k]!);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
    city.scene.add(this.group);
    this.unskipAo = city.skipAo(this.group);
    this.removeAnimator = city.addAnimator(() => {
      this.updateShadows();
      return false;
    });
  }

  /** Зима: лиственные кроны — голые ветви (серо-бурые, иней сверху даёт общий снег); ели — как есть, со снегом на лапах. */
  setWinter(winter: boolean): void {
    if (winter === this.winter) return;
    this.winter = winter;
    for (const [key, mesh] of this.meshes) {
      const shape = key.slice(0, key.indexOf(':'));
      if ((shape !== 'blob' && shape !== 'forestCrown') || !mesh.instanceColor) continue;
      const colors = mesh.instanceColor.array as Float32Array;
      if (winter) {
        this.summerColors.set(mesh, colors.slice());
        for (let i = 0; i < mesh.count; i++) {
          // Ветви: серо-бурые, у каждого дерева свой оттенок.
          const k = 0.75 + ((i * 2654435761) % 1000) / 1000 / 2;
          colors[i * 3] = 0.24 * k;
          colors[i * 3 + 1] = 0.21 * k;
          colors[i * 3 + 2] = 0.19 * k;
        }
      } else {
        const summer = this.summerColors.get(mesh);
        if (summer) colors.set(summer);
      }
      mesh.instanceColor.needsUpdate = true;
    }
    this.city.requestRender();
  }

  /** Дальше этого куски не рисуются, м (на улице — ближе, чем в обзоре). */
  setViewReach(reach: number): void {
    this.viewReach = reach;
    this.lastCheck.set(Infinity, 0, 0);
    this.city.requestRender();
  }

  /** Тень — только у кусков рядом с камерой; на телефоне дальние куски не рисуются. */
  private updateShadows(): void {
    const camera = this.city.camera.position;
    if (camera.distanceTo(this.lastCheck) < SHADOW_RECHECK) return;
    this.lastCheck.copy(camera);
    for (const mesh of this.meshes.values()) {
      const sphere = mesh.boundingSphere;
      const distance = sphere ? camera.distanceTo(sphere.center) - sphere.radius : 0;
      mesh.castShadow = distance < SHADOW_REACH;
      mesh.visible = distance < this.viewReach;
    }
  }

  get count(): number {
    return this.parts.length;
  }

  /** Спрятать деревья в этих областях (lon/lat) с запасом margin метров, остальные вернуть. */
  /** extra — области без запаса (уже раздвинутые прямоугольники домов-моделей): так быстрее. */
  hideWithin(areas: readonly (readonly LonLat[])[], margin: number, extra: readonly (readonly LonLat[])[] = []): void {
    const next = pointsInsideAreas(this.positions, areas, margin);
    if (extra.length) pointsInsideAreas(this.positions, extra, 0).forEach((inside, i) => (next[i] ||= inside));
    const touched = new Set<InstancedMesh>();
    next.forEach((hide, i) => {
      if (hide === this.hidden[i]) return;
      this.hidden[i] = hide;
      for (const [key, k] of this.parts[i] ?? []) {
        const mesh = this.meshes.get(key)!;
        mesh.setMatrixAt(k, hide ? ZERO : this.matrices.get(key)![k]!);
        touched.add(mesh);
      }
    });
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
    if (touched.size) this.city.requestRender();
  }

  /** Земля поменялась (кисть рельефа): деревья в area — вверх или вниз вместе с ней. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    const touched = new Set<InstancedMesh>();
    this.parts.forEach((list, i) => {
      for (const [key, k] of list) {
        const matrix = this.matrices.get(key)![k]!;
        const x = matrix.elements[12]!;
        const y = -matrix.elements[14]!;
        if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) continue;
        const d = delta(x, y);
        if (!d) continue;
        matrix.elements[13]! += d;
        if (this.hidden[i]) continue;
        const mesh = this.meshes.get(key)!;
        mesh.setMatrixAt(k, matrix);
        touched.add(mesh);
      }
    });
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  destroy(): void {
    this.removeAnimator();
    this.unskipAo();
    this.city.scene.remove(this.group);
    // Геометрия и материал — общие на форму: освобождаем по одному разу.
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<MeshStandardMaterial>();
    for (const mesh of this.meshes.values()) {
      geometries.add(mesh.geometry);
      materials.add(mesh.material as MeshStandardMaterial);
      mesh.dispose();
    }
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }
}
