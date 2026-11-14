// Адресные таблички на домах деревни: синяя табличка с белой надписью «ул. Ленина / 38» у правого угла
// уличного фасада. Дом стоит так же, как в VillageModelsLayer (прямоугольник → место, поворот, масштаб
// под модель, пол — на склоне), табличка — в осях модели (world/village/addressPlate).
//
// Открытый интерфейс:
//   new AddressPlates(city, heightAt);
//   update(items)  — какие дома с какими надписями (пересобирается только изменившееся);
//   destroy().

import { CanvasTexture, Group, LinearMipmapLinearFilter, Matrix4, Mesh, MeshStandardMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import { siteOnSlope } from '../world/base/siting';
import { modelPlacement } from '../world/edit/edits';
import { platePlacement, PLATE_SIZE } from '../world/village/addressPlate';
import { findHouseModel, type HouseModelId } from '../world/village/houseModels';
import { mirrorPartsX } from '../world/village/houseParts';
import { fitPreset, fitScale } from '../world/village/villagePlan';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toThree } from './coords';

/** Дом-модель: табличка на уличном фасаде модели. */
export interface ModelPlate {
  /** Дом (id в сцене) — по нему табличка узнаётся при обновлении. */
  id: string;
  /** Прямоугольник модели: локальные метры, первая сторона — уличный фасад. */
  rect: Vec2[];
  model: HouseModelId;
  seed: number;
  /** Надпись: строки через «\n». */
  text: string;
  /**
   * Свой дом из правок: модель строится ровно по контуру (как в EditLayer), без подгонки масштабом;
   * mirror и options — как у модели в правке.
   */
  exact?: { mirror?: boolean; options?: { porch?: boolean; veranda?: boolean } };
}

/** Здание без модели: табличка на стене a → b (локальные метры), лицом наружу — в сторону normal. */
export interface WallPlate {
  id: string;
  wall: [Vec2, Vec2];
  normal: Vec2;
  text: string;
}

export type PlateItem = ModelPlate | WallPlate;

const UP = new Vector3(0, 1, 0);
const PLATE_BLUE = '#1f4e9c';

export class AddressPlates {
  private readonly group = new Group();
  private readonly geometry = new PlaneGeometry(PLATE_SIZE[0], PLATE_SIZE[1]);
  private readonly plates = new Map<string, { key: string; mesh: Mesh; material: MeshStandardMaterial }>();

  constructor(
    private readonly city: CityScene,
    private readonly heightAt: (x: number, y: number) => number,
  ) {
    this.group.name = 'address-plates';
    city.scene.add(this.group);
  }

  update(items: readonly PlateItem[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.text.trim()) continue;
      if ('model' in item) {
        const model = findHouseModel(item.model);
        if (!model || model.group === 'small' || item.rect.length < 4) continue;
      }
      seen.add(item.id);
      const key =
        'model' in item
          ? `${item.text}|${item.model}|${item.seed}|${JSON.stringify(item.exact ?? '')}|${item.rect.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(';')}`
          : `${item.text}|${item.wall.flat().map((v) => v.toFixed(2)).join(',')}`;
      const old = this.plates.get(item.id);
      if (old?.key === key) continue;
      if (old) this.drop(item.id);
      const material = new MeshStandardMaterial({ map: plateTexture(item.text), roughness: 0.55, metalness: 0.1 });
      const mesh = new Mesh(this.geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(this.matrixFor(item));
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = `plate:${item.id}`;
      this.group.add(mesh);
      this.plates.set(item.id, { key, mesh, material });
    }
    for (const id of [...this.plates.keys()]) if (!seen.has(id)) this.drop(id);
    this.city.requestRender();
  }

  destroy(): void {
    for (const id of [...this.plates.keys()]) this.drop(id);
    this.geometry.dispose();
    this.city.scene.remove(this.group);
  }

  /** Дом — как в VillageModelsLayer, табличка — в его осях (three: x, z, −y модели). */
  private matrixFor(item: PlateItem): Matrix4 {
    if (!('model' in item)) return this.wallMatrix(item);
    const place = modelPlacement(item.rect);
    const site = siteOnSlope(item.rect, this.heightAt);
    if (item.exact) {
      // Как EditLayer: модель по контуру, без масштаба; отражённая — табличка на отражённом фасаде.
      const plan = findHouseModel(item.model)!.plan({ seed: item.seed, width: place.width, depth: place.depth, ...item.exact.options });
      const parts = item.exact.mirror ? mirrorPartsX(plan.parts) : plan.parts;
      const at = platePlacement(parts, plan.width, plan.depth);
      const [sx, sz] = fitScale(plan.width, plan.depth, place.width, place.depth);
      return new Matrix4()
        .compose(toThree(place.center[0], place.center[1], site.floor), new Quaternion().setFromAxisAngle(UP, place.angle), new Vector3(sx, 1, sz))
        .multiply(new Matrix4().makeTranslation(at.x, at.z, -at.y));
    }
    const fit = fitPreset(item.model, place.width, place.depth);
    const plan = findHouseModel(item.model)!.plan({ seed: item.seed, width: fit.size[0], depth: fit.size[1] });
    const house = new Matrix4().compose(
      toThree(place.center[0], place.center[1], site.floor),
      new Quaternion().setFromAxisAngle(UP, place.angle),
      new Vector3(fit.scale[0], 1, fit.scale[1]),
    );
    const at = platePlacement(plan.parts, plan.width, plan.depth);
    // Плоскость смотрит в +z (three) — это −y модели, к улице.
    return house.multiply(new Matrix4().makeTranslation(at.x, at.z, -at.y));
  }

  /** Табличка на стене здания без модели: у правого края стены (если смотреть снаружи), на высоте 1,95 м. */
  private wallMatrix(item: WallPlate): Matrix4 {
    const [a, b] = item.wall;
    const n = item.normal;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // Смотрим на стену снаружи (против normal): правая рука — (−n.y, n.x).
    const right: Vec2 = [-n[1], n[0]];
    const shift = Math.max(0, length / 2 - 0.75);
    const mid: Vec2 = [(a[0] + b[0]) / 2 + right[0] * shift + n[0] * 0.04, (a[1] + b[1]) / 2 + right[1] * shift + n[1] * 0.04];
    const ground = this.heightAt(mid[0] - n[0] * 0.3, mid[1] - n[1] * 0.3);
    // Плоскость смотрит в +z three; нормаль стены в three — (n.x, 0, −n.y).
    return new Matrix4().compose(toThree(mid[0], mid[1], ground + 1.95), new Quaternion().setFromAxisAngle(UP, Math.atan2(n[0], -n[1])), new Vector3(1, 1, 1));
  }

  private drop(id: string): void {
    const plate = this.plates.get(id);
    if (!plate) return;
    this.group.remove(plate.mesh);
    plate.material.map?.dispose();
    plate.material.dispose();
    this.plates.delete(id);
  }
}

/** Синяя табличка с белой рамкой: улица сверху мельче, номер снизу крупно. */
function plateTexture(text: string): CanvasTexture {
  const [first = '', second] = text.split('\n');
  const street = second === undefined ? '' : first;
  const number = second ?? first;
  const width = 512;
  const height = Math.round((width * PLATE_SIZE[1]) / PLATE_SIZE[0]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const radius = 26;
  ctx.fillStyle = PLATE_BLUE;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, radius);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.roundRect(16, 16, width - 32, height - 32, radius - 10);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fit = (line: string, size: number, weight: number, maxWidth: number) => {
    let s = size;
    ctx.font = `${weight} ${s}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    while (ctx.measureText(line).width > maxWidth && s > 14) {
      s -= 2;
      ctx.font = `${weight} ${s}px -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    }
  };
  if (street) {
    fit(street, 74, 600, width - 70);
    ctx.fillText(street, width / 2, height * 0.33);
    fit(number, 132, 800, width - 70);
    ctx.fillText(number, width / 2, height * 0.68);
  } else {
    fit(number, 170, 800, width - 70);
    ctx.fillText(number, width / 2, height / 2 + 4);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return texture;
}
