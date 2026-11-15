// Посёлок «моя версия»: заборы участков, ворота с калитками и мелочь дворов (поленницы, ульи, стога,
// будки, лавочки) — деталями из частей (PartsLayer). Постройки дворов (сараи, бани, теплицы) — моделями
// в своём VillageModelsLayer. Убрали двор в редакторе — уходит всё его; общий забор соседей — только если
// убраны оба двора.

import type { CSM } from 'three/addons/csm/CSM.js';
import { pointAt, type EstatePlan, type EstateProp, type FenceRun, type Plot } from '../world/village/estates';
import { fenceParts, gateParts, propParts } from '../world/village/estateParts';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import type { GroundArea, GroundDelta } from './merged';
import { PartsLayer, type PartsSite } from './PartsLayer';

/** Забор режем на куски не длиннее этого: кусок попадает в свой участок земли (LOD). */
const PIECE = 30;

export class EstateLayer {
  private readonly layer: PartsLayer;
  /** Заборы и ворота, изменённые в редакторе, — своим маленьким слоем (базовый не пересобирается). */
  private readonly edited: PartsLayer;
  /** Чьи участки за каждым владельцем деталей. */
  private readonly plotsOf = new Map<string, string[]>();
  private changed = new Set<string>();
  private hiddenPlots: ReadonlySet<string> = new Set();
  private current: EstatePlan;

  constructor(
    city: CityScene,
    heightAt: (x: number, y: number) => number,
    csm: CSM | undefined,
    private readonly plan: EstatePlan,
  ) {
    this.layer = new PartsLayer(city, heightAt, csm, 'estates');
    this.edited = new PartsLayer(city, heightAt, csm, 'estates-edited');
    this.current = plan;
    const sites: PartsSite[] = [];
    plan.runs.forEach((run, k) => {
      this.plotsOf.set(`run:${k}`, run.owners);
      sites.push(...runSites(run, k));
    });
    for (const plot of plan.plots) {
      const owner = `plot:${plot.id}`;
      this.plotsOf.set(owner, [plot.id]);
      this.plotsOf.set(`gate:${plot.id}`, [plot.id]);
      if (plot.gate) sites.push(gateSite(plot));
      for (const prop of plot.props) sites.push(propSite(plot, prop));
    }
    this.layer.setSites(sites);
  }

  /** План с правками заборов: изменённые заборы и ворота — заново, их прежний вид прячется. */
  setPlan(next: EstatePlan): void {
    if (next === this.current) return;
    this.current = next;
    const changed = new Set<string>();
    const sites: PartsSite[] = [];
    next.runs.forEach((run, k) => {
      if (run === this.plan.runs[k]) return;
      changed.add(`run:${k}`);
      sites.push(...runSites(run, k));
    });
    next.plots.forEach((plot, k) => {
      if (plot.props !== this.plan.plots[k]?.props) {
        changed.add(`plot:${plot.id}`);
        sites.push(...plot.props.map((prop) => propSite(plot, prop)));
      }
      if (plot.gate === this.plan.plots[k]?.gate) return;
      changed.add(`gate:${plot.id}`);
      if (plot.gate) sites.push(gateSite(plot));
    });
    this.changed = changed;
    this.edited.setSites(sites);
    this.applyHidden();
  }

  /** Спрятать дворы участков plots (их заборы — если все хозяева забора спрятаны). */
  setHidden(plots: ReadonlySet<string>): void {
    this.hiddenPlots = plots;
    this.applyHidden();
  }

  setVisible(visible: boolean): void {
    this.layer.setVisible(visible);
    this.edited.setVisible(visible);
  }

  get triangles(): { near: number; far: number } {
    return this.layer.triangles;
  }

  shiftGround(delta: GroundDelta, area: GroundArea): void {
    this.layer.shiftGround(delta, area);
    this.edited.shiftGround(delta, area);
  }

  destroy(): void {
    this.layer.destroy();
    this.edited.destroy();
  }

  private applyHidden(): void {
    const hidden = (owner: string) => {
      const list = this.plotsOf.get(owner);
      return !!list?.length && list.every((id) => this.hiddenPlots.has(id));
    };
    this.layer.setHidden((owner) => this.changed.has(owner) || hidden(owner));
    this.edited.setHidden(hidden);
  }
}

function runSites(run: FenceRun, k: number): PartsSite[] {
  return splitRun(run, PIECE).map((piece) => {
    const [center, radius] = extent(piece.line);
    return { owner: `run:${k}`, center, radius, plan: (far: boolean) => [{ parts: fenceParts(piece, far) }] };
  });
}

function propSite(plot: Plot, prop: EstateProp): PartsSite {
  return { owner: `plot:${plot.id}`, center: prop.at, radius: 3, plan: (far) => [{ parts: propParts(prop, far), anchor: prop.at }] };
}

function gateSite(plot: Plot): PartsSite {
  const gate = plot.gate!;
  return {
    owner: `gate:${plot.id}`,
    center: gate.at,
    radius: 4,
    plan: (far) => [{ parts: gateParts(gate, plot.fence.height, far), anchor: gate.at }],
  };
}

/** Забор кусками не длиннее max м (вырезы — каждому куску свои, от его начала). */
function splitRun(run: FenceRun, max: number): FenceRun[] {
  let total = 0;
  for (let k = 1; k < run.line.length; k++) total += Math.hypot(run.line[k]![0] - run.line[k - 1]![0], run.line[k]![1] - run.line[k - 1]![1]);
  const count = Math.max(1, Math.ceil(total / max));
  if (count === 1) return [run];
  const out: FenceRun[] = [];
  for (let i = 0; i < count; i++) {
    const s0 = (total * i) / count;
    const s1 = (total * (i + 1)) / count;
    const line: Vec2[] = [pointAt(run.line, s0).point];
    let s = 0;
    for (let k = 1; k < run.line.length; k++) {
      s += Math.hypot(run.line[k]![0] - run.line[k - 1]![0], run.line[k]![1] - run.line[k - 1]![1]);
      if (s > s0 + 1e-6 && s < s1 - 1e-6) line.push(run.line[k]!);
    }
    line.push(pointAt(run.line, s1).point);
    const cuts = run.cuts.filter(([a, b]) => b > s0 && a < s1).map(([a, b]): [number, number] => [a - s0, b - s0]);
    out.push({ ...run, line, cuts, seed: run.seed + i });
  }
  return out;
}

/** Середина и полуразмах ломаной. */
function extent(line: readonly Vec2[]): [Vec2, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of line) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [[(minX + maxX) / 2, (minY + maxY) / 2], Math.hypot(maxX - minX, maxY - minY) / 2 + 2];
}
