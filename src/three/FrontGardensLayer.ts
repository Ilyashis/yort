// Палисадники деревенских дворов: штакетник, клумбы, кусты и деревца перед домами (planFrontGarden).
// Вдали — одна лёгкая сетка на всю деревню (забор сплошной полосой, крупные кусты и кроны, клумбы
// цветной грядкой). Вблизи — подробные палисадники кусками (PartsLayer).

import type { CSM } from 'three/addons/csm/CSM.js';
import { planFrontGarden } from '../world/village/frontGarden';
import { rotatePartsZ } from '../world/village/houseParts';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import type { GroundArea, GroundDelta } from './merged';
import { PartsLayer, translateParts } from './PartsLayer';

export interface GardenSite {
  /** Владелец — двор (id дома во дворе): палисадник прячется вместе с ним. */
  owner: string;
  /** Середина фасада и единичный вектор к улице (локальные метры). */
  origin: Vec2;
  toStreet: Vec2;
  width: number;
  depth: number;
  seed: number;
}

export class FrontGardensLayer {
  private readonly layer: PartsLayer;

  constructor(city: CityScene, heightAt: (x: number, y: number) => number, csm: CSM | undefined) {
    this.layer = new PartsLayer(city, heightAt, csm, 'front-gardens');
  }

  /** Палисадники заново (например, дома стали моделями — у них свой фасад и своя глубина палисадника). */
  setSites(sites: readonly GardenSite[]): void {
    this.layer.setSites(
      sites
        .filter((site) => site.width >= 1 && site.depth >= 0.3)
        .map((site) => ({
          owner: site.owner,
          center: site.origin,
          plan: (far: boolean) => {
            const { parts } = planFrontGarden({
              width: site.width,
              depth: site.depth,
              seed: site.seed,
              far,
            });
            // Ось x палисадника — вдоль фасада (влево от направления к улице), y — от улицы к дому.
            const along: Vec2 = [-site.toStreet[1], site.toStreet[0]];
            return [
              {
                parts: translateParts(rotatePartsZ(parts, Math.atan2(along[1], along[0])), site.origin),
              },
            ];
          },
        })),
    );
  }

  /** Спрятать палисадники убранных дворов и дворов удалённых домов — как заборы в DetailsLayer. */
  setHidden(yards: ReadonlySet<string>, yardOwnersGone: ReadonlySet<string>): void {
    this.layer.setHidden((owner) => yards.has(owner) || yardOwnersGone.has(owner.slice(0, owner.lastIndexOf(':'))));
  }

  setVisible(visible: boolean): void {
    this.layer.setVisible(visible);
  }

  get triangles(): { near: number; far: number } {
    return this.layer.triangles;
  }

  /** Земля поменялась (кисть рельефа): палисадники в area — вместе с ней. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    this.layer.shiftGround(delta, area);
  }

  destroy(): void {
    this.layer.destroy();
  }
}
