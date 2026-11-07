import { describe, expect, it } from 'vitest';
import { writeGlb } from './glb.mjs';
import { cone, smin, sphere } from './sdf.mjs';
import { surfaceNets } from './surface-nets.mjs';

const box = { min: [-1.2, -1.2, -1.2], max: [1.2, 1.2, 1.2] };

function stats({ positions, indices }) {
  const edges = new Map();
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const p = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = [p(a), p(b), p(c)];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  const open = [...edges.values()].filter((n) => n !== 2).length;
  return { open, volume };
}

describe('лепка полем расстояний', () => {
  it('шар: замкнутая сетка, вершины на поверхности, объём как у шара', () => {
    const mesh = surfaceNets(sphere([0, 0, 0], 1), box, 0.05);
    const { open, volume } = stats(mesh);
    expect(open).toBe(0);
    // Ориентация граней здесь не задана (её правит сборщик по нормалям) — сравниваем модуль.
    expect(Math.abs(volume)).toBeGreaterThan(0.97 * ((4 / 3) * Math.PI));
    expect(Math.abs(volume)).toBeLessThan(1.01 * ((4 / 3) * Math.PI));
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
      expect(Math.abs(r - 1)).toBeLessThan(0.01);
    }
  });

  it('конус и мягкое объединение — точные расстояния', () => {
    const c = cone([0, 0, 0], [0, 0, 1], 0.3, 0.1);
    expect(c(0, 0, -0.3)).toBeCloseTo(0, 6); // низ — полусфера радиуса 0,3
    expect(c(0, 0, 1.1)).toBeCloseTo(0, 6); // верх — полусфера радиуса 0,1
    expect(c(0, 0, 0.5)).toBeLessThan(0);
    expect(smin(1, 1, 0.4)).toBeCloseTo(0.9, 6); // наплыв k/4 там, где формы сходятся
    expect(smin(0, 5, 0.4)).toBe(0);
  });

  it('GLB: заголовок, куски и габариты', () => {
    const glb = writeGlb({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      colors: new Uint8Array(12).fill(200),
      indices: new Uint32Array([0, 1, 2]),
      material: { name: 'bronze', metallicFactor: 0.5, roughnessFactor: 0.5 },
      generator: 'test',
    });
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
    expect(json.accessors[0].max).toEqual([1, 2, 0]);
    expect(json.accessors[2]).toMatchObject({ componentType: 5121, normalized: true, type: 'VEC4' });
    expect(glb.length % 4).toBe(0);
  });
});
