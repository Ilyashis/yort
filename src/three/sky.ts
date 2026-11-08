// Небо и свет окружения по времени суток: физическое небо (Preetham) с солнцем, ночью — тёмный купол,
// звёзды и луна; отражения окружения (PMREM) из этого неба пересчитываются, когда солнце заметно
// сдвинулось; дымка у горизонта меняет цвет; ночью — слабый голубоватый рассеянный свет.

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  FogExp2,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { sunAngles, type Lighting } from './dayNight';

/** Направление на солнце (единичный вектор three.js: X — восток, Y — вверх, Z — юг). */
export function sunDirection(date: Date, lat: number, lon: number): Vector3 {
  const { elevation, azimuth } = sunAngles(date, lat, lon);
  const east = Math.sin(azimuth) * Math.cos(elevation);
  const north = Math.cos(azimuth) * Math.cos(elevation);
  return new Vector3(east, Math.sin(elevation), -north).normalize();
}

/** Луна для картинки: с противоположной солнцу стороны неба, на 35° над горизонтом. */
export function moonDirection(sun: Vector3): Vector3 {
  const horizontal = new Vector3(-sun.x, 0, -sun.z);
  if (horizontal.lengthSq() < 1e-6) horizontal.set(0, 0, 1);
  horizontal.normalize().multiplyScalar(Math.cos((35 * Math.PI) / 180));
  return horizontal.setY(Math.sin((35 * Math.PI) / 180)).normalize();
}

const DOME_RADIUS = 30_000;
const STAR_COUNT = 2600;

export class SkySystem {
  private readonly sky = new Sky();
  private readonly envScene = new Scene();
  private readonly envSky = new Sky();
  private readonly pmrem: PMREMGenerator;
  private envTarget?: WebGLRenderTarget;
  private readonly envSun = new Vector3(0, -1, 0);
  private envNight = -1;
  private readonly dome: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly stars: Points<BufferGeometry, PointsMaterial>;
  private readonly moon: Sprite;
  private readonly ambient = new HemisphereLight('#4a5f95', '#1c2018', 0);
  private readonly fog = new FogExp2(0xc5d3df, 0.000105);

  constructor(
    private readonly scene: Scene,
    renderer: WebGLRenderer,
  ) {
    this.sky.scale.setScalar(400_000);
    this.envSky.scale.setScalar(400_000);
    for (const sky of [this.sky, this.envSky]) {
      const u = sky.material.uniforms;
      u['turbidity']!.value = 1.8;
      u['rayleigh']!.value = 2.1;
      u['mieCoefficient']!.value = 0.0025;
      u['mieDirectionalG']!.value = 0.82;
    }
    this.envScene.add(this.envSky);
    this.pmrem = new PMREMGenerator(renderer);

    // Ночной купол: тёмно-синий к зениту, чуть светлее у горизонта; проявляется к ночи.
    this.dome = new Mesh(
      new SphereGeometry(DOME_RADIUS, 32, 16),
      new ShaderMaterial({
        uniforms: { opacity: { value: 0 } },
        vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
        fragmentShader: /* glsl */ `
uniform float opacity;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, 0.0, 1.0);
  vec3 zenith = vec3(0.012, 0.02, 0.055);
  vec3 horizon = vec3(0.06, 0.085, 0.16);
  gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.45)), opacity);
}`,
        side: BackSide,
        transparent: true,
        depthWrite: false,
        fog: false,
      }),
    );
    this.dome.renderOrder = -2;
    this.dome.frustumCulled = false;

    // Звёзды: случайные точки верхней полусферы, у горизонта — тусклее.
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors = new Float32Array(STAR_COUNT * 3);
    let seed = 12345;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < STAR_COUNT; i++) {
      const y = Math.pow(random(), 0.7);
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      positions.set([Math.cos(angle) * r * DOME_RADIUS * 0.95, y * DOME_RADIUS * 0.95, Math.sin(angle) * r * DOME_RADIUS * 0.95], i * 3);
      const brightness = (0.35 + 0.65 * random() ** 3) * (0.35 + 0.65 * y);
      const warm = random() < 0.15 ? 0.85 : 1;
      colors.set([brightness, brightness * (warm < 1 ? 0.92 : 1), brightness * warm], i * 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    this.stars = new Points(
      geometry,
      new PointsMaterial({ size: 1.8, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false }),
    );
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;

    // Луна: светлый диск с мягким ореолом.
    this.moon = new Sprite(new SpriteMaterial({ map: moonTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false, blending: AdditiveBlending }));
    this.moon.scale.setScalar(900);
    this.moon.renderOrder = -1;

    scene.add(this.sky, this.dome, this.stars, this.moon, this.ambient);
    scene.fog = this.fog;
  }

  /** Солнце, луна и освещение под время суток. */
  update(sun: Vector3, moon: Vector3, lighting: Lighting): void {
    this.sky.material.uniforms['sunPosition']!.value.copy(sun);
    this.dome.material.uniforms['opacity']!.value = lighting.night * 0.92;
    this.dome.visible = lighting.night > 0.001;
    this.stars.material.opacity = lighting.stars;
    this.stars.visible = lighting.stars > 0.001;
    this.moon.position.copy(moon).multiplyScalar(DOME_RADIUS * 0.9);
    this.moon.material.opacity = Math.min(1, lighting.night * 1.2);
    this.moon.visible = lighting.night > 0.01;
    this.ambient.intensity = lighting.nightAmbient;
    this.fog.color.copy(linearColor(lighting.fog));
    this.scene.environmentIntensity = lighting.environment;

    // Отражения окружения — заново, только если небо заметно изменилось (это десяток миллисекунд).
    if (this.envTarget && sun.angleTo(this.envSun) < 0.03 && Math.abs(lighting.night - this.envNight) < 0.05) return;
    this.envSun.copy(sun);
    this.envNight = lighting.night;
    this.envSky.material.uniforms['sunPosition']!.value.copy(sun);
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 1, 500_000);
    this.scene.environment = this.envTarget.texture;
    previous?.dispose();
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.moon.material.map?.dispose();
  }
}

function moonTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const halo = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  halo.addColorStop(0, 'rgba(255, 252, 235, 1)');
  halo.addColorStop(0.16, 'rgba(240, 238, 225, 1)');
  halo.addColorStop(0.2, 'rgba(160, 180, 230, 0.35)');
  halo.addColorStop(1, 'rgba(60, 80, 140, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Цвет sRGB 0..1 → Color (линейный). */
export function linearColor([r, g, b]: [number, number, number]): Color {
  return new Color().setRGB(r, g, b).convertSRGBToLinear();
}
