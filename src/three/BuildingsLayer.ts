// Здания Base World в three.js: стены (выдавленные контуры с плоским верхом) — одна геометрия,
// скатные крыши и купола — вторая; окна и детали фасада — в шейдере (facadeShader.ts).
// Части зданий (building:part) рисуются вместо общего контура. Выбор кликом, подсветка выбранного
// и пересечённых участком, раскраска по качеству данных, скрытие убранных редактором — правкой
// цветов и вершин нужного дома в общих буферах (без пересборки).

import { BufferAttribute, Color, Mesh, ShapeUtils, Vector2, type Intersection } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import {
  BUILDING_COLORS,
  facadeColorHex,
  floorHeight,
  planRoof,
  polygonsOf,
  roofColorHex,
  type BuildingColorMode,
} from '../world/base/buildingPlan';
import { facadeStyle, type FacadeStyle } from '../world/base/facades';
import type { PartsAssignment } from '../world/base/parts';
import { openRing, signedArea, type RoofFrame, type RoofShape } from '../world/base/roofGeometry';
import type { BaseBuildingFeature, BaseBuildingProperties, BaseBuildingsCollection, Ring } from '../world/base/types';
import type { LonLat } from '../world/user/plot';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { createFacadeMaterial, createRoofMaterial } from './facadeShader';
import { MeshBuilder } from './meshBuilder';
import { ownerBoxes, shiftOwners, type GroundArea, type GroundDelta } from './merged';
import { FOOTING_DEPTH, siteOnSlope, type Site } from '../world/base/siting';

/** Форма объёма для слоя деталей (балконы, подъезды, трубы). */
export interface BuildingShape {
  props: BaseBuildingProperties;
  /** Внешний контур в lon/lat (замкнутый) и в локальных метрах (открытый). */
  ring: LonLat[];
  localRing: Vec2[];
  ground: number;
  /** Верх стен над землёй, м (без крыши). */
  wallTop: number;
  flatRoof: boolean;
  floorHeight: number;
  facadeColor: string;
  /** Тип окон и витрин — чтобы детали вставали напротив нарисованных окон. */
  style: FacadeStyle;
  roof?: RoofFrame;
  roofColor?: string;
  village: boolean;
}

/** Что нужно редактору, чтобы взять дом OSM в правку: контур, этажи, цвета, крыша. */
export interface BuildingInfo {
  props: BaseBuildingProperties;
  /** Внешний контур (lon/lat, без замыкающей точки). */
  outline: LonLat[];
  wallTop: number;
  roof: RoofShape;
  facadeColor: string;
  roofColor?: string;
}

interface Owner {
  id: string;
  props: BaseBuildingProperties;
  facade: Color;
  /** Диапазоны вершин [начало, число] в стенах и крышах. */
  walls: [number, number][];
  roofs: [number, number][];
  roofColors: Color[];
}

const SELECTED = new Color(BUILDING_COLORS.selected);
const CONFLICT = new Color(BUILDING_COLORS.conflict);
const KNOWN = new Color(BUILDING_COLORS.known);
const ESTIMATED = new Color(BUILDING_COLORS.estimated);

export class BuildingsLayer {
  readonly walls: Mesh;
  readonly roofs: Mesh;
  private readonly owners: Owner[] = [];
  private readonly byId = new Map<string, Owner>();
  private readonly wallOwners: Uint32Array;
  private readonly roofOwners: Uint32Array;
  private readonly wallPositions: Float32Array;
  private readonly roofPositions: Float32Array;
  private readonly infos = new Map<string, BuildingInfo>();
  private readonly shapesList: BuildingShape[] = [];
  private hidden = new Set<string>();
  /** Дома, нарисованные моделями (деревня из моделей): прячутся вдобавок к hidden. */
  private replaced: ReadonlySet<string> = new Set();
  private selectedId?: string;
  private conflicts = new Set<string>();
  private colorMode: BuildingColorMode = 'city';

  constructor(
    private readonly city: CityScene,
    collection: BaseBuildingsCollection,
    parts: PartsAssignment,
    frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    village: boolean,
    streetFront: ReadonlySet<string>,
    csm: CSM,
  ) {
    const walls = new MeshBuilder();
    const roofs = new MeshBuilder();
    const colors = new Map<string, Color>();
    const color = (css: string) => {
      let c = colors.get(css);
      if (!c) colors.set(css, (c = new Color(css)));
      return c;
    };
    // Пол — по верхней точке земли под домом, стены — до нижней (на склоне дом не уходит в землю).
    const siteOf = (feature: BaseBuildingFeature): Site =>
      siteOnSlope(
        polygonsOf(feature).flatMap((rings) => openRing((rings[0] ?? []).map(frame.toLocal))),
        heightAt,
      );

    const addBuilding = (owner: BaseBuildingProperties, elements: BaseBuildingFeature[], site: Site, simple: boolean, outline?: Ring) => {
      const ground = site.floor;
      const style = facadeStyle(owner, streetFront.has(owner.id), village);
      const facadeCss = facadeColorHex(owner, village);
      const facadeColor = color(facadeCss);
      const index = this.owners.length;
      const entry: Owner = { id: owner.id, props: owner, facade: facadeColor, walls: [], roofs: [], roofColors: [] };
      this.owners.push(entry);
      this.byId.set(owner.id, entry);

      for (const element of elements) {
        const props = element.properties;
        for (const rings of polygonsOf(element)) {
          const local = rings.map((ring) => openRing(ring.map(frame.toLocal)));
          const outer = local[0] ?? [];
          if (outer.length < 3) continue;
          const roof = planRoof(props, outer, rings.length > 1, village);
          const wallTop = roof.osm ? props.height - roof.height : props.height;
          const floorH = floorHeight(props, wallTop);
          // Части, что начинаются над землёй (арки, верхние ярусы), — от пола; остальные — до низа склона.
          const z0 = props.minHeight > 0 ? ground + props.minHeight : site.low - FOOTING_DEPTH;
          const z1 = ground + Math.max(wallTop, props.minHeight + 0.5);
          const facade = [ground, props.minHeight, wallTop, floorH];
          const wallStyle = [village ? 2 : style.shopfront ? 1 : 0, style.variant, style.seed, 0];

          const wallStart = walls.vertexCount;
          local.forEach((ring, ringIndex) => {
            const sign = (signedArea(ring) > 0 ? 1 : -1) * (ringIndex === 0 ? 1 : -1);
            for (let i = 0; i < ring.length; i++) {
              const a = ring[i]!;
              const b = ring[(i + 1) % ring.length]!;
              const dx = b[0] - a[0];
              const dy = b[1] - a[1];
              const len = Math.hypot(dx, dy);
              if (len < 0.01) continue;
              const outward = [(dy / len) * sign, (-dx / len) * sign, 0];
              const A0 = [a[0], a[1], z0];
              const B0 = [b[0], b[1], z0];
              const B1 = [b[0], b[1], z1];
              const A1 = [a[0], a[1], z1];
              walls.triangle(A0, B0, B1, outward, facadeColor, facade, wallStyle, index);
              walls.triangle(A0, B1, A1, outward, facadeColor, facade, wallStyle, index);
            }
          });
          // Верх стен: плоская крыша (под скатной её не видно, но она закрывает коробку сверху).
          const contour = outer.map(([x, y]) => new Vector2(x, y));
          const holes = local.slice(1).map((ring) => ring.map(([x, y]) => new Vector2(x, y)));
          const all = [...contour, ...holes.flat()];
          for (const face of ShapeUtils.triangulateShape(contour, holes)) {
            const p = face.map((i) => all[i]!).map((v) => [v.x, v.y, z1]);
            walls.triangle(p[0]!, p[1]!, p[2]!, [0, 0, 1], facadeColor, facade, wallStyle, index);
          }
          entry.walls.push([wallStart, walls.vertexCount - wallStart]);

          let roofCss: string | undefined;
          if (roof.triangles) {
            roofCss = roofColorHex(props, roof.shape, village);
            const roofColor = color(roofCss);
            const base = ground + wallTop;
            const roofStart = roofs.vertexCount;
            for (const [a, b, c] of roof.triangles) {
              roofs.triangle([a[0], a[1], base + a[2]], [b[0], b[1], base + b[2]], [c[0], c[1], base + c[2]], undefined, roofColor, [ground, 0, 0, 0], [0, 0, style.seed, 1], index);
            }
            entry.roofs.push([roofStart, roofs.vertexCount - roofStart]);
            entry.roofColors.push(roofColor);
          }

          if (!this.infos.has(owner.id)) {
            this.infos.set(owner.id, {
              props: owner,
              outline: openRing(outline ?? rings[0] ?? []) as LonLat[],
              wallTop,
              roof: roof.triangles ? roof.shape : 'flat',
              facadeColor: facadeCss,
              roofColor: roofCss,
            });
          }
          if (simple && this.shapesList[this.shapesList.length - 1]?.props !== owner) {
            this.shapesList.push({
              props: owner,
              ring: (rings[0] ?? []) as LonLat[],
              localRing: outer,
              ground,
              wallTop,
              flatRoof: !roof.triangles,
              floorHeight: floorH,
              facadeColor: facadeCss,
              style,
              roof: roof.frame,
              roofColor: roofCss,
              village,
            });
          }
        }
      }
    };

    collection.features.forEach((feature) => {
      const site = siteOf(feature);
      const own = parts.byBuilding.get(feature.properties.id);
      const outline = (feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0]?.[0]) ?? [];
      if (own?.length) addBuilding(feature.properties, own, site, false, outline);
      else addBuilding(feature.properties, [feature], site, true);
    });
    parts.orphans.forEach((part) => addBuilding(part.properties, [part], siteOf(part), false));

    this.walls = new Mesh(walls.geometry(), createFacadeMaterial(csm));
    this.roofs = new Mesh(roofs.geometry(), createRoofMaterial(csm));
    this.walls.name = 'buildings-walls';
    this.roofs.name = 'buildings-roofs';
    for (const mesh of [this.walls, this.roofs]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    this.wallOwners = Uint32Array.from(walls.owners);
    this.roofOwners = Uint32Array.from(roofs.owners);
    this.wallPositions = (this.walls.geometry.getAttribute('position').array as Float32Array).slice();
    this.roofPositions = (this.roofs.geometry.getAttribute('position').array as Float32Array).slice();
    city.scene.add(this.walls, this.roofs);
  }

  /** Треугольников всего (для статистики). */
  get triangles(): number {
    return this.wallOwners.length + this.roofOwners.length;
  }

  /** Формы зданий для слоя деталей. */
  shapes(): readonly BuildingShape[] {
    return this.shapesList;
  }

  buildingInfo(id: string): BuildingInfo | undefined {
    return this.infos.get(id);
  }

  /** Объекты для выбора кликом. */
  get pickables(): Mesh[] {
    return [this.walls, this.roofs];
  }

  /** Здание по попаданию луча (или undefined, если попали не в здания). */
  buildingFromPick(hit: Intersection | undefined): BaseBuildingProperties | undefined {
    if (!hit || hit.faceIndex == null) return undefined;
    const owners = hit.object === this.walls ? this.wallOwners : hit.object === this.roofs ? this.roofOwners : undefined;
    const index = owners?.[hit.faceIndex];
    const owner = index === undefined ? undefined : this.owners[index];
    return owner && !this.isHidden(owner.id) ? owner.props : undefined;
  }

  /** Скрыть здания (убранные редактором или заменённые правкой), остальные показать. */
  setHidden(ids: ReadonlySet<string>): void {
    const changed = [...this.hidden, ...ids].filter((id) => this.hidden.has(id) !== ids.has(id));
    this.hidden = new Set(ids);
    for (const id of changed) this.applyVisibility(id);
    if (changed.length) this.city.requestRender();
  }

  /** Дома, вместо которых нарисованы модели (деревня из моделей). */
  setReplaced(ids: ReadonlySet<string>): void {
    const changed = [...this.replaced, ...ids].filter((id) => this.replaced.has(id) !== ids.has(id));
    this.replaced = new Set(ids);
    for (const id of changed) this.applyVisibility(id);
    if (changed.length) this.city.requestRender();
  }

  /** Земля поменялась (кисть рельефа): дома в area — вместе с ней (по вершинам: стены остаются вертикальными). */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    if (!this.groundIndex) {
      const walls = new Map([...this.byId].map(([id, o]) => [id, o.walls] as const));
      const roofs = new Map([...this.byId].map(([id, o]) => [id, o.roofs] as const));
      this.groundIndex = [
        { mesh: this.walls, ranges: walls, boxes: ownerBoxes(walls, this.wallPositions), original: this.wallPositions },
        { mesh: this.roofs, ranges: roofs, boxes: ownerBoxes(roofs, this.roofPositions), original: this.roofPositions },
      ];
    }
    for (const { mesh, ranges, boxes, original } of this.groundIndex) {
      const attribute = mesh.geometry.getAttribute('position') as BufferAttribute;
      if (shiftOwners(ranges, boxes, original, attribute.array as Float32Array, (id) => this.isHidden(id), delta, area)) attribute.needsUpdate = true;
    }
  }

  private groundIndex?: { mesh: Mesh; ranges: Map<string, [number, number][]>; boxes: Map<string, GroundArea>; original: Float32Array }[];

  private isHidden(id: string): boolean {
    return this.hidden.has(id) || this.replaced.has(id);
  }

  select(id: string | undefined): void {
    if (id === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = id && this.byId.has(id) ? id : undefined;
    if (previous) this.paint(previous);
    if (this.selectedId) this.paint(this.selectedId);
    this.city.requestRender();
  }

  setConflicts(ids: readonly string[]): void {
    const previous = this.conflicts;
    this.conflicts = new Set(ids);
    for (const id of previous) this.paint(id);
    for (const id of this.conflicts) this.paint(id);
    this.city.requestRender();
  }

  setColorMode(mode: BuildingColorMode): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    for (const owner of this.owners) this.paint(owner.id);
    this.city.requestRender();
  }

  /** Показать или спрятать все здания (подложка: «спрятать дома OSM»). */
  setVisible(visible: boolean): void {
    this.walls.visible = visible;
    this.roofs.visible = visible;
    this.city.requestRender();
  }

  destroy(): void {
    this.city.scene.remove(this.walls, this.roofs);
    for (const mesh of [this.walls, this.roofs]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose: () => void }).dispose();
    }
  }

  private colorOf(owner: Owner): Color {
    if (owner.id === this.selectedId) return SELECTED;
    if (this.conflicts.has(owner.id)) return CONFLICT;
    if (this.colorMode === 'data') return owner.props.heightSource === 'default' ? ESTIMATED : KNOWN;
    return owner.facade;
  }

  private paint(id: string): void {
    const owner = this.byId.get(id);
    if (!owner) return;
    const wall = this.colorOf(owner);
    const highlighted = owner.id === this.selectedId || this.conflicts.has(owner.id);
    const fill = (mesh: Mesh, ranges: [number, number][], colorFor: (k: number) => Color) => {
      const attribute = mesh.geometry.getAttribute('color') as BufferAttribute;
      const array = attribute.array as Float32Array;
      ranges.forEach(([start, count], k) => {
        const c = colorFor(k);
        for (let v = start; v < start + count; v++) array.set([c.r, c.g, c.b], v * 3);
      });
      attribute.needsUpdate = true;
    };
    fill(this.walls, owner.walls, () => wall);
    fill(this.roofs, owner.roofs, (k) => (highlighted ? wall : owner.roofColors[k] ?? wall));
  }

  private applyVisibility(id: string): void {
    const owner = this.byId.get(id);
    if (!owner) return;
    const hide = this.isHidden(id);
    const apply = (mesh: Mesh, ranges: [number, number][], original: Float32Array) => {
      const attribute = mesh.geometry.getAttribute('position') as BufferAttribute;
      const array = attribute.array as Float32Array;
      for (const [start, count] of ranges) {
        for (let v = start; v < start + count; v++) {
          // Спрятанный дом — все вершины в одну точку: треугольники вырождаются (и в тенях тоже).
          const src = hide ? start : v;
          array[v * 3] = original[src * 3]!;
          array[v * 3 + 1] = original[src * 3 + 1]!;
          array[v * 3 + 2] = original[src * 3 + 2]!;
        }
      }
      attribute.needsUpdate = true;
    };
    apply(this.walls, owner.walls, this.wallPositions);
    apply(this.roofs, owner.roofs, this.roofPositions);
  }
}
