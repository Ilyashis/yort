import { Cartographic, Math as CesiumMath, type Cartesian2, type Cartesian3, type Viewer } from 'cesium';
import type { LonLat } from '../world/user/plot';

/** Точка на поверхности земли под курсором (сквозь здания и деревья). */
export function pickGround(viewer: Viewer, position: Cartesian2): Cartesian3 | undefined {
  const ray = viewer.camera.getPickRay(position);
  return ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
}

export function toLonLat(position: Cartesian3): LonLat {
  const c = Cartographic.fromCartesian(position);
  return [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
}
