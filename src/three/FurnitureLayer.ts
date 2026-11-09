// Уличная мебель: фонари с консолью и плафоном и скамейки вдоль дорожек.
// Одной геометрией; фонари и скамейки на пятне новых домов и дорог прячутся.
// Ночью плафоны светятся (тёплый свет, сила — от общего «ночного» множителя), вокруг них — ореол,
// а под ними на земле — пятна света (их рисует земля, см. GroundLayer.setLamps).

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Matrix4,
  MeshStandardMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { pointsInsideAreas } from '../world/base/hiding';
import type { Placed } from '../world/base/streetFurniture';
import type { LonLat } from '../world/user/plot';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { MergedBuilder, type GroundArea, type GroundDelta, type MergedMesh } from './merged';
import { NIGHT } from './nightUniforms';
import type { ShaderHook } from './shaderHooks';

const METAL = new Color('#3c4045');
const LAMP_GLASS = new Color('#e4e0cf');
const LAMP_LIGHT = new Color('#ffcf8a');
const WOOD = new Color('#8a6a4a');
const UP = new Vector3(0, 1, 0);

// Размеры в осях объекта: x — поперёк, y — по heading (вперёд), z — вверх.
const LAMP_POLE = new CylinderGeometry(0.06, 0.09, 7, 8);
const box = (x: number, y: number, z: number) => new BoxGeometry(x, z, y);
const LAMP_ARM = box(0.07, 1.4, 0.07);
const LAMP_HEAD = box(0.28, 0.55, 0.12);
const BENCH_SEAT = box(0.45, 1.6, 0.06);
const BENCH_BACK = box(0.06, 1.6, 0.4);
const BENCH_LEG = box(0.45, 0.06, 0.45);
/** Плафон: вынос от столба и высота центра. */
const HEAD_REACH = 1.3;
const HEAD_HEIGHT = 6.82;
/** Ореол вокруг плафона, м. */
const GLOW_SIZE = 3.2;

/** Плафон светится ночью: собственный свет × «сила фонарей» (0 днём). */
const glowingGlass: ShaderHook = (shader) => {
  shader.uniforms['citiaLamps'] = NIGHT.lamps;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float citiaLamps;')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= citiaLamps;');
};

export class FurnitureLayer {
  private readonly merged?: MergedMesh;
  private readonly glass?: MergedMesh;
  private readonly glow?: Points<BufferGeometry, ShaderMaterial>;
  private readonly positions: LonLat[];
  /** Точки на земле под плафонами (локальные метры). */
  private readonly lampGround: Vec2[];
  private readonly lampCount: number;
  private hidden: readonly boolean[] = [];

  constructor(
    private readonly city: CityScene,
    lamps: readonly Placed[],
    benches: readonly Placed[],
    frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    csm: CSM,
  ) {
    const builder = new MergedBuilder();
    const glassBuilder = new MergedBuilder();
    this.positions = [...lamps, ...benches].map((p) => p.position);
    this.lampCount = lamps.length;
    /** Часть объекта: смещение (x, y, z) в осях объекта с курсом heading (рад от севера по часовой). */
    const at = (item: Placed, x: number, y: number, z: number) => {
      const [px, py] = frame.toLocal(item.position);
      const ground = heightAt(px, py);
      const q = new Quaternion().setFromAxisAngle(UP, -item.heading);
      // Оси объекта → three: x → X, y (вперёд) → −Z, z → Y.
      const offset = new Vector3(x, z, -y).applyQuaternion(q);
      return new Matrix4().compose(new Vector3(px, ground, -py).add(offset), q, new Vector3(1, 1, 1));
    };
    const heads: Vector3[] = [];
    lamps.forEach((lamp, i) => {
      const owner = String(i);
      builder.add(LAMP_POLE, at(lamp, 0, 0, 3.5), METAL, owner);
      builder.add(LAMP_ARM, at(lamp, 0, 0.65, 6.9), METAL, owner);
      const head = at(lamp, 0, HEAD_REACH, HEAD_HEIGHT);
      glassBuilder.add(LAMP_HEAD, head, LAMP_GLASS, owner);
      heads.push(new Vector3().setFromMatrixPosition(head));
    });
    this.lampGround = heads.map((h) => [h.x, -h.z]);
    benches.forEach((bench, j) => {
      const owner = String(lamps.length + j);
      builder.add(BENCH_SEAT, at(bench, 0, 0, 0.45), WOOD, owner);
      builder.add(BENCH_BACK, at(bench, -0.22, 0, 0.72), WOOD, owner);
      builder.add(BENCH_LEG, at(bench, 0, 0.7, 0.22), METAL, owner);
      builder.add(BENCH_LEG, at(bench, 0, -0.7, 0.22), METAL, owner);
    });
    if (!builder.empty) {
      this.merged = builder.build('street-furniture', csm);
      city.scene.add(this.merged.mesh);
    }
    if (!glassBuilder.empty) {
      this.glass = glassBuilder.build('lamp-glass', csm, glowingGlass);
      const material = this.glass.mesh.material as MeshStandardMaterial;
      material.emissive.copy(LAMP_LIGHT);
      material.emissiveIntensity = 4;
      city.scene.add(this.glass.mesh);
      this.glow = glowPoints(heads.map((h) => h.clone().add(new Vector3(0, -0.15, 0))));
      city.scene.add(this.glow);
    }
  }

  /** Где на земле светлые пятна от горящих фонарей (локальные метры). */
  lampSpots(): Vec2[] {
    return this.lampGround.filter((_, i) => !this.hidden[i]);
  }

  /** Спрятать фонари и скамейки в этих областях (lon/lat) с запасом margin метров. true — если что-то поменялось. */
  hideWithin(areas: readonly (readonly LonLat[])[], margin: number, extra: readonly (readonly LonLat[])[] = []): boolean {
    if (!this.merged) return false;
    const inside = pointsInsideAreas(this.positions, areas, margin);
    if (extra.length) pointsInsideAreas(this.positions, extra, 0).forEach((hit, i) => (inside[i] ||= hit));
    this.hidden = inside;
    const hide = (owner: string) => inside[Number(owner)] ?? false;
    const changed = this.merged.setHidden(hide);
    this.glass?.setHidden(hide);
    if (this.glow) {
      const alive = this.glow.geometry.getAttribute('alive') as BufferAttribute;
      for (let i = 0; i < this.lampCount; i++) alive.setX(i, inside[i] ? 0 : 1);
      alive.needsUpdate = true;
    }
    if (changed) this.city.requestRender();
    return changed;
  }

  /** Земля поменялась (кисть рельефа): фонари и скамейки в area — вместе с ней, и свечение фонарей тоже. */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    this.merged?.shiftGround(delta, area);
    this.glass?.shiftGround(delta, area);
    if (this.glow) {
      const position = this.glow.geometry.getAttribute('position') as BufferAttribute;
      const array = position.array as Float32Array;
      let changed = false;
      for (let v = 0; v < position.count; v++) {
        const x = array[v * 3]!;
        const y = -array[v * 3 + 2]!;
        if (x < area.x0 || x > area.x1 || y < area.y0 || y > area.y1) continue;
        const d = delta(x, y);
        if (!d) continue;
        array[v * 3 + 1]! += d;
        changed = true;
      }
      if (changed) position.needsUpdate = true;
    }
  }

  destroy(): void {
    for (const merged of [this.merged, this.glass]) {
      if (!merged) continue;
      this.city.scene.remove(merged.mesh);
      merged.dispose();
    }
    if (this.glow) {
      this.city.scene.remove(this.glow);
      this.glow.geometry.dispose();
      this.glow.material.uniforms['map']!.value.dispose();
      this.glow.material.dispose();
    }
  }
}

/** Ореолы вокруг плафонов: мягкие тёплые пятна, складываются со светом сцены; днём не видны. */
function glowPoints(centers: Vector3[]): Points<BufferGeometry, ShaderMaterial> {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(centers.flatMap((c) => [c.x, c.y, c.z])), 3));
  geometry.setAttribute('alive', new BufferAttribute(new Float32Array(centers.length).fill(1), 1));
  geometry.computeBoundingSphere();
  const material = new ShaderMaterial({
    uniforms: { lamps: NIGHT.lamps, map: { value: glowTexture() }, size: { value: GLOW_SIZE }, viewport: { value: 800 } },
    vertexShader: /* glsl */ `
uniform float lamps;
uniform float size;
uniform float viewport;
attribute float alive;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Размер в метрах → пиксели (как у точек с перспективой); вдали ореол не меньше пары пикселей.
  float pixels = size * projectionMatrix[1][1] * 0.5 * viewport / -mv.z;
  gl_PointSize = lamps * alive > 0.001 ? max(pixels, 2.0) : 0.0;
  vFade = lamps * alive * clamp(1.0 - (-mv.z - 600.0) / 900.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D map;
varying float vFade;
void main() {
  if (vFade < 0.001) discard;
  vec4 c = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(c.rgb * c.a * vFade * 1.4, 1.0);
}`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geometry, material);
  points.name = 'lamp-glow';
  points.renderOrder = 2;
  const buffer = new Vector2();
  points.onBeforeRender = (renderer) => {
    material.uniforms['viewport']!.value = renderer.getDrawingBufferSize(buffer).y;
  };
  return points;
}

function glowTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255, 236, 200, 1)');
  g.addColorStop(0.12, 'rgba(255, 210, 150, 0.75)');
  g.addColorStop(0.4, 'rgba(255, 180, 110, 0.18)');
  g.addColorStop(1, 'rgba(255, 160, 90, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}
