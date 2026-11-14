import { describe, expect, it } from 'vitest';
import { createLocalFrame, type Vec2 } from '../walk/localFrame';
import { EMPTY_EDITS, parseEdits } from './edits';
import { createPlot, insidePlot, plotFenceLines, plotFences, PLOT_ROLES, removePlot, resizePlot, rolePlace, setPlotRole, transformPlot } from './plots';

const frame = createLocalFrame([57.96, 52.632]);
// Участок 22 × 38 м: улица по y = 0, вглубь — на север.
const rect: Vec2[] = [
  [0, 0],
  [22, 0],
  [22, 38],
  [0, 38],
];
const box = (u0: number, u1: number, v0: number, v1: number): Vec2[] => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];

describe('забор участка', () => {
  it('упирается в дом и гараж на улице, ворота — между ними', () => {
    const garage = box(0, 4, 0, 6);
    const house = box(15.4, 22, 0, 7.2);
    const pieces = plotFenceLines(rect, [garage, house], [{ kind: 'combo', at: 9.7 }]);
    // Улица между гаражом и домом и всё остальное по кругу от дома до гаража.
    expect(pieces).toHaveLength(2);
    const street = pieces.find((p) => p.line.every(([, y]) => Math.abs(y) < 1e-6))!;
    expect(street.line[0]![0]).toBeCloseTo(4, 6);
    expect(street.line[street.line.length - 1]![0]).toBeCloseTo(15.4, 6);
    expect(street.gates).toEqual([{ kind: 'combo', at: 9.7 - 4 }]);
    const rest = pieces.find((p) => p !== street)!;
    const near = (p: Vec2, q: Vec2) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(1e-6);
    near(rest.line[0]!, [22, 7.2]);
    near(rest.line[rest.line.length - 1]!, [0, 6]);
    expect(rest.line).toHaveLength(4);
  });

  it('дом отодвинули от улицы — забор закрывает щель', () => {
    const pieces = plotFenceLines(rect, [box(0, 4, 0, 6), box(15.4, 22, 3, 10.2)], []);
    const street = pieces.find((p) => p.line.some(([x, y]) => Math.abs(y) < 1e-6 && x > 21))!;
    const end = street.line[street.line.length - 1]!;
    expect(Math.hypot(end[0] - 22, end[1] - 3)).toBeLessThan(1e-6);
  });

  it('пустой участок — замкнутый забор', () => {
    const [ring] = plotFenceLines(rect, [], []);
    const [s0, s1] = [ring!.line[0]!, ring!.line[ring!.line.length - 1]!];
    expect(Math.hypot(s0[0] - s1[0], s0[1] - s1[1])).toBeLessThan(1e-6);
    expect(ring!.line).toHaveLength(5);
  });
});

describe('участок-шаблон', () => {
  const local = rect;
  const made = createPlot(EMPTY_EDITS, 'p1', local, 'yard', frame);

  it('деревенский двор: дом, гараж, баня, сарай, яблони и ворота', () => {
    expect(made.plots).toHaveLength(1);
    expect(made.buildings.map((b) => b.plotRole).sort()).toEqual(['banya', 'garage', 'house', 'shed']);
    expect(made.trees?.length).toBe(3);
    const house = made.buildings.find((b) => b.plotRole === 'house')!;
    expect(house.model?.id).toBe(PLOT_ROLES.house.model);
    expect(house.garden).toBe(0);
    // Все постройки — внутри участка.
    for (const b of made.buildings) for (const p of b.footprint.map(frame.toLocal)) expect(insidePlot(local, p) || Math.min(...p) > -0.01).toBe(true);
    expect(plotFences(made, frame).length).toBeGreaterThanOrEqual(2);
    expect(parseEdits(JSON.parse(JSON.stringify(made)))?.plots).toEqual(made.plots);
  });

  it('растянули — постройки на местах, ворота на том же месте улицы', () => {
    const wider: Vec2[] = [
      [-6, 0],
      [22, 0],
      [22, 45],
      [-6, 45],
    ];
    const next = resizePlot(made, 'p1', wider, frame);
    expect(next.buildings).toBe(made.buildings);
    const gateBefore = made.plots![0]!.fence.gates[0]!.at;
    expect(next.plots![0]!.fence.gates[0]!.at).toBeCloseTo(gateBefore + 6, 6);
  });

  it('сдвинули — переезжает всё; убрали баню и вернули', () => {
    const moved = transformPlot(made, 'p1', ([x, y]) => [x + 10, y], frame);
    const h0 = frame.toLocal(made.buildings.find((b) => b.plotRole === 'house')!.footprint[0]!);
    const h1 = frame.toLocal(moved.buildings.find((b) => b.plotRole === 'house')!.footprint[0]!);
    expect(h1[0] - h0[0]).toBeCloseTo(10, 3);
    const noBanya = setPlotRole(made, 'p1', 'banya', false, frame);
    expect(noBanya.buildings.some((b) => b.plotRole === 'banya')).toBe(false);
    const back = setPlotRole(noBanya, 'p1', 'banya', true, frame);
    const [u0] = rolePlace('yard', 'banya', 22, 38);
    expect(frame.toLocal(back.buildings.find((b) => b.plotRole === 'banya')!.footprint[0]!)[0]).toBeCloseTo(u0, 3);
  });

  it('убрать участок с содержимым или оставить постройки', () => {
    expect(removePlot(made, 'p1', true).buildings).toHaveLength(0);
    const kept = removePlot(made, 'p1', false);
    expect(kept.buildings).toHaveLength(4);
    expect(kept.buildings.every((b) => !b.plot && !b.plotRole)).toBe(true);
  });
});
