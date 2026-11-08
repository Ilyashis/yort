// Объёмные детали домов поверх стен: балконы на длинных стенах жилых домов,
// подъезды с козырьками со стороны двора, трубы и слуховые окна на скатных крышах, будки на больших
// плоских крышах, выступающие карнизы и заборы деревенских дворов. Двери и балконы — напротив окон.

import { Color, ExtrudeGeometry, Matrix4, Shape, Vector2 } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { buffer, polygon } from '@turf/turf';
import { hashString } from '../utils/hash';
import {
  balconies,
  chimneys,
  dormers,
  entrances,
  FENCE,
  FENCE_COLOR_HEX,
  fenceBoxes,
  rooftopBoxes,
  type DetailBox,
} from '../world/base/buildingDetails';
import { windowGrid } from '../world/base/facades';
import { signedArea } from '../world/base/roofGeometry';
import type { Yard } from '../world/base/yards';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { BuildingShape } from './BuildingsLayer';
import type { CityScene } from './CityScene';
import { MergedBuilder, type MergedMesh } from './merged';

const RESIDENTIAL = new Set(['apartments', 'residential', 'yes', 'dormitory']);
const UTILITY = new Set(['garage', 'garages', 'shed', 'service', 'transformer_tower', 'roof', 'construction', 'hut', 'kiosk']);
const MAX_BALCONIES = 16_000;
const CORNICE = { overhang: 0.35, height: 0.45 };
const BALCONY_CLEARANCE = 2.2;
const DOOR_MARGIN = 0.2;

const DOOR_COLOR = new Color('#4f3f33');
const GLASS_DOOR_COLOR = new Color('#2c343d');
const CANOPY_COLOR = new Color('#8d9298');
const WHITE = new Color('#f4f1ea');
const BRICK = new Color('#9b4a35');
const WHITEWASH = new Color('#ddd6c8');
const SOOT = new Color('#5f5953');
const DEFAULT_ROOF = new Color('#7c4a3a');
const DORMER_GLASS = new Color('#2c3540');

export interface DetailsOptions {
  frame: LocalFrame;
  /** Стена выходит на улицу (точка в локальных метрах) — туда подъезды не ставим. */
  isStreetSide: (point: Vec2) => boolean;
  /** Высота земли в локальных метрах. */
  heightAt: (x: number, y: number) => number;
  yards: readonly Yard[];
}

export class DetailsLayer {
  private replaced: ReadonlySet<string> = new Set();
  private lastHidden: [ReadonlySet<string>, ReadonlySet<string>, ReadonlySet<string>] = [new Set(), new Set(), new Set()];
  private readonly merged?: MergedMesh;

  constructor(
    private readonly city: CityScene,
    shapes: readonly BuildingShape[],
    options: DetailsOptions,
    csm: CSM,
  ) {
    const { isStreetSide, heightAt } = options;
    const builder = new MergedBuilder();
    const colors = new Map<string, Color>();
    const css = (value: string) => {
      let c = colors.get(value);
      if (!c) colors.set(value, (c = new Color(value)));
      return c;
    };
    const groundAt = (shape: BuildingShape, box: DetailBox) => Math.max(shape.ground, heightAt(box.center[0], box.center[1]));
    /** Сдвигает деталь вдоль стены к центру ближайшего окна (окна в шейдере — по тем же локальным метрам). */
    const snapToWindow = (box: DetailBox, bay: number): DetailBox => {
      const dir: Vec2 = [Math.cos(box.angle), Math.sin(box.angle)];
      const along = box.center[0] * dir[0] + box.center[1] * dir[1];
      const shift = (Math.round(along / bay - 0.5) + 0.5) * bay - along;
      return { ...box, center: [box.center[0] + dir[0] * shift, box.center[1] + dir[1] * shift, box.center[2]] };
    };

    let balconyCount = 0;
    for (const shape of shapes) {
      const { props } = shape;
      const owner = props.id;
      if (UTILITY.has(props.building) || props.minHeight > 0 || shape.floorHeight <= 0) continue;
      const floors = Math.round(shape.wallTop / shape.floorHeight);
      const seed = hashString(props.id);
      const facade = css(shape.facadeColor);

      if (RESIDENTIAL.has(props.building) && floors >= 4 && floors <= 16 && seed % 10 < 7 && balconyCount < MAX_BALCONIES) {
        const balconyColor = facade.clone().lerp(WHITE, 0.45);
        const { bay } = windowGrid(shape.style, false);
        const list = balconies(shape.localRing, {
          floors,
          floorHeight: shape.floorHeight,
          bay: bay * (seed % 2 ? 2 : 3),
          minEdge: 10,
          maxPerBuilding: Math.min(320, MAX_BALCONIES - balconyCount),
        });
        for (const box of list) {
          const bottom = shape.ground + box.center[2] - box.size[2] / 2;
          if (bottom < groundAt(shape, box) + BALCONY_CLEARANCE) continue;
          builder.addBox(snapToWindow(box, bay), shape.ground, balconyColor, owner);
          balconyCount++;
        }
      }

      if (RESIDENTIAL.has(props.building) && floors >= 3) {
        const grid = windowGrid(shape.style, true);
        const doorWidth = Math.min(Math.max(grid.width + DOOR_MARGIN, 1.4), 4.2);
        const { doors, canopies } = entrances(shape.localRing, isStreetSide, 18, doorWidth);
        doors.forEach((door, i) => {
          const base = groundAt(shape, door);
          builder.addBox(snapToWindow(door, grid.bay), base, doorWidth > 2.2 ? GLASS_DOOR_COLOR : DOOR_COLOR, owner);
          const canopy = canopies[i];
          if (canopy) builder.addBox(snapToWindow(canopy, grid.bay), base, CANOPY_COLOR, owner);
        });
      }

      const top = shape.ground + shape.wallTop;
      if (shape.roof) {
        const chimneyColor = shape.village ? (seed % 3 === 0 ? WHITEWASH : BRICK) : seed % 2 ? BRICK : SOOT;
        for (const box of chimneys(shape.roof, seed, shape.village)) builder.addBox(box, top, chimneyColor, owner);
        if (!shape.village) {
          const { bodies, roofs, windows } = dormers(shape.roof);
          for (const box of bodies) builder.addBox(box, top, facade, owner);
          for (const box of roofs) builder.addBox(box, top, shape.roofColor ? css(shape.roofColor) : DEFAULT_ROOF, owner);
          for (const box of windows) builder.addBox(box, top, DORMER_GLASS, owner);
        }
      }
      if (!shape.village && shape.flatRoof && shape.wallTop >= 12 && Math.abs(signedArea(shape.localRing)) >= 250) {
        const boxColor = facade.clone().multiplyScalar(0.84);
        for (const box of rooftopBoxes(shape.localRing)) builder.addBox(box, top, boxColor, owner);
      }
      if (shape.flatRoof && shape.wallTop >= 6) {
        const cornice = corniceRing(shape.ring, options.frame);
        if (cornice) {
          const geometry = new ExtrudeGeometry(new Shape(cornice.map(([x, y]) => new Vector2(x, y))), {
            depth: CORNICE.height + 0.04,
            bevelEnabled: false,
          });
          // Фигура в плоскости XY выдавливается по +Z: кладём её на землю (Z → вверх, Y → север).
          const matrix = new Matrix4().makeRotationX(-Math.PI / 2).premultiply(new Matrix4().makeTranslation(0, top - CORNICE.height, 0));
          builder.add(geometry, matrix, facade.clone().multiplyScalar(0.86), owner);
          geometry.dispose();
        }
      }
    }

    // Заборы дворов: куски не длиннее 5 м, каждый на своей высоте земли (участки на склонах).
    for (const yard of options.yards) {
      const owner = `yard:${yard.houseId}`;
      const color = new Color(FENCE_COLOR_HEX[yard.seed % FENCE_COLOR_HEX.length]!);
      const postColor = color.clone().multiplyScalar(0.7);
      yard.fence.forEach(([p, q], index) => {
        const street = index < yard.fence.length - 3; // последние три стороны — бока и зады
        const { pieces, posts } = fenceBoxes(p, q, street ? FENCE.street : FENCE.other, street);
        for (const box of pieces) builder.addBox(box, heightAt(box.center[0], box.center[1]), color, owner);
        for (const box of posts) builder.addBox(box, heightAt(box.center[0], box.center[1]), postColor, owner);
      });
    }

    if (!builder.empty) {
      this.merged = builder.build('building-details', csm);
      city.scene.add(this.merged.mesh);
    }
  }

  /**
   * Скрыть детали убранных и изменённых домов и заборы убранных дворов. Двор уходит вместе с домом
   * только если дом удалён (yardOwnersGone), а не сдвинут или перестроен.
   */
  setHidden(buildings: ReadonlySet<string>, yards: ReadonlySet<string>, yardOwnersGone: ReadonlySet<string>): void {
    this.lastHidden = [buildings, yards, yardOwnersGone];
    const changed = this.merged?.setHidden((owner) => {
      const yard = owner.startsWith('yard:') ? owner.slice(5) : undefined;
      // id дома во дворе — «id здания:номер контура».
      return yard
        ? yards.has(yard) || yardOwnersGone.has(yard.slice(0, yard.lastIndexOf(':')))
        : buildings.has(owner) || this.replaced.has(owner);
    });
    if (changed) this.city.requestRender();
  }

  /** Дома, нарисованные моделями: их подъезды, балконы и трубы не нужны (дворы остаются). */
  setReplaced(ids: ReadonlySet<string>): void {
    this.replaced = new Set(ids);
    this.setHidden(...this.lastHidden);
  }

  setVisible(visible: boolean): void {
    if (this.merged) this.merged.mesh.visible = visible;
    this.city.requestRender();
  }

  destroy(): void {
    if (!this.merged) return;
    this.city.scene.remove(this.merged.mesh);
    this.merged.dispose();
  }
}

/** Контур карниза в локальных метрах: стены, раздвинутые наружу на вынос карниза. */
function corniceRing(ring: readonly [number, number][], frame: LocalFrame): Vec2[] | undefined {
  try {
    const grown = buffer(polygon([ring as [number, number][]]), CORNICE.overhang, { units: 'meters', steps: 1 });
    const geometry = grown?.geometry;
    const outer = geometry?.type === 'Polygon' ? geometry.coordinates[0] : geometry?.coordinates[0]?.[0];
    return outer && outer.length >= 4 ? (outer.slice(0, -1) as [number, number][]).map(frame.toLocal) : undefined;
  } catch {
    return undefined;
  }
}
