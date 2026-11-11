// Небо и свет: положение солнца по времени, купол неба с облаками и звёздами,
// солнце/луна одним источником с тенью, отражения окружения из того же неба.

import {
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { smoothstep } from '../core/geo';
import { NOISE_GLSL, shared } from './shared';

const RAD = Math.PI / 180;
/** День года для солнца — 15 июля, время — уфимское (UTC+5). */
const DAY_UTC = Date.UTC(2026, 6, 15);
const UTC_OFFSET = 5;

/** Высота солнца над горизонтом и азимут от севера по часовой, радианы. */
export function sunAngles(hours: number, lat: number, lon: number): { elevation: number; azimuth: number } {
  const d = (DAY_UTC + (hours - UTC_OFFSET) * 3_600_000) / 86_400_000 - 10_957.5;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const ecl = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const obl = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(obl) * Math.sin(ecl), Math.cos(ecl));
  const dec = Math.asin(Math.sin(obl) * Math.sin(ecl));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  return {
    elevation: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)),
    azimuth: Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha)),
  };
}

const day0 = (e: number) => smoothstep(-4, 10, e);

const dirFrom = (elevation: number, azimuth: number, out: Vector3) =>
  out.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));

const rgb = (r: number, g: number, b: number) => new Color().setRGB(r, g, b);
const C = {
  zenithDay: rgb(0.1, 0.25, 0.6), horizonDay: rgb(0.52, 0.68, 0.88),
  zenithDusk: rgb(0.09, 0.13, 0.33), horizonDusk: rgb(0.9, 0.46, 0.2),
  zenithNight: rgb(0.004, 0.007, 0.02), horizonNight: rgb(0.016, 0.026, 0.052),
  sunLow: rgb(1, 0.46, 0.18), sunHigh: rgb(1, 0.95, 0.85), moon: rgb(0.55, 0.67, 1),
};

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunCol, uMoonDir, uCloudLit, uCloudShade;
uniform float uStars, uTime, uDisc, uGlow, uMoon, uCover;
varying vec3 vDir;
${NOISE_GLSL}
float h31(vec3 c) { return fract(sin(dot(c, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, 1.0 - pow(1.0 - h, 2.6));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunCol * (pow(sd, 5.0) * 0.1 + pow(sd, 48.0) * 0.3) * uGlow;
  col += uSunCol * (smoothstep(0.99972, 0.9999, sd) * 45.0 + pow(sd, 900.0) * 1.2) * uDisc;
  float md = max(dot(d, uMoonDir), 0.0);
  col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99965, 0.9999, md) * 2.4 * uDisc + pow(md, 260.0) * 0.07) * uMoon;
  if (uStars > 0.0 && d.y > 0.0) {
    vec3 q = d * 210.0;
    float s = h31(floor(q));
    float star = step(0.9962, s) * smoothstep(0.5, 0.05, length(fract(q) - 0.5));
    col += star * uStars * uDisc * (0.5 + 1.5 * fract(s * 91.7)) * smoothstep(0.0, 0.2, d.y);
  }
  if (d.y > 0.01) {
    vec2 uv = d.xz / (d.y + 0.14) * 0.8 + uTime * vec2(0.0045, 0.0017);
    float n = fbm(uv) + 0.35 * fbm(uv * 3.1 + 7.0) - 0.16;
    float dens = smoothstep(uCover, uCover + 0.26, n);
    float lit = clamp(0.55 + (n - fbm(uv + uSunDir.xz * 0.2)) * 2.5, 0.0, 1.0);
    col = mix(col, mix(uCloudShade, uCloudLit, lit), dens * smoothstep(0.01, 0.2, d.y) * 0.92);
  }
  col = mix(col, uGround, smoothstep(0.0, -0.05, d.y));
  // Для отражений окружения небо приглушаем: иначе тени уходят в синеву.
  if (uDisc < 0.5) col = mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, 0.45);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Atmosphere {
  readonly light = new DirectionalLight(0xffffff, 3);
  readonly hemi = new HemisphereLight(0x8aa0ff, 0x1a1c22, 0);
  readonly fog = new FogExp2(0xffffff, 0.00012);
  readonly sunDir = new Vector3(0, 1, 0);
  /** Что нужно знать остальному движку о свете. */
  night = 0;
  exposure = 1;
  bloom = 0.15;

  private readonly dome: Mesh;
  private readonly material: ShaderMaterial;
  private readonly envScene = new Scene();
  private readonly pmrem: PMREMGenerator;
  private envTarget?: WebGLRenderTarget;
  private envDirty = true;
  private envAt = 0;
  private readonly lightDir = new Vector3(0, 1, 0);
  private readonly moonDir = new Vector3();
  private shadowRadius = 0;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    shadowMapSize: number,
  ) {
    this.material = new ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new Color() }, uHorizon: { value: new Color() }, uGround: { value: new Color() },
        uSunDir: { value: this.sunDir }, uSunCol: { value: new Color() }, uMoonDir: { value: this.moonDir },
        uCloudLit: { value: new Color() }, uCloudShade: { value: new Color() },
        uStars: { value: 0 }, uTime: shared.uTime, uDisc: { value: 1 }, uGlow: { value: 1 }, uMoon: { value: 0 }, uCover: { value: 0.5 },
      },
    });
    const geometry = new BoxGeometry(2, 2, 2);
    this.dome = new Mesh(geometry, this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000;
    this.envScene.add(new Mesh(geometry, this.material));
    this.pmrem = new PMREMGenerator(renderer);

    const s = this.light.shadow;
    s.mapSize.set(shadowMapSize, shadowMapSize);
    s.bias = -0.0004;
    s.normalBias = 0.06;
    this.light.castShadow = true;
    scene.add(this.dome, this.light, this.light.target, this.hemi);
    scene.fog = this.fog;
    scene.environmentIntensity = 0.75;
  }

  setTime(hours: number, lat: number, lon: number): void {
    const { elevation, azimuth } = sunAngles(hours, lat, lon);
    const e = elevation / RAD;
    dirFrom(elevation, azimuth, this.sunDir);
    dirFrom(38 * RAD, azimuth + Math.PI * 0.92, this.moonDir);

    const night = smoothstep(2, -8, e);
    const dusk = smoothstep(16, 1, e) * (1 - smoothstep(-3, -11, e));
    const sunI = 3.7 * smoothstep(-1.5, 10, e);
    const moonI = 0.42 * smoothstep(-3, -9, e);
    const u = this.material.uniforms;
    const zen = (u.uZenith.value as Color).copy(C.zenithDay).lerp(C.zenithDusk, dusk).lerp(C.zenithNight, night);
    const hor = (u.uHorizon.value as Color).copy(C.horizonDay).lerp(C.horizonDusk, dusk * 0.85).lerp(C.horizonNight, night);
    const sunCol = (u.uSunCol.value as Color).copy(C.sunLow).lerp(C.sunHigh, smoothstep(0, 26, e));
    (u.uGround.value as Color).copy(hor).multiplyScalar(0.3).lerp(rgb(0.12, 0.1, 0.07).multiplyScalar(day0(e)), 0.5);
    u.uGlow.value = smoothstep(-8, 4, e);
    u.uMoon.value = smoothstep(-2, -8, e);
    u.uStars.value = smoothstep(-4, -10, e);
    const day = smoothstep(-4, 10, e);
    (u.uCloudLit.value as Color).copy(sunCol).lerp(rgb(1, 1, 1), 0.45).multiplyScalar(0.06 + 0.95 * day).lerp(C.sunLow, dusk * 0.35 * day);
    (u.uCloudShade.value as Color).copy(zen).lerp(hor, 0.6).multiplyScalar(0.75).addScalar(0.012 + 0.1 * day);

    if (sunI > 0.001) {
      this.light.color.copy(sunCol);
      this.light.intensity = sunI;
      this.lightDir.copy(this.sunDir);
    } else {
      this.light.color.copy(C.moon);
      this.light.intensity = moonI;
      this.lightDir.copy(this.moonDir);
    }
    // Низкое солнце даёт бесконечные тени — не опускаем источник тени ниже 6°.
    if (this.lightDir.y < 0.1) this.lightDir.setY(0.1).normalize();
    this.hemi.intensity = 0.55 * night;
    this.fog.color.copy(hor).lerp(zen, 0.12);
    this.night = night;
    this.exposure = 1.06 + 0.3 * night;
    this.bloom = 0.12 + 0.5 * smoothstep(4, -6, e);
    shared.uNight.value = night;
    shared.uWindows.value = smoothstep(6, -4, e);
    shared.uLamps.value = smoothstep(3, -3, e);
    this.envDirty = true;
  }

  /** Каждый кадр: тень вокруг точки внимания, обновление отражений неба. */
  update(camera: PerspectiveCamera, focus: Vector3, radius: number, now: number): void {
    const r = Math.min(2048, Math.max(96, 2 ** Math.ceil(Math.log2(radius))));
    const cam = this.light.shadow.camera;
    if (r !== this.shadowRadius) {
      this.shadowRadius = r;
      cam.left = cam.bottom = -r;
      cam.right = cam.top = r;
      cam.near = 10;
      cam.far = 6000;
      cam.updateProjectionMatrix();
    }
    // Привязка к текселям карты теней — тени не «плывут» при движении камеры.
    const d = this.lightDir;
    const right = _a.set(0, 1, 0).cross(d).normalize();
    const up = _b.copy(d).cross(right);
    const texel = (2 * r) / this.light.shadow.mapSize.x;
    const fx = focus.dot(right), fy = focus.dot(up);
    const target = this.light.target.position.copy(focus);
    target.addScaledVector(right, Math.round(fx / texel) * texel - fx).addScaledVector(up, Math.round(fy / texel) * texel - fy);
    this.light.position.copy(target).addScaledVector(d, 3000);
    this.light.target.updateMatrixWorld();

    if (this.envDirty && now - this.envAt > 350) {
      this.envDirty = false;
      this.envAt = now;
      const u = this.material.uniforms;
      u.uDisc.value = 0;
      const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 10);
      u.uDisc.value = 1;
      this.envTarget?.dispose();
      this.envTarget = next;
      this.scene.environment = next.texture;
    }
    void camera;
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.material.dispose();
    this.dome.geometry.dispose();
  }
}

const _a = new Vector3();
const _b = new Vector3();
