// Уличная обстановка: фонари, скамейки, разметка и зебры, памятник Салавату Юлаеву.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { World } from '../core/data';
import type { P2 } from '../core/geo';
import type { RingIndex, RoadIndex } from '../core/spatial';
import type { HeightMap } from './terrain';
import { isPaved } from './terrain';

export interface Lamp {
  x: number;
  z: number;
  /** Направление к дороге. */
  dx: number;
  dz: number;
}

/** Фонари вдоль улиц: в городе — по обеим сторонам через ~34 м, в деревне — редкие столбы по одной стороне. */
export function placeLamps(world: World, footprints: RingIndex): Lamp[] {
  const city = world.territory.kind === 'city';
  const lamps: Lamp[] = [];
  const step = city ? 34 : 58;
  for (const road of world.roads) {
    if (road.highway === 'service' || road.highway.endsWith('_link')) continue;
    const offset = city ? road.width / 2 + 1.5 : road.width * 0.35 + 2.4;
    let carry = step / 2;
    let side = 1;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
      let t = carry;
      for (; t < len; t += step) {
        const x = a[0] + ux * t - uz * offset * side, z = a[1] + uz * t + ux * offset * side;
        if (footprints.find(x, z) < 0) lamps.push({ x, z, dx: uz * side, dz: -ux * side });
        if (city) side = -side;
      }
      carry = t - len;
    }
  }
  for (const [x, z] of world.lamps) lamps.push({ x, z, dx: 1, dz: 0 });
  return lamps;
}

function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,236,200,1)');
  g.addColorStop(0.25, 'rgba(255,200,130,0.45)');
  g.addColorStop(1, 'rgba(255,160,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

function coloured(geometry: BufferGeometry, hex: string): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

export interface Props {
  group: Group;
  /** Каждый кадр: сила свечения фонарей 0..1. */
  setLamps: (k: number) => void;
  /** Земля поменялась: фонари, скамейки и разметка в прямоугольнике — на новую высоту. */
  reseat: (area: { x0: number; z0: number; x1: number; z1: number }) => void;
  dispose: () => void;
}

export function createProps(world: World, hm: HeightMap, lamps: readonly Lamp[], roads: RoadIndex, paths: RoadIndex): Props {
  const city = world.territory.kind === 'city';
  const group = new Group();
  group.name = 'props';
  const disposables: { dispose: () => void }[] = [];
  const m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), one = new Vector3(1, 1, 1), pos = new Vector3();
  const plain = new MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 });
  disposables.push(plain);

  // Фонари.
  const H = city ? 7.6 : 6.2;
  const poleGeometry = mergeGeometries([
    coloured(new CylinderGeometry(city ? 0.06 : 0.1, city ? 0.1 : 0.13, H, 6).translate(0, H / 2, 0), city ? '#3a3d42' : '#5a4634'),
    coloured(new BoxGeometry(1.5, 0.07, 0.07).translate(0.7, H - 0.1, 0), '#3a3d42'),
    coloured(new BoxGeometry(0.5, 0.1, 0.22).translate(1.35, H - 0.16, 0), '#2c2e32'),
  ])!;
  const poles = new InstancedMesh(poleGeometry, plain, lamps.length);
  const bulbMaterial = new MeshStandardMaterial({ color: 0x222222, emissive: new Color(1, 0.74, 0.42), emissiveIntensity: 0 });
  const bulbs = new InstancedMesh(new BoxGeometry(0.42, 0.05, 0.16).translate(1.35, H - 0.23, 0), bulbMaterial, lamps.length);
  const glowPos = new Float32Array(lamps.length * 3);
  lamps.forEach((l, i) => {
    const y = hm.at(l.x, l.z);
    q.setFromAxisAngle(up, Math.atan2(-l.dz, l.dx));
    m.compose(pos.set(l.x, y - 0.2, l.z), q, one);
    poles.setMatrixAt(i, m);
    bulbs.setMatrixAt(i, m);
    glowPos.set([l.x + l.dx * 1.35, y + H - 0.45, l.z + l.dz * 1.35], i * 3);
  });
  poles.castShadow = true;
  const glowGeometry = new BufferGeometry();
  glowGeometry.setAttribute('position', new BufferAttribute(glowPos, 3));
  const glowMap = glowTexture();
  const glowMaterial = new PointsMaterial({ map: glowMap, size: 5.5, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending, fog: false });
  const glow = new Points(glowGeometry, glowMaterial);
  glow.visible = false;
  group.add(poles, bulbs, glow);
  disposables.push(poleGeometry, bulbs.geometry, bulbMaterial, glowGeometry, glowMaterial, glowMap);

  // Скамейки.
  let benchMesh: InstancedMesh | undefined;
  let markMesh: Mesh | undefined;
  if (world.benches.length) {
    const benchGeometry = mergeGeometries([
      coloured(new BoxGeometry(1.8, 0.07, 0.45).translate(0, 0.45, 0), '#7a5a3c'),
      coloured(new BoxGeometry(1.8, 0.4, 0.06).translate(0, 0.78, -0.22), '#7a5a3c'),
      coloured(new BoxGeometry(0.08, 0.45, 0.42).translate(-0.75, 0.22, 0), '#2c2e32'),
      coloured(new BoxGeometry(0.08, 0.45, 0.42).translate(0.75, 0.22, 0), '#2c2e32'),
    ])!;
    const benches = new InstancedMesh(benchGeometry, plain, world.benches.length);
    world.benches.forEach(([x, z], i) => {
      const near = paths.nearest(x, z, 12) ?? roads.nearest(x, z, 20);
      q.setFromAxisAngle(up, near ? Math.atan2(-near.dz, near.dx) + (near.dx * (z - near.z) - near.dz * (x - near.x) > 0 ? 0 : Math.PI) : i);
      m.compose(pos.set(x, hm.at(x, z), z), q, one);
      benches.setMatrixAt(i, m);
    });
    benches.castShadow = true;
    benchMesh = benches;
    group.add(benches);
    disposables.push(benchGeometry);
  }

  // Разметка: осевая прерывистая и зебры — тонкие полосы, уложенные по рельефу.
  const mark: number[] = [];
  const quad = (cx: number, cz: number, ux: number, uz: number, halfLen: number, halfWid: number) => {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const x = cx + ux * a * halfLen - uz * b * halfWid, z = cz + uz * a * halfLen + ux * b * halfWid;
      return [x, hm.at(x, z) + 0.035, z];
    });
    mark.push(...c[0], ...c[2], ...c[1], ...c[0], ...c[3], ...c[2]);
  };
  for (const road of world.roads) {
    if (!isPaved(world, road) || road.oneway || road.width < 6.5 || road.highway === 'service' || !city) continue;
    let carry = 2;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.01) continue;
      const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
      let t = carry;
      for (; t < len; t += 8) quad(a[0] + ux * t, a[1] + uz * t, ux, uz, 1.5, 0.09);
      carry = t - len;
    }
  }
  for (const crossing of world.crossings) {
    const mid: P2 = crossing[Math.floor(crossing.length / 2)];
    const hit = roads.nearest(mid[0], mid[1], 8);
    if (!hit) continue;
    const n = Math.max(3, Math.floor(hit.road.width / 0.95));
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 0.95;
      quad(hit.x - hit.dz * off, hit.z + hit.dx * off, hit.dx, hit.dz, 1.7, 0.24);
    }
  }
  if (mark.length) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(mark), 3));
    geometry.computeVertexNormals();
    const material = new MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const mesh = new Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
    markMesh = mesh;
    disposables.push(geometry, material);
  }

  const inside = (a: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1;
  return {
    reseat: (area) => {
      lamps.forEach((l, i) => {
        if (!inside(area, l.x, l.z)) return;
        const y = hm.at(l.x, l.z);
        for (const mesh of [poles, bulbs]) {
          mesh.getMatrixAt(i, m);
          m.elements[13] = y - 0.2;
          mesh.setMatrixAt(i, m);
          mesh.instanceMatrix.needsUpdate = true;
        }
        glowPos[i * 3 + 1] = y + H - 0.45;
        glowGeometry.getAttribute('position').needsUpdate = true;
      });
      world.benches.forEach(([x, z], i) => {
        if (!benchMesh || !inside(area, x, z)) return;
        benchMesh.getMatrixAt(i, m);
        m.elements[13] = hm.at(x, z);
        benchMesh.setMatrixAt(i, m);
        benchMesh.instanceMatrix.needsUpdate = true;
      });
      const p = markMesh?.geometry.getAttribute('position') as BufferAttribute | undefined;
      if (p) {
        for (let v = 0; v < p.count; v++) if (inside(area, p.getX(v), p.getZ(v))) p.setY(v, hm.at(p.getX(v), p.getZ(v)) + 0.035);
        p.needsUpdate = true;
      }
    },
    group,
    setLamps: (k) => {
      bulbMaterial.emissiveIntensity = k * 6;
      glowMaterial.opacity = k * 0.9;
      glow.visible = k > 0.01;
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
