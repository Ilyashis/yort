// Подложка (свой снимок сверху или ортофото) в шейдере земли: точка земли → пиксель снимка по гомографии.
// Перенесено из первой версии (three/ground.ts).

import { LinearMipmapLinearFilter, Matrix3, SRGBColorSpace, Texture, Vector2 } from 'three';
import { applyH, imageMatrix, invertH, isProjective, type ImageSize, type Mat3, type UnderlayPlacement } from '../world/edit/underlay';

/** Ждёт vLand — точку земли в локальных метрах (x — восток, y — север). */
export const UNDERLAY_GLSL = /* glsl */ `
uniform sampler2D underlayMap;
uniform mat3 underlayMatrix;
uniform vec2 underlaySize;
uniform float underlayOpacity;
void applyUnderlay(inout vec4 surface, vec2 land) {
  if (underlayOpacity <= 0.0) return;
  vec3 p = underlayMatrix * vec3(land, 1.0);
  vec2 uv = p.xy / (max(p.z, 1e-6) * underlaySize);
  vec4 photo = texture2D(underlayMap, uv);
  vec2 edge = clamp(min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-7)) + 0.5, 0.0, 1.0);
  float k = underlayOpacity * edge.x * edge.y * step(1e-6, p.z);
  surface.rgb = surface.rgb * (1.0 - k * photo.a) + photo.rgb * k;
}`;

export interface UnderlayView {
  bitmap: ImageBitmap;
  size: ImageSize;
  placement: UnderlayPlacement;
  opacity: number;
  visible: boolean;
}

export class GroundUnderlay {
  readonly uniforms = {
    underlayMap: { value: null as Texture | null },
    underlayMatrix: { value: new Matrix3() },
    underlaySize: { value: new Vector2(1, 1) },
    underlayOpacity: { value: 0 },
  };
  private texture?: Texture;

  constructor(private readonly anisotropy: number) {}

  set(view: UnderlayView | undefined): void {
    if (!view) {
      this.dispose();
      return;
    }
    if (this.texture?.image !== view.bitmap) {
      this.texture?.dispose();
      const texture = new Texture(view.bitmap);
      texture.flipY = false;
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = this.anisotropy;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      this.texture = texture;
      this.uniforms.underlayMap.value = texture;
    }
    const matrix = localToImageMatrix(view.size, view.placement);
    if (matrix) this.uniforms.underlayMatrix.value.set(...matrix);
    this.uniforms.underlaySize.value.set(view.size[0], view.size[1]);
    this.uniforms.underlayOpacity.value = view.visible && matrix ? view.opacity : 0;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = undefined;
    this.uniforms.underlayMap.value = null;
    this.uniforms.underlayOpacity.value = 0;
  }
}

/** Матрица для шейдера (по строкам): локальные метры → пиксели снимка, нормирована на w = 1 в центре снимка. */
export function localToImageMatrix(size: ImageSize, placement: UnderlayPlacement): Mat3 | undefined {
  let forward: Mat3;
  if (isProjective(placement)) forward = placement.homography;
  else {
    const [a, b, c, d, e, f] = imageMatrix(size, placement);
    forward = [a, c, e, b, d, f, 0, 0, 1];
  }
  const inverse = invertH(forward);
  if (!inverse) return undefined;
  const [cx, cy] = applyH(forward, [size[0] / 2, size[1] / 2]);
  const w = inverse[6] * cx + inverse[7] * cy + inverse[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return undefined;
  return inverse.map((value) => value / w) as Mat3;
}
