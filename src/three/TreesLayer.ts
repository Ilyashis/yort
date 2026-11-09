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

const UP = new Vector3(0, 1, 0);
const ZERO = new Matrix4().makeScale(0, 0, 0);

export class TreesLayer {
  readonly group = new Group();
  private readonly meshes = new Map<TreeShape, InstancedMesh>();
  private readonly matrices = new Map<TreeShape, Matrix4[]>();
  /** У каждого дерева — его части: (форма, номер экземпляра). */
  private readonly parts: [TreeShape, number][][] = [];
  private readonly positions: LonLat[];
  private hidden: boolean[];

  constructor(
    private readonly city: CityScene,
    points: readonly TreePoint[],
    /** С этого номера — лесные деревья (упрощённые). */
    forestFrom: number,
    frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    csm: CSM,
  ) {
    const geometries: Record<TreeShape, BufferGeometry> = {
      trunk: new CylinderGeometry(0.022, 0.03, 0.42, 6),
      blob: new SphereGeometry(1, 9, 7),
      cone: new ConeGeometry(1, 1, 9),
      forestCrown: new SphereGeometry(1, 7, 5),
      forestCone: new ConeGeometry(1, 1, 7),
    };
    const colors = new Map<TreeShape, Color[]>();
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
      const refs: [TreeShape, number][] = [];
      for (const p of plan.parts) {
        part.compose(new Vector3(p.at[0], p.at[2], -p.at[1]), new Quaternion(), new Vector3(p.scale[0], p.scale[2], p.scale[1]));
        let color = palette.get(p.color);
        if (!color) palette.set(p.color, (color = new Color(p.color)));
        const list = this.matrices.get(p.shape) ?? [];
        refs.push([p.shape, list.length]);
        list.push(base.clone().multiply(part));
        this.matrices.set(p.shape, list);
        const colorList = colors.get(p.shape) ?? [];
        colorList.push(color);
        colors.set(p.shape, colorList);
      }
      this.parts.push(refs);
    });

    this.group.name = 'trees';
    for (const [shape, list] of this.matrices) {
      const material = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
      hookMaterial(material, `tree-${shape}`, undefined, csm);
      const mesh = new InstancedMesh(geometries[shape], material, list.length);
      const shapeColors = colors.get(shape)!;
      list.forEach((matrix, k) => {
        mesh.setMatrixAt(k, matrix);
        mesh.setColorAt(k, shapeColors[k]!);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.meshes.set(shape, mesh);
      this.group.add(mesh);
    }
    city.scene.add(this.group);
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
      for (const [shape, k] of this.parts[i] ?? []) {
        const mesh = this.meshes.get(shape)!;
        mesh.setMatrixAt(k, hide ? ZERO : this.matrices.get(shape)![k]!);
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
      for (const [shape, k] of list) {
        const matrix = this.matrices.get(shape)![k]!;
        const x = matrix.elements[12]!;
        const y = -matrix.elements[14]!;
        if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) continue;
        const d = delta(x, y);
        if (!d) continue;
        matrix.elements[13]! += d;
        if (this.hidden[i]) continue;
        const mesh = this.meshes.get(shape)!;
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
    this.city.scene.remove(this.group);
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as MeshStandardMaterial).dispose();
      mesh.dispose();
    }
  }
}
