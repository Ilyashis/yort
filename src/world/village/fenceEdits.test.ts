import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import type { EstatePlan, FenceRun, Plot } from './estates';
import { dropPoint, editPlan, gateHalf, gateSpot, magnet, movePoint, runKey } from './fenceEdits';

const run = (owners: string[], kind: FenceRun['kind'], line: Vec2[], cuts: [number, number][] = []): FenceRun => ({
  owners,
  kind,
  line,
  cuts,
  style: 'boards',
  color: '#000',
  height: 1.8,
  seed: 1,
});

/** Участок 20 × 40 м: улица — вдоль y = 0, ворота посередине (x = 10). */
function plan(): EstatePlan {
  const gate = { at: [10, 0] as Vec2, along: [1, 0] as Vec2, inward: [0, 1] as Vec2, gate: 3, wicket: 1, wicketSide: 1 as const, canopy: false, style: 'boards' as const, color: '#000' };
  const plot: Plot = {
    id: 'a',
    seed: 1,
    ring: [
      [0, 0],
      [20, 0],
      [20, 40],
      [0, 40],
    ],
    area: 800,
    origin: [10, 0],
    t: [1, 0],
    n: [0, 1],
    street: true,
    gate,
    driveway: [
      [8, 0],
      [11, 0],
      [11, 10],
      [8, 10],
    ],
    outbuildings: [],
    props: [],
    trees: [],
    fence: { style: 'boards', color: '#000', height: 1.8 },
  };
  const half = gateHalf(gate);
  return {
    plots: [plot],
    runs: [
      run(['a'], 'street', [
        [0, 0],
        [20, 0],
      ], [[10 - half, 10 + half]]),
      run(['a', 'b'], 'side', [
        [20, 0],
        [20, 40],
      ]),
    ],
  };
}

describe('правки заборов посёлка', () => {
  it('без правок — тот же план', () => {
    const base = plan();
    expect(editPlan(base, { lines: new Map(), gates: new Map() })).toBe(base);
  });

  it('ворота двигаются вдоль забора, вырез и подъезд — за ними', () => {
    const base = plan();
    const next = editPlan(base, { lines: new Map(), gates: new Map([['a', [15, 0.7] as Vec2]]) });
    expect(next.plots[0]!.gate!.at[0]).toBeCloseTo(15);
    expect(next.plots[0]!.gate!.at[1]).toBeCloseTo(0);
    expect(next.plots[0]!.driveway![0]![0]).toBeCloseTo(13);
    const half = gateHalf(base.plots[0]!.gate!);
    expect(next.runs[0]!.cuts).toEqual([[15 - half, 15 + half]]);
    // Чужой забор не тронут.
    expect(next.runs[1]).toBe(base.runs[1]);
  });

  it('ворота не выходят за конец забора', () => {
    const base = plan();
    const next = editPlan(base, { lines: new Map(), gates: new Map([['a', [30, 0] as Vec2]]) });
    const half = gateHalf(base.plots[0]!.gate!);
    expect(next.plots[0]!.gate!.at[0]).toBeCloseTo(20 - half - 0.3);
  });

  it('забор с новой ломаной: вырез ворот переносится, ворота встают на забор', () => {
    const base = plan();
    const key = runKey(base.runs[0]!);
    const line: Vec2[] = [
      [0, 0],
      [10, 1],
      [20, 0],
    ];
    const next = editPlan(base, { lines: new Map([[key, line]]), gates: new Map() });
    expect(next.runs[0]!.line).toEqual(line);
    const gate = next.plots[0]!.gate!;
    expect(gate.at[1]).toBeGreaterThan(0.5);
    expect(next.runs[0]!.cuts.length).toBe(1);
  });

  it('стык соседей двигается целиком; излом убирается, стык — нет', () => {
    const lines = new Map<string, Vec2[]>([
      [
        'x',
        [
          [0, 0],
          [5, 1],
          [10, 0],
        ],
      ],
      [
        'y',
        [
          [10, 0],
          [10, 10],
        ],
      ],
    ]);
    const moved = movePoint(lines, [10, 0], [11, 0]);
    expect(moved.get('x')![2]).toEqual([11, 0]);
    expect(moved.get('y')![0]).toEqual([11, 0]);
    expect(dropPoint(lines, [5, 1])!.get('x')).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(dropPoint(lines, [10, 0])).toBeUndefined();
  });

  it('магнит: к точке соседа, на линию, в створ', () => {
    const others: Vec2[][] = [
      [
        [0, 10],
        [10, 10],
      ],
    ];
    expect(magnet([9.6, 10.3], [], others, [50, 50], 1, 0.5)).toEqual({ point: [10, 10], kind: 'point' });
    expect(magnet([5, 10.3], [], others, [50, 50], 1, 0.5)?.kind).toBe('line');
    const straight = magnet(
      [5, 0.2],
      [
        [0, 0],
        [10, 0],
      ],
      [],
      [5, 0],
      1,
      0.5,
    );
    expect(straight).toEqual({ point: [5, 0], kind: 'straight' });
    expect(magnet([5, 5], [], others, [50, 50], 1, 0.5)).toBeUndefined();
  });

  it('место ворот — на ближайшем заборе', () => {
    const spot = gateSpot(
      [
        [
          [0, 0],
          [20, 0],
        ],
      ],
      [7, 3],
      2,
    );
    expect(spot).toEqual([7, 0]);
  });
});
