// Земля района в three.js: рельеф (сетка DEM и кольцо до горизонта) с многоуровневой текстурой покрытий
// и правки редактора (убранные и новые дороги, огороды) — текстура перерисовывается в фоне.
// Поверх — подложка (свой снимок для обводки), на всей земле, включая кольцо до горизонта.

import type { Material } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import type { GroundFeature } from '../world/base/environment';
import { GroundModel, groundBounds, NO_GROUND_EDITS, sameSet, type GroundEdits } from '../world/base/groundEdits';
import { GROUND_COLORS, MEADOW_COLOR, WOOD_COLOR } from '../world/base/groundStyle';
import { LandTextureRenderer, type GardenPatch } from '../world/base/landTexture';
import type { Ring } from '../world/base/types';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { GroundTexture, type UnderlayView } from './ground';
import { NIGHT } from './nightUniforms';
import { hookMaterial } from './shaderHooks';
import { createTerrain, type DetailRegion, type HeightSource, type LocalRect, type Terrain } from './terrain';

/** Земля за границей города: выгоревший луг. */
const OUTSIDE_CITY_COLOR = '#aab783';

export class GroundLayer {
  readonly model: GroundModel;
  readonly terrain: Terrain;
  readonly texture: GroundTexture;
  private edits: GroundEdits = NO_GROUND_EDITS;
  private pointAhead: (distance: number) => Vec2 = () => [0, 0];
  private lampSpots: readonly Vec2[] = [];
  private lampFocus: Vec2 = [Number.NaN, Number.NaN];
  private readonly removeAnimator: () => void;

  constructor(
    private readonly city: CityScene,
    grid: HeightSource,
    private readonly frame: LocalFrame,
    private readonly area: LocalRect,
    features: readonly GroundFeature[],
    private readonly gardens: readonly GardenPatch[],
    private readonly bareColor: string,
    isCity: boolean,
    csm: CSM,
    /** Где рельеф подробный (своя съёмка) — там сетка земли гуще. */
    detailRegion?: DetailRegion,
  ) {
    this.model = new GroundModel(features, isCity);
    this.texture = new GroundTexture(this.renderer(), frame, area, city.renderer.capabilities.getMaxAnisotropy());
    hookMaterial(this.texture.material, 'ground', this.texture.hook, csm);
    this.texture.drawBase();
    // Вокруг района — луг: в городе «пустая» земля бежевая (дворы, пустыри), а за городом — трава.
    this.terrain = createTerrain(grid, frame, area, this.texture.material, isCity ? OUTSIDE_CITY_COLOR : bareColor, detailRegion);
    hookMaterial(this.terrain.outer.material as Material, 'ground-outer', this.texture.underlay.hookOuter, csm);
    city.scene.add(this.terrain.inner, this.terrain.outer);
    if (this.terrain.detail) city.scene.add(this.terrain.detail);
    city.setGroundSampler((x, z) => this.terrain.heightAt(x, -z));
    this.removeAnimator = city.addAnimator(() => {
      // Ночью пятна света — от фонарей вокруг взгляда; пересчитываем, когда взгляд ушёл на 15 м.
      if (NIGHT.lamps.value > 0.001 && this.lampSpots.length) {
        const focus = this.pointAhead(0);
        if (!(Math.hypot(focus[0] - this.lampFocus[0], focus[1] - this.lampFocus[1]) < 15)) {
          this.texture.setLampSpots(this.lampSpots, focus);
          this.lampFocus = focus;
          city.requestRender();
        }
      }
      this.texture.focus(this.pointAhead);
      if (this.texture.tick(6)) city.requestRender();
      return this.texture.busy;
    });
  }

  /** Высота земли в локальных метрах. */
  get heightAt(): (x: number, y: number) => number {
    return this.terrain.heightAt;
  }

  /** Земля в прямоугольнике (локальные метры) поменялась — пересчитать сетку там. */
  refreshTerrain(area: LocalRect): void {
    this.terrain.refresh(area);
  }

  /** Откуда брать точку взгляда для чётких уровней текстуры (обзор или прогулка). */
  setFocus(pointAhead: (distance: number) => Vec2): void {
    this.pointAhead = pointAhead;
  }

  /**
   * Подложка на земле: снимок, привязка, прозрачность, видимость; undefined — убрать.
   * Тот же снимок с другой привязкой — только новые uniform-ы (можно звать на каждое движение мыши).
   */
  setUnderlay(view: UnderlayView | undefined): void {
    this.texture.underlay.set(view);
    this.city.requestRender();
  }

  /** Где фонари (локальные метры, точка под плафоном) — для пятен света ночью. */
  setLamps(spots: readonly Vec2[]): void {
    this.lampSpots = spots;
    this.lampFocus = [Number.NaN, Number.NaN];
    this.city.requestRender();
  }

  /** Правки дорог и огородов: текстура перерисуется в фоне. */
  setEdits(edits: GroundEdits): void {
    const same =
      sameSet(edits.removedRoads, this.edits.removedRoads) &&
      sameSet(edits.hiddenGardens, this.edits.hiddenGardens) &&
      JSON.stringify(edits.addedRoads) === JSON.stringify(this.edits.addedRoads);
    this.edits = edits;
    if (same) return;
    this.texture.setRenderer(this.renderer());
    this.city.requestRender();
  }

  /** Дорога OSM под точкой (не убранная), для выбора в редакторе. */
  roadAt(lon: number, lat: number): { key: string; rings: Ring[][] } | undefined {
    return this.model.roadAt(lon, lat, this.edits.removedRoads);
  }

  roadOutline(key: string): Ring[][] {
    return this.model.roadOutline(key);
  }

  destroy(): void {
    this.removeAnimator();
    this.texture.dispose();
  }

  private renderer(): LandTextureRenderer {
    const { byKind, dirt } = this.model.effective(this.edits);
    const covers = { wood: [] as Ring[][], meadow: [] as Ring[][] };
    for (const feature of this.model.features) {
      const cover = feature.properties.kind === 'green' ? feature.properties.cover : undefined;
      if (cover) covers[cover].push(...(feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates));
    }
    const gardens = this.gardens.filter((g) => !g.houseId || !this.edits.hiddenGardens.has(g.houseId));
    const bounds = groundBounds(this.model.features) ?? this.areaBounds();
    return new LandTextureRenderer(
      { byKind, covers, gardens, dirt, style: { bare: this.bareColor, colors: GROUND_COLORS, wood: WOOD_COLOR, meadow: MEADOW_COLOR } },
      bounds,
    );
  }

  private areaBounds() {
    const [west, south] = this.frame.toLonLat([this.area.x0, this.area.y0]);
    const [east, north] = this.frame.toLonLat([this.area.x1, this.area.y1]);
    return { west, south, east, north };
  }
}
