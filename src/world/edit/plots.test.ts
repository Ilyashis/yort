import { describe, expect, it } from 'vitest';
import { createLocalFrame, type Vec2 } from '../walk/localFrame';
import { EMPTY_EDITS, parseEdits } from './edits';
import { adoptMapPlots, createPlot, mapPlotId, materializePlot, plotFromOutline, roleOfModel, templateMembers, insidePlot, orientPlot, plotFenceLines, plotFences, PLOT_ROLES, removePlot, resizePlot, rolePlace, setPlotRole, transformPlot } from './plots';

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

describe('участок с карты', () => {
  const outline: Vec2[] = [
    [0, 0],
    [20, 0],
    [21, 30],
    [-1, 32],
    [-1, 10],
  ];
  const plot = {
    id: 'map:way/1',
    house: 'way/1',
    outline,
    members: [
      { id: 'way/1', role: 'house' as const, rect: box(13, 20, 0, 7) },
      { id: 'render/5', role: 'banya' as const, rect: box(14, 18, 22, 26) },
    ],
  };
  const lonLat = (r: Vec2[]) => r.map(frame.toLonLat) as [number, number][];
  const resolve = (id: string) => {
    const rect = plot.members.find((m) => m.id === id)!.rect;
    return { id, source: id, kind: 'house' as const, footprint: lonLat(rect), floors: 1, roof: 'gabled' as const, facadeColor: '#fff', roofColor: '#000' };
  };

  it('берётся в правку без копий построек: ворота на свободной улице, прежний забор спрятан', () => {
    const edits = adoptMapPlots(EMPTY_EDITS, [plot], frame, { fences: ['f7'], yards: ['way/1:0'] });
    const own = edits.plots![0]!;
    expect(own.id).toBe(mapPlotId('way/1'));
    expect(own.free).toBe(true);
    expect(own.outline).toHaveLength(5);
    expect(own.mapMembers).toEqual([
      { id: 'way/1', role: 'house' },
      { id: 'render/5', role: 'banya' },
    ]);
    expect(edits.buildings).toHaveLength(0);
    expect(edits.removedFences).toEqual(['f7']);
    expect(edits.removedYards).toEqual(['way/1:0']);
    // Улица свободна от 0 до 13 м — ворота с калиткой посередине.
    expect(own.fence.gates).toEqual([{ kind: 'combo', at: expect.closeTo(6.75, 1) }]);
    // Забор упирается в дом с карты.
    const fences = plotFences(edits, frame, (id) => plot.members.find((m) => m.id === id)?.rect);
    // Один кусок: от дома вокруг участка и обратно к дому — не замкнутое кольцо.
    expect(fences).toHaveLength(1);
    const line = fences[0]!.line.map(frame.toLocal);
    expect(Math.hypot(line[0]![0] - line[line.length - 1]![0], line[0]![1] - line[line.length - 1]![1])).toBeGreaterThan(5);
    // Повторно — тот же участок, без дублей.
    const again = adoptMapPlots(edits, [plot], frame);
    expect(again.plots).toHaveLength(1);
    expect(again.plots![0]!.mapMembers).toEqual(own.mapMembers);
  });

  it('постройки переходят в правки, когда участок трогают', () => {
    const edits = adoptMapPlots(EMPTY_EDITS, [plot], frame);
    const real = materializePlot(edits, mapPlotId('way/1'), resolve);
    expect(real.buildings.map((b) => [b.id, b.plotRole, b.plot])).toEqual([
      ['way/1', 'house', mapPlotId('way/1')],
      ['render/5', 'banya', mapPlotId('way/1')],
    ]);
    expect(real.plots![0]!.mapMembers).toEqual([]);
    expect(real.removedBuildings).toEqual(['way/1', 'render/5']);
    // Баню убрали — постройка с карты прячется.
    const noBanya = setPlotRole(edits, mapPlotId('way/1'), 'banya', false, frame);
    expect(noBanya.removedBuildings).toEqual(['render/5']);
    expect(noBanya.plots![0]!.mapMembers).toEqual([{ id: 'way/1', role: 'house' }]);
  });

  it('шаблон: объект на ближайший с карты, лишние убираются, чего нет — нет; ворота у всех', () => {
    const crowded = {
      ...plot,
      members: [
        ...plot.members,
        { id: 'render/6', role: 'banya' as const, rect: box(0, 3, 2, 5) },
        { id: 'render/7', role: 'banya' as const, rect: box(1, 4, 12, 15) },
      ],
    };
    // Баня по шаблону — в дальнем правом углу: остаётся render/5, две другие бани убираются; гаража и сарая нет.
    expect(templateMembers(crowded).keep.map((m) => m.id)).toEqual(['way/1', 'render/5']);
    expect(templateMembers(crowded).drop.sort()).toEqual(['render/6', 'render/7']);
    const edits = adoptMapPlots(EMPTY_EDITS, [crowded], frame);
    expect(edits.removedBuildings.sort()).toEqual(['render/6', 'render/7']);
    // Даже если улица вся занята домом — ворота с калиткой всё равно есть.
    const tight = { ...plot, members: [{ id: 'way/1', role: 'house' as const, rect: box(0, 20, 0, 7) }] };
    expect(adoptMapPlots(EMPTY_EDITS, [tight], frame).plots![0]!.fence.gates.map((g) => g.kind)).toEqual(['combo']);
  });

  it('контур с карты разворачивается улицей к дороге', () => {
    const ring: Vec2[] = [
      [0, 30],
      [0, 0],
      [20, 0],
      [20, 30],
    ];
    const oriented = orientPlot(ring, [
      [
        [-50, -5],
        [50, -5],
      ],
    ]);
    expect(oriented[0]).toEqual([0, 0]);
    expect(oriented[1]).toEqual([20, 0]);
  });
});

describe('участок по обводке', () => {
  it('внутри — обведённые постройки: один дом, лишние «дома» — сараи, свои — с меткой участка, ворота на улице', () => {
    const outline: Vec2[] = [
      [0, 0],
      [24, 0],
      [24, 36],
      [0, 36],
    ];
    const lonLat = (r: Vec2[]) => r.map(frame.toLonLat) as [number, number][];
    const own = { id: 'house-1', kind: 'house' as const, footprint: lonLat(box(2, 8, 20, 26)), floors: 1, roof: 'gabled' as const, facadeColor: '#fff', roofColor: '#000', model: { id: 'izba' as const, seed: 1 } };
    const start = { ...EMPTY_EDITS, buildings: [own], trees: [{ id: 't1', at: frame.toLonLat([12, 30]), kind: 'apple' as const, scale: 0.8 }] };
    const edits = plotFromOutline(
      start,
      'p9',
      outline,
      {
        map: [
          { id: 'way/1', role: 'house', rect: box(14, 24, 0, 9) },
          { id: 'render/3', role: 'banya', rect: box(18, 22, 28, 32) },
        ],
        own: [{ id: 'house-1', model: 'izba', rect: box(2, 8, 20, 26) }],
      },
      frame,
    );
    const plot = edits.plots![0]!;
    expect(plot.mapMembers).toEqual([
      { id: 'way/1', role: 'house' },
      { id: 'render/3', role: 'banya' },
    ]);
    // Свой дом меньше дома с карты — на участке он сарай.
    expect(edits.buildings[0]).toMatchObject({ id: 'house-1', plot: 'p9', plotRole: 'shed' });
    expect(edits.trees![0]!.plot).toBe('p9');
    expect(plot.fence.gates.map((g) => g.kind)).toEqual(['combo']);
    expect(roleOfModel('garage')).toBe('garage');
    expect(roleOfModel('hipped')).toBe('house');
  });
});
