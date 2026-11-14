import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { defaultGateAt, distanceAlong, fenceWithGates, GATE_KINDS, placeGates } from './fenceGates';

// Забор буквой Г: 20 м на восток, потом 8 м на север.
const line: Vec2[] = [
  [0, 0],
  [20, 0],
  [20, 8],
];

describe('ворота и калитки в заборе', () => {
  it('ворота встают на звено, где их середина, проём не доходит до излома', () => {
    const [gate] = placeGates(line, [{ kind: 'swing', at: 19.5 }]);
    expect(gate!.segment).toBe(1);
    expect(gate!.to).toBeLessThanOrEqual(20 - 0.25 + 1e-9);
    expect(gate!.to - gate!.from).toBeCloseTo(GATE_KINDS.swing.width, 6);
    expect(gate!.center[1]).toBeCloseTo(0, 6);
  });

  it('не влезают на короткое звено — переезжают на ближайшее, где помещаются', () => {
    const [gate] = placeGates(line, [{ kind: 'combo', at: 24 }]);
    // На звене 8 м ворота 4,7 м влезают: середина между 20,25 + 2,35 и 28 − 0,25 − 2,35.
    expect(gate!.segment).toBe(2);
    const short: Vec2[] = [
      [0, 0],
      [3, 0],
    ];
    expect(placeGates(short, [{ kind: 'swing', at: 1.5 }])).toHaveLength(0);
  });

  it('налезающие ворота пропускаются', () => {
    const placed = placeGates(line, [
      { kind: 'swing', at: 8 },
      { kind: 'wicket', at: 8.5 },
    ]);
    expect(placed.map((p) => p.kind)).toEqual(['swing']);
  });

  it('новые ворота — в самое длинное свободное место', () => {
    const at = defaultGateAt(line, 'wicket', [{ kind: 'swing', at: 4 }]);
    expect(at).toBeGreaterThan(6);
    expect(at).toBeLessThan(20);
    const both = placeGates(line, [
      { kind: 'swing', at: 4 },
      { kind: 'wicket', at: at! },
    ]);
    expect(both).toHaveLength(2);
  });

  it('положение по точке рядом с забором — расстояние по линии', () => {
    expect(distanceAlong(line, [7, 1.5])).toBeCloseTo(7, 6);
    expect(distanceAlong(line, [21, 5])).toBeCloseTo(25, 6);
  });

  it('полотно забора режется на проёме, в проёме — створки', () => {
    const plain = fenceWithGates(line, [], 'profile');
    const gated = fenceWithGates(line, [{ kind: 'swing', at: 10 }], 'profile');
    // В проёме нет сплошного листа забора: ни одна деталь полотна не проходит через середину ворот
    // во всю высоту забора (2 м), створки ниже (1,95 м).
    const sheets = (boxes: typeof plain) => boxes.pieces.filter((b) => b.size[2] >= 2 && Math.abs(b.center[1]) < 0.1 && Math.abs(b.center[0] - 10.6) < b.size[0] / 2);
    expect(sheets(plain).length).toBeGreaterThan(0);
    expect(sheets(gated)).toHaveLength(0);
    expect(gated.places).toHaveLength(1);
    expect(gated.leaves.length).toBeGreaterThan(0);
    expect(gated.posts.length).toBeGreaterThan(plain.posts.length);
  });
});
