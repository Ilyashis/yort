// Подложка в сцене three.js: свой снимок сверху (с дрона, план участка, ортофото GeoTIFF) на земле.
// Сам снимок рисует шейдер земли (GroundLayer.setUnderlay — точная перспектива в каждом пикселе),
// здесь — мышь: перетаскивание снимка и совмещение по точкам (точка на снимке → та же точка на карте):
// по двум — масштаб и поворот, по четырём — ещё и перспектива кадра.
//
// Как подключить (CityViewer, после GroundLayer и OverviewControls):
//   const underlay = new UnderlayLayer(city, ground, frame, {
//     setCameraEnabled: (enabled) => overview.setEnabled(enabled), // мышь камеры — выкл. на время перетаскивания
//     pickables: () => buildings.pickables,                         // дома и 3D-объекты: точка «на карте» — с них
//   });
//   owned.push(underlay);                                            // destroy() — отписка и уборка
// Состояние — в useUnderlayStore: слой сам подписан на него (снимок, привязка, прозрачность, режим, точки)
// и регистрирует там сцену (setScene): центр вида, пересчёт координат, перелёт сверху к снимку.
// Клики по сцене в режиме подложки обрабатывает только этот слой: выбор дома и инструменты редактора
// должны их пропускать, пока useUnderlayStore.getState().mode задан.

import {
  BufferGeometry,
  CanvasTexture,
  MathUtils,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { useAppStore } from '../store/useAppStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { imageCorners, imageToLocal, localToImage, translatePlacement, type UnderlayPlacement } from '../world/edit/underlay';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toLocal2, toThree } from './coords';
import type { GroundLayer } from './GroundLayer';

const ACCENT = '#f5a524';
const MAP_POINT = '#3fb27f';
/** Сдвиг мыши, после которого нажатие — уже перетаскивание карты, а не клик, px. */
const CLICK_TOLERANCE = 5;
/** Маркер точки совмещения на экране вместе с белой обводкой, px. */
const MARKER_PX = 16;
/** Шаг, с которым контур снимка ложится на рельеф, м. */
const OUTLINE_STEP = 3;
/** Насколько маркеры и контур выше земли, м (рисуются поверх всего, но в перспективе — на своём месте). */
const LIFT = 0.4;

export interface UnderlayLayerOptions {
  /** Включить/выключить мышь камеры: на время перетаскивания снимка камера не должна ехать. */
  setCameraEnabled: (enabled: boolean) => void;
  /** Дома и прочие 3D-объекты: точка «на карте» при совмещении — с них (угол крыши), иначе земля. */
  pickables?: () => Object3D[];
}

interface Drag {
  pointerId: number;
  /** Где схватили, локальные метры. */
  start: Vec2;
  placement: UnderlayPlacement;
  delta: Vec2;
}

export class UnderlayLayer {
  private readonly imageMarkers = markerPoints(ACCENT);
  private readonly mapMarkers = markerPoints(MAP_POINT);
  private readonly outline: Line2;
  private down?: [number, number];
  private drag?: Drag;
  /** Высота кликнутых точек на карте (угол крыши — не на земле): маркер ставим туда же. */
  private readonly mapHeights = new WeakMap<Vec2, number>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly city: CityScene,
    private readonly ground: GroundLayer,
    frame: LocalFrame,
    private readonly options: UnderlayLayerOptions,
  ) {
    this.outline = new Line2(
      new LineGeometry(),
      new LineMaterial({ color: ACCENT, linewidth: 3, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.outline.renderOrder = 19;
    this.outline.frustumCulled = false;
    this.outline.visible = false;
    city.scene.add(this.imageMarkers, this.mapMarkers, this.outline);

    const canvas = city.canvas;
    // Нажатие ловим раньше управления камерой (capture): при перетаскивании снимка оно уже выключено.
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);

    useUnderlayStore.getState().setScene({
      viewCenter: () => this.viewCenter(),
      toLocal: (point) => frame.toLocal(point),
      focus: (corners) => this.focus(corners),
    });
    this.unsubscribe = useUnderlayStore.subscribe((state, prev) => {
      // Снимок поменяли, убрали или вышли из режима посреди перетаскивания — тащить больше нечего.
      if (this.drag && (state.image !== prev.image || state.placement !== prev.placement || state.mode !== 'move')) this.cancelDrag();
      if (state.image !== prev.image || state.placement !== prev.placement || state.opacity !== prev.opacity || state.visible !== prev.visible) {
        this.sync();
      }
      if (state.align !== prev.align || state.mode !== prev.mode || state.image !== prev.image || state.placement !== prev.placement) {
        this.showMarkers();
      }
      if (state.mode !== prev.mode || state.busy !== prev.busy) this.updateCursor();
      city.requestRender();
    });

    this.sync();
    this.showMarkers();
    const { mode, busy } = useUnderlayStore.getState();
    if (mode || busy) this.updateCursor();
  }

  destroy(): void {
    this.unsubscribe();
    this.cancelDrag();
    const canvas = this.city.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    const { mode, busy } = useUnderlayStore.getState();
    if (mode || busy) canvas.style.cursor = '';
    useUnderlayStore.getState().setScene(undefined);
    this.ground.setUnderlay(undefined);
    this.city.scene.remove(this.imageMarkers, this.mapMarkers, this.outline);
    for (const points of [this.imageMarkers, this.mapMarkers]) {
      points.geometry.dispose();
      points.material.map?.dispose();
      points.material.dispose();
    }
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.city.requestRender();
  }

  /** Снимок на землю — из стора, а пока тянут мышью — на месте под курсором. */
  private sync(): void {
    const { image, placement, opacity, visible } = useUnderlayStore.getState();
    const shown = placement && (this.drag ? translatePlacement(this.drag.placement, this.drag.delta) : placement);
    this.ground.setUnderlay(image && shown ? { bitmap: image.bitmap, size: image.size, placement: shown, opacity, visible } : undefined);
  }

  /** Подложкой занимаемся только в обзоре (не на прогулке и не при рисовании участка). */
  private active(): boolean {
    return useAppStore.getState().mode === 'explore';
  }

  private updateCursor(): void {
    const { mode, busy } = useUnderlayStore.getState();
    this.city.canvas.style.cursor = busy ? 'progress' : mode === 'move' ? 'move' : mode ? 'crosshair' : '';
  }

  /** Центр вида на земле, в локальных метрах. */
  private viewCenter(): Vec2 | undefined {
    const rect = this.city.canvas.getBoundingClientRect();
    const hit = this.city.pickGround(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit ? toLocal2(hit) : undefined;
  }

  /** Перелёт сверху к снимку (ортофото после загрузки): весь снимок в кадре, над рельефом, север вверху. */
  private focus(corners: Vec2[]): void {
    if (corners.length === 0) return;
    const heightAt = this.ground.heightAt;
    const points = corners.map(([x, y]) => toThree(x, y, heightAt(x, y)));
    const center = points.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(points.length);
    const radius = Math.max(...points.map((p) => p.distanceTo(center)), 10);
    const [cx, cy] = toLocal2(center);
    const target = toThree(cx, cy, heightAt(cx, cy));
    const camera = this.city.camera;
    const vfov = MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    // Шар со снимком целиком в кадре по узкой стороне экрана, с запасом; дальше 8 км управление камерой не пустит.
    const distance = MathUtils.clamp((radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.1, 60, 8000);
    this.city.flyTo(this.city.orbitPosition(target, 0, 89.9, distance), target, 1.2);
  }

  /** Точка земли под курсором, локальные метры. */
  private groundPoint(clientX: number, clientY: number): Vec2 | undefined {
    const hit = this.city.pickGround(clientX, clientY);
    return hit ? toLocal2(hit) : undefined;
  }

  // --- мышь -------------------------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    this.down = [event.clientX, event.clientY];
    const { mode, image, placement } = useUnderlayStore.getState();
    if (mode !== 'move' || !image || !placement || this.drag || !this.active()) return;
    const start = this.groundPoint(event.clientX, event.clientY);
    if (!start) return;
    this.drag = { pointerId: event.pointerId, start, placement, delta: [0, 0] };
    this.options.setCameraEnabled(false);
    this.city.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    const { image } = useUnderlayStore.getState();
    if (!drag || event.pointerId !== drag.pointerId || !image) return;
    const point = this.groundPoint(event.clientX, event.clientY);
    if (!point) return;
    drag.delta = [point[0] - drag.start[0], point[1] - drag.start[1]];
    // Снимок едет за мышью сразу (это только uniform-ы шейдера), контур — его границы на рельефе.
    this.sync();
    this.showOutline(imageCorners(image.size, translatePlacement(drag.placement, drag.delta)));
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const down = this.down;
    this.down = undefined;
    if (this.drag) {
      if (event.pointerId === this.drag.pointerId) this.finishDrag();
      return;
    }
    if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > CLICK_TOLERANCE) return;
    this.click(event.clientX, event.clientY);
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    this.down = undefined;
    if (this.drag?.pointerId === event.pointerId) this.cancelDrag();
  };

  // --- двигать мышью ----------------------------------------------------------------------------

  /** Отпустили: новое место — в стор (он сохранит), мелкое дрожание руки — не в счёт. */
  private finishDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.endDrag();
    if (Math.hypot(drag.delta[0], drag.delta[1]) > 0.05) useUnderlayStore.getState().setPlacement(translatePlacement(drag.placement, drag.delta));
    else this.sync();
  }

  /** Перетаскивание прервано: снимок — на прежнее место. */
  private cancelDrag(): void {
    if (!this.drag) return;
    this.endDrag();
    this.sync();
  }

  private endDrag(): void {
    const { pointerId } = this.drag!;
    this.drag = undefined;
    this.showOutline(undefined);
    this.options.setCameraEnabled(true);
    if (this.city.canvas.hasPointerCapture(pointerId)) this.city.canvas.releasePointerCapture(pointerId);
    this.city.requestRender();
  }

  /** Контур снимка, уложенный на рельеф (стороны — прямые и при перспективе); undefined — спрятать. */
  private showOutline(corners: Vec2[] | undefined): void {
    if (!corners) {
      this.outline.visible = false;
      return;
    }
    const heightAt = this.ground.heightAt;
    const positions: number[] = [];
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % corners.length]!;
      const steps = MathUtils.clamp(Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / OUTLINE_STEP), 1, 256);
      for (let s = 0; s < steps; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / steps;
        const y = a[1] + ((b[1] - a[1]) * s) / steps;
        positions.push(x, heightAt(x, y) + LIFT, -y);
      }
    });
    positions.push(positions[0]!, positions[1]!, positions[2]!);
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    this.outline.geometry.dispose();
    this.outline.geometry = geometry;
    this.outline.visible = true;
    this.city.requestRender();
  }

  // --- совмещение по точкам ---------------------------------------------------------------------

  private click(clientX: number, clientY: number): void {
    const { mode, align, image, placement, alignPoint } = useUnderlayStore.getState();
    if ((mode !== 'align2' && mode !== 'align4') || !image || !placement || !this.active()) return;
    if (align.images.length === align.maps.length) {
      // Точка на снимке: где кликнули по земле — тот пиксель снимка.
      const ground = this.groundPoint(clientX, clientY);
      if (ground) alignPoint(localToImage(ground, image.size, placement));
      return;
    }
    // Точка на карте: если попали в дом — его настоящая точка (угол крыши над углом стены), иначе земля.
    const hit = this.pickMap(clientX, clientY);
    if (!hit) return;
    const point = toLocal2(hit);
    this.mapHeights.set(point, hit.y);
    alignPoint(point);
  }

  /** Точка под курсором на домах и 3D-объектах (видимых и не за холмом), иначе на земле; координаты three.js. */
  private pickMap(clientX: number, clientY: number): Vector3 | undefined {
    const ground = this.city.pickGround(clientX, clientY);
    const objects = this.options.pickables?.() ?? [];
    if (objects.length > 0) {
      const raycaster = this.city.rayAt(clientX, clientY);
      const groundDistance = ground ? ground.distanceTo(raycaster.ray.origin) : Number.POSITIVE_INFINITY;
      const hit = raycaster.intersectObjects(objects, true).find((h) => isShown(h.object));
      if (hit && hit.distance <= groundDistance + 0.5) return hit.point.clone();
    }
    return ground;
  }

  private showMarkers(): void {
    const { mode, align, image, placement } = useUnderlayStore.getState();
    const on = (mode === 'align2' || mode === 'align4') && image && placement;
    const heightAt = this.ground.heightAt;
    const at = ([x, y]: Vec2, height = heightAt(x, y)) => toThree(x, y, height + LIFT);
    // Точка снимка — там, где она сейчас лежит на карте.
    this.setMarkers(this.imageMarkers, on ? align.images.map((p) => at(imageToLocal(p, image.size, placement))) : []);
    this.setMarkers(this.mapMarkers, on ? align.maps.map((p) => at(p, this.mapHeights.get(p))) : []);
    this.city.requestRender();
  }

  private setMarkers(points: Points<BufferGeometry, PointsMaterial>, positions: Vector3[]): void {
    points.geometry.dispose();
    points.geometry = new BufferGeometry().setFromPoints(positions);
    // Размер точки — в пикселях буфера кадра, а он больше CSS-пикселей на экранах Retina.
    points.material.size = MARKER_PX * this.city.renderer.getPixelRatio();
    points.visible = positions.length > 0;
  }
}

/** Маркеры точек одного цвета с белой обводкой, поверх всего и одного размера на экране. */
function markerPoints(color: string): Points<BufferGeometry, PointsMaterial> {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const disc = (radius: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  // Обводка — восьмая часть диаметра (как 2 px у точки в 12 px).
  disc(size / 2 - 1, '#ffffff');
  disc(size / 2 - 1 - size / 8, color);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new PointsMaterial({
    map: texture,
    size: MARKER_PX,
    sizeAttenuation: false,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const points = new Points(new BufferGeometry(), material);
  points.renderOrder = 20;
  points.frustumCulled = false;
  points.visible = false;
  return points;
}

/** Объект и все его родители видимы (спрятанные дома при обводке не ловят клики). */
function isShown(object: Object3D | null): boolean {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}
