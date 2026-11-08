// Здания User World в three.js: размещённые из конструктора и предпросмотр того, что сейчас в нём.
// Тот же шейдер фасадов (окна, витрины, карниз) и тот же материал скатных крыш, что у домов OSM
// (BuildingsLayer), — новые дома выглядят «своими». Геометрия маленькая, поэтому при каждом
// изменении пересобираем её целиком.
//
// API:
//   const layer = new UserBuildingsLayer(city, frame, heightAt);  // heightAt — высота земли в локальных метрах
//   layer.render(userBuildings, preview?);  // показать здания; preview — дом из конструктора (id любой, например 'preview')
//   layer.pickables;                         // меши для city.pickObject(clientX, clientY, [...])
//   layer.idFromPick(hit);                   // id здания пользователя в сцене ('user/…', как userBuildingId) или undefined;
//                                            // у предпросмотра — undefined (его не выбирают)
//   layer.destroy();

import { Color, Mesh, ShapeUtils, Vector2, type Intersection } from 'three';
import { hashString } from '../utils/hash';
import { roofColorHex } from '../world/base/buildingPlan';
import { openRing, roofTriangles, signedArea } from '../world/base/roofGeometry';
import { toProperties, userBuildingId, type UserBuilding } from '../world/user/userBuildings';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { createFacadeMaterial, createRoofMaterial } from './facadeShader';
import { MeshBuilder } from './meshBuilder';
import { FOOTING_DEPTH, siteOnSlope } from '../world/base/siting';

/** Свес скатной крыши за стены, м (как у малоэтажных домов города). */
const ROOF_OVERHANG = 0.4;

export class UserBuildingsLayer {
  private readonly walls: Mesh;
  private readonly roofs: Mesh;
  /** id в сцене по номеру владельца треугольника; undefined — предпросмотр. */
  private ids: (string | undefined)[] = [];
  private wallOwners: readonly number[] = [];
  private roofOwners: readonly number[] = [];

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    /** Высота земли в локальных метрах. */
    private readonly heightAt: (x: number, y: number) => number,
  ) {
    this.walls = new Mesh(new MeshBuilder().geometry(), createFacadeMaterial(city.csm));
    this.roofs = new Mesh(new MeshBuilder().geometry(), createRoofMaterial(city.csm));
    this.walls.name = 'user-buildings-walls';
    this.roofs.name = 'user-buildings-roofs';
    for (const mesh of [this.walls, this.roofs]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    city.scene.add(this.walls, this.roofs);
  }

  /** Объекты для выбора кликом. */
  get pickables(): Mesh[] {
    return [this.walls, this.roofs];
  }

  render(placed: readonly UserBuilding[], preview?: UserBuilding): void {
    const items = preview ? [...placed, preview] : placed;
    const walls = new MeshBuilder();
    const roofs = new MeshBuilder();
    items.forEach((item, owner) => this.addBuilding(item, owner, walls, roofs));
    this.ids = items.map((item) => (item === preview ? undefined : userBuildingId(item.id)));
    this.wallOwners = walls.owners;
    this.roofOwners = roofs.owners;
    replaceGeometry(this.walls, walls);
    replaceGeometry(this.roofs, roofs);
    this.city.requestRender();
  }

  /** id здания пользователя по попаданию луча, иначе undefined. */
  idFromPick(hit: Intersection | undefined): string | undefined {
    if (!hit || hit.faceIndex == null) return undefined;
    const owners = hit.object === this.walls ? this.wallOwners : hit.object === this.roofs ? this.roofOwners : undefined;
    const owner = owners?.[hit.faceIndex];
    return owner === undefined ? undefined : this.ids[owner];
  }

  destroy(): void {
    this.city.scene.remove(this.walls, this.roofs);
    for (const mesh of [this.walls, this.roofs]) {
      mesh.geometry.dispose();
      (mesh.material as { dispose: () => void }).dispose();
    }
    this.city.requestRender();
  }

  private addBuilding(item: UserBuilding, owner: number, walls: MeshBuilder, roofs: MeshBuilder): void {
    const { id, spec, building } = item;
    const ring = openRing(building.footprint.map(this.frame.toLocal));
    if (ring.length < 3) return;
    const site = siteOnSlope(ring, this.heightAt);
    const ground = site.floor;
    const bottom = site.low - FOOTING_DEPTH;
    const top = ground + building.wallHeight;
    const color = new Color(spec.facadeColor);
    const seed = (hashString(id) % 10_000) / 10_000;
    const facade = [ground, 0, building.wallHeight, building.floorHeight];
    const wallStyle = [spec.shops ? 1 : 0, building.windowVariant, seed, 0];

    // Стены: нормаль наружу по направлению обхода контура.
    const sign = signedArea(ring) > 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const outward = [(dy / len) * sign, (-dx / len) * sign, 0];
      const A0 = [a[0], a[1], bottom];
      const B0 = [b[0], b[1], bottom];
      const B1 = [b[0], b[1], top];
      const A1 = [a[0], a[1], top];
      walls.triangle(A0, B0, B1, outward, color, facade, wallStyle, owner);
      walls.triangle(A0, B1, A1, outward, color, facade, wallStyle, owner);
    }
    // Верх стен: плоская крыша (под скатной её не видно, но она закрывает коробку сверху).
    const contour = ring.map(([x, y]) => new Vector2(x, y));
    for (const face of ShapeUtils.triangulateShape(contour, [])) {
      const p = face.map((i) => ring[i]!).map(([x, y]) => [x, y, top]);
      walls.triangle(p[0]!, p[1]!, p[2]!, [0, 0, 1], color, facade, wallStyle, owner);
    }

    // Скатная крыша — вальмовая, как у домов города (на непрямоугольном контуре — шатром).
    if (building.roof !== 'pitched') return;
    const triangles = roofTriangles(ring, 'hipped', building.ridgeHeight, 'along', ROOF_OVERHANG);
    if (!triangles) return;
    const roofColor = new Color(roofColorOf(item));
    for (const [a, b, c] of triangles) {
      roofs.triangle([a[0], a[1], top + a[2]], [b[0], b[1], top + b[2]], [c[0], c[1], top + c[2]], undefined, roofColor, [ground, 0, 0, 0], [0, 0, seed, 1], owner);
    }
  }
}

/** Цвет кровли из палитры города — по цвету фасада, чтобы у предпросмотра и построенного дома он совпадал. */
function roofColorOf(item: UserBuilding): string {
  return roofColorHex({ ...toProperties(item), id: item.spec.facadeColor }, 'hipped', false);
}

/** Подменить геометрию меша новой (старую — освободить). */
function replaceGeometry(mesh: Mesh, builder: MeshBuilder): void {
  const old = mesh.geometry;
  mesh.geometry = builder.geometry();
  old.dispose();
}
