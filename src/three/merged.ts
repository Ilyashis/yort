// Много мелких одноцветных фигур (ящики деталей, столбы, скамейки) одной геометрией: один вызов
// отрисовки. У каждого владельца (дом, двор, фонарь) — свои диапазоны вершин: их можно спрятать
// (вершины сводятся в точку — исчезают и тени) и вернуть, не пересобирая геометрию.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import type { DetailBox } from '../world/base/buildingDetails';
import { hookMaterial, type ShaderHook } from './shaderHooks';

const UNIT_BOX = new BoxGeometry(1, 1, 1).toNonIndexed();
const UP = new Vector3(0, 1, 0);

export class MergedBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private readonly ranges = new Map<string, [number, number][]>();
  private readonly v = new Vector3();
  private readonly normalMatrix = new Matrix3();

  /** Добавить фигуру (геометрия three.js в своих осях) с преобразованием matrix. */
  add(geometry: BufferGeometry, matrix: Matrix4, color: Color, owner: string): void {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    this.normalMatrix.getNormalMatrix(matrix);
    const start = this.positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      this.v.fromBufferAttribute(position, i).applyMatrix4(matrix);
      this.positions.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(normal, i).applyMatrix3(this.normalMatrix).normalize();
      this.normals.push(this.v.x, this.v.y, this.v.z);
      this.colors.push(color.r, color.g, color.b);
    }
    const list = this.ranges.get(owner) ?? [];
    list.push([start, position.count]);
    this.ranges.set(owner, list);
  }

  /**
   * Ящик детали (локальные метры): центр (z — от земли ground), размеры [вдоль, наружу, высота],
   * angle — направление вдоль стены от востока против часовой, tilt — наклон вокруг оси «наружу».
   */
  addBox(box: DetailBox, ground: number, color: Color, owner: string): void {
    const [x, y, z] = box.center;
    const [w, d, h] = box.size;
    // В three: вдоль → X, вверх → Y, наружу → −Z (север в three — это −Z).
    const rotation = new Quaternion().setFromAxisAngle(UP, box.angle);
    if (box.tilt) rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, -1), box.tilt));
    const matrix = new Matrix4().compose(new Vector3(x, ground + z, -y), rotation, new Vector3(w, h, d));
    this.add(UNIT_BOX, matrix, color, owner);
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /** hook — своя вставка в шейдер (например, свечение ночью). */
  build(name: string, csm: CSM | undefined, hook?: ShaderHook): MergedMesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.computeBoundingSphere();
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    hookMaterial(material, `merged-${name}`, hook, csm);
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.positions = [];
    this.normals = [];
    this.colors = [];
    return new MergedMesh(mesh, this.ranges);
  }
}

export class MergedMesh {
  private readonly original: Float32Array;
  private readonly hidden = new Set<string>();

  constructor(
    readonly mesh: Mesh,
    private readonly ranges: ReadonlyMap<string, [number, number][]>,
  ) {
    this.original = (mesh.geometry.getAttribute('position').array as Float32Array).slice();
  }

  get owners(): IterableIterator<string> {
    return this.ranges.keys();
  }

  /** Спрятать владельцев, для которых hide() — true; остальных показать. true — если что-то поменялось. */
  setHidden(hide: (owner: string) => boolean): boolean {
    const attribute = this.mesh.geometry.getAttribute('position') as BufferAttribute;
    const array = attribute.array as Float32Array;
    let changed = false;
    for (const [owner, ranges] of this.ranges) {
      const want = hide(owner);
      if (want === this.hidden.has(owner)) continue;
      changed = true;
      if (want) this.hidden.add(owner);
      else this.hidden.delete(owner);
      for (const [start, count] of ranges) {
        for (let v = start; v < start + count; v++) {
          const src = want ? start : v;
          array[v * 3] = this.original[src * 3]!;
          array[v * 3 + 1] = this.original[src * 3 + 1]!;
          array[v * 3 + 2] = this.original[src * 3 + 2]!;
        }
      }
    }
    if (changed) attribute.needsUpdate = true;
    return changed;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}
