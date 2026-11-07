import { buffer, polygon } from '@turf/turf';
import {
  BoxGeometry,
  Cartesian3,
  Cartesian4,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  Transforms,
} from 'cesium';
import { hashString } from '../../utils/hash';
import type { LocalFrame, Vec2 } from '../walk/localFrame';
import type { BuildingShape } from './BaseBuildingsLayer';
import { balconies, entrances, type DetailBox } from './buildingDetails';
import { windowGrid } from './facades';

const VERTEX_FORMAT = PerInstanceColorAppearance.VERTEX_FORMAT;
/** Типы жилых домов, у которых бывают балконы и подъезды. */
const RESIDENTIAL = new Set(['apartments', 'residential', 'yes', 'dormitory']);
const UTILITY = new Set(['garage', 'garages', 'shed', 'service', 'transformer_tower', 'roof', 'construction', 'hut', 'kiosk']);
/** Не больше стольких балконов на весь район — страховка для слабых видеокарт. */
const MAX_BALCONIES = 16_000;
const CORNICE = { overhang: 0.35, height: 0.45 };
/** Низ балкона — не ниже стольких метров над землёй под ним. */
const BALCONY_CLEARANCE = 2.2;
/** Дверь шире окна на столько, чтобы целиком закрыть его нижнюю часть. */
const DOOR_MARGIN = 0.2;

const DOOR_COLOR = Color.fromCssColorString('#4f3f33');
/** Широкий вход (напротив ленточных окон или витрин) — остеклённый. */
const GLASS_DOOR_COLOR = Color.fromCssColorString('#2c343d');
const CANOPY_COLOR = Color.fromCssColorString('#8d9298');
const WHITE = Color.fromCssColorString('#f4f1ea');

export interface BuildingDetailsOptions {
  frame: LocalFrame;
  /** Центр района — та же точка, от которой шейдер фасадов считает сетку окон. */
  center: Cartesian3;
  /** Стена выходит на улицу (точка в локальных метрах) — туда подъезды не ставим. */
  isStreetSide: (point: Vec2) => boolean;
  /** Высота земли; на склоне дом стоит на самой низкой точке, а подъезд — на земле у двери. */
  heightAt?: (lon: number, lat: number) => number;
}

/**
 * Объёмные детали фасадов поверх стен: балконы на длинных стенах жилых домов,
 * подъезды с козырьками со стороны двора и выступающие карнизы по верху плоских крыш.
 * Двери и балконы стоят напротив нарисованных окон. Всё — один Primitive.
 */
export class BuildingDetailsLayer {
  private constructor(readonly primitive: Primitive | undefined) {}

  static create(shapes: readonly BuildingShape[], options: BuildingDetailsOptions): BuildingDetailsLayer {
    const { frame, isStreetSide, heightAt } = options;
    const toWindowAxis = windowAxis(options.center, frame);
    const instances: GeometryInstance[] = [];
    const boxes = new Map<string, BoxGeometry>();
    const boxGeometry = ([w, d, h]: [number, number, number]) => {
      const key = `${w.toFixed(2)}|${d.toFixed(2)}|${h.toFixed(2)}`;
      let geometry = boxes.get(key);
      if (!geometry) {
        geometry = BoxGeometry.fromDimensions({ dimensions: new Cartesian3(w, d, h), vertexFormat: VERTEX_FORMAT });
        boxes.set(key, geometry);
      }
      return geometry;
    };
    const addBox = (box: DetailBox, ground: number, color: Color) => {
      const [x, y, z] = box.center;
      const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...frame.toLonLat([x, y]), ground + z));
      instances.push(
        new GeometryInstance({
          geometry: boxGeometry(box.size),
          modelMatrix: Matrix4.multiply(enu, Matrix4.fromRotation(Matrix3.fromRotationZ(box.angle)), new Matrix4()),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        }),
      );
    };
    const groundAt = (shape: BuildingShape, box: DetailBox) =>
      heightAt ? Math.max(shape.ground, heightAt(...frame.toLonLat([box.center[0], box.center[1]]))) : shape.ground;
    /** Сдвигает деталь вдоль стены к центру ближайшего окна. */
    const snapToWindow = (box: DetailBox, bay: number): DetailBox => {
      const dir: Vec2 = [Math.cos(box.angle), Math.sin(box.angle)];
      const along = toWindowAxis([box.center[0], box.center[1]], dir);
      const shift = (Math.round(along / bay - 0.5) + 0.5) * bay - along;
      return { ...box, center: [box.center[0] + dir[0] * shift, box.center[1] + dir[1] * shift, box.center[2]] };
    };

    let balconyCount = 0;
    for (const shape of shapes) {
      const { props } = shape;
      if (UTILITY.has(props.building) || props.minHeight > 0 || shape.floorHeight <= 0) continue;
      const floors = Math.round(shape.wallTop / shape.floorHeight);
      const seed = hashString(props.id);

      if (RESIDENTIAL.has(props.building) && floors >= 4 && floors <= 16 && seed % 10 < 7 && balconyCount < MAX_BALCONIES) {
        const balconyColor = Color.lerp(shape.facadeColor, WHITE, 0.45, new Color());
        const { bay } = windowGrid(shape.style, false);
        const list = balconies(shape.localRing, {
          floors,
          floorHeight: shape.floorHeight,
          // Балкон — у каждого второго или третьего окна.
          bay: bay * (seed % 2 ? 2 : 3),
          minEdge: 10,
          maxPerBuilding: Math.min(320, MAX_BALCONIES - balconyCount),
        });
        for (const box of list) {
          // На склоне нижние балконы со стороны горы оказались бы у самой земли — их не ставим.
          const bottom = shape.ground + box.center[2] - box.size[2] / 2;
          if (bottom < groundAt(shape, box) + BALCONY_CLEARANCE) continue;
          addBox(snapToWindow(box, bay), shape.ground, balconyColor);
          balconyCount++;
        }
      }

      if (RESIDENTIAL.has(props.building) && floors >= 3) {
        const grid = windowGrid(shape.style, true);
        const doorWidth = Math.min(Math.max(grid.width + DOOR_MARGIN, 1.4), 4.2);
        const { doors, canopies } = entrances(shape.localRing, isStreetSide, 18, doorWidth);
        doors.forEach((door, i) => {
          const base = groundAt(shape, door);
          addBox(snapToWindow(door, grid.bay), base, doorWidth > 2.2 ? GLASS_DOOR_COLOR : DOOR_COLOR);
          const canopy = canopies[i];
          if (canopy) addBox(snapToWindow(canopy, grid.bay), base, CANOPY_COLOR);
        });
      }

      if (shape.flatRoof && shape.wallTop >= 6) {
        const cornice = corniceRing(shape.ring);
        if (cornice) {
          instances.push(
            new GeometryInstance({
              geometry: new PolygonGeometry({
                polygonHierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(cornice.flat())),
                height: shape.ground + shape.wallTop - CORNICE.height,
                extrudedHeight: shape.ground + shape.wallTop + 0.04,
                vertexFormat: VERTEX_FORMAT,
              }),
              attributes: {
                color: ColorGeometryInstanceAttribute.fromColor(Color.multiplyByScalar(shape.facadeColor, 0.86, new Color())),
              },
            }),
          );
        }
      }
    }

    return new BuildingDetailsLayer(
      instances.length
        ? new Primitive({
            geometryInstances: instances,
            appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
            shadows: ShadowMode.ENABLED,
            allowPicking: false,
          })
        : undefined,
    );
  }

  destroy(): void {
    if (this.primitive && !this.primitive.isDestroyed()) this.primitive.destroy();
  }
}

/**
 * Координата точки вдоль стены — так же, как её считает шейдер фасадов:
 * в плоскости ENU с началом в центре района (а не в локальных метрах: на краю района
 * они расходятся на десятки сантиметров — заметно на фоне окна шириной полтора метра).
 */
function windowAxis(center: Cartesian3, frame: LocalFrame): (point: Vec2, dir: Vec2) => number {
  const enu = Transforms.eastNorthUpToFixedFrame(center);
  const east = Matrix4.getColumn(enu, 0, new Cartesian4());
  const north = Matrix4.getColumn(enu, 1, new Cartesian4());
  const scratch = new Cartesian3();
  return (point, dir) => {
    Cartesian3.subtract(Cartesian3.fromDegrees(...frame.toLonLat(point), 0, undefined, scratch), center, scratch);
    const x = east.x * scratch.x + east.y * scratch.y + east.z * scratch.z;
    const y = north.x * scratch.x + north.y * scratch.y + north.z * scratch.z;
    return x * dir[0] + y * dir[1];
  };
}

/** Контур карниза: стены, раздвинутые наружу на вынос карниза (без замыкающей точки). */
function corniceRing(ring: readonly [number, number][]): [number, number][] | undefined {
  try {
    const grown = buffer(polygon([ring as [number, number][]]), CORNICE.overhang, { units: 'meters', steps: 1 });
    const geometry = grown?.geometry;
    const outer = geometry?.type === 'Polygon' ? geometry.coordinates[0] : geometry?.coordinates[0]?.[0];
    return outer && outer.length >= 4 ? (outer.slice(0, -1) as [number, number][]) : undefined;
  } catch {
    return undefined;
  }
}
