// Накопитель треугольников зданий: локальные метры (x — восток, y — север, z — вверх) → three.js
// (x, z, −y), нормаль наружу, цвет и атрибуты фасада (для шейдера окон facadeShader.ts),
// у каждого треугольника — номер владельца (для выбора кликом).

import { BufferAttribute, BufferGeometry, type Color } from 'three';

/** Накопитель треугольников: локальные метры → three.js, у каждого треугольника — владелец. */
export class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  facade: number[] = [];
  style: number[] = [];
  owners: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  triangle(a: number[], b: number[], c: number[], outward: number[] | undefined, color: Color, facade: number[], style: number[], owner: number): void {
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    let n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (l < 1e-9) return;
    n = n.map((x) => x / l);
    if (outward && n[0]! * outward[0]! + n[1]! * outward[1]! + n[2]! * outward[2]! < 0) {
      [b, c] = [c, b];
      n = n.map((x) => -x);
    }
    for (const p of [a, b, c]) {
      this.positions.push(p[0]!, p[2]!, -p[1]!);
      this.normals.push(n[0]!, n[2]!, -n[1]!);
      this.colors.push(color.r, color.g, color.b);
      this.facade.push(...facade);
      this.style.push(...style);
    }
    this.owners.push(owner);
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    g.setAttribute('facade', new BufferAttribute(new Float32Array(this.facade), 4));
    g.setAttribute('facadeStyle', new BufferAttribute(new Float32Array(this.style), 4));
    g.computeBoundingSphere();
    return g;
  }
}
