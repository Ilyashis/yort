// «Рисованный» вид: мягкое размытие дали (по желанию — как у фотоаппарата: резко там, куда смотрит
// камера, дальше — мягче), тонкие тёмные контуры по силуэтам
// и изломам (сосед не лежит в плоскости пикселя — значит, край) и цветокоррекция — чуть больше
// насыщенности, тёплый свет и прохладные тени, мягкая виньетка. Глубину берём из прохода AO (GTAO),
// который и так рисует буфер глубины и нормалей, — второй раз сцену не рисуем.

import { Matrix4, Vector2, type DepthTexture, type PerspectiveCamera } from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export function createIllustrationPass(camera: PerspectiveCamera, depth: DepthTexture): ShaderPass {
  const pass = new ShaderPass({
    name: 'CitiaIllustration',
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: depth },
      inverseProjection: { value: new Matrix4() },
      projection11: { value: 1 },
      resolution: { value: new Vector2(1, 1) },
      outlineStrength: { value: 0.7 },
      useOutlines: { value: 1 },
      /** 0 — без размытия, 1 — мягкое размытие дальше точки фокуса. */
      blurStrength: { value: 0 },
      /** Расстояние до того, на что смотрит камера, м (там — резко). */
      focusDistance: { value: 300 },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 inverseProjection;
uniform float projection11;
uniform vec2 resolution;
uniform float outlineStrength;
uniform float useOutlines;
uniform float blurStrength;
uniform float focusDistance;
varying vec2 vUv;

// Диск выборок (Пуассон) для размытия.
const vec2 DISC[12] = vec2[12](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

vec3 eyeAt(vec2 uv, out bool sky) {
  float d = texture2D(tDepth, uv).x;
  sky = d >= 1.0;
  vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

vec3 grade(vec3 color, vec2 uv) {
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, 1.12);
  vec3 shadowTint = vec3(0.95, 0.98, 1.05);
  vec3 lightTint = vec3(1.04, 1.0, 0.95);
  color *= mix(shadowTint, lightTint, smoothstep(0.12, 0.7, lum));
  color = clamp(color, 0.0, 1.0);
  color = mix(color, color * color * (3.0 - 2.0 * color), 0.12);
  float vignette = 1.0 - 0.1 * pow(clamp(length(uv - 0.5) * 1.35, 0.0, 1.0), 2.5);
  return color * vignette;
}

void main() {
  vec4 source = texture2D(tDiffuse, vUv);
  vec3 color = source.rgb;
  bool sky;
  vec3 c = eyeAt(vUv, sky);
  // Размытие дали: радиус растёт от 1,6 до 6 расстояний фокуса; близкие предметы в размытый фон не тянем.
  float blurK = 0.0;
  if (blurStrength > 0.0) {
    float far = sky ? 1e6 : length(c);
    float k = smoothstep(focusDistance * 1.6, focusDistance * 6.0, far) * blurStrength;
    blurK = k;
    if (k > 0.01) {
      vec2 radius = vec2(k * 2.8 * resolution.y / 1000.0) / resolution;
      vec3 sum = color;
      float weight = 1.0;
      for (int i = 0; i < 12; i++) {
        vec2 uv = vUv + DISC[i] * radius;
        bool s2;
        vec3 p2 = eyeAt(uv, s2);
        float d2 = s2 ? 1e6 : length(p2);
        float w = smoothstep(focusDistance * 1.2, focusDistance * 2.0, d2);
        sum += texture2D(tDiffuse, uv).rgb * w;
        weight += w;
      }
      color = sum / weight;
    }
  }
  if (!sky && useOutlines > 0.5) {
    vec2 px = 1.0 / resolution;
    bool sL; bool sR; bool sD; bool sU;
    vec3 l = eyeAt(vUv - vec2(px.x, 0.0), sL);
    vec3 r = eyeAt(vUv + vec2(px.x, 0.0), sR);
    vec3 d = eyeAt(vUv - vec2(0.0, px.y), sD);
    vec3 u = eyeAt(vUv + vec2(0.0, px.y), sU);
    vec3 dx = length(c - l) < length(r - c) ? c - l : r - c;
    vec3 dy = length(c - d) < length(u - c) ? c - d : u - c;
    vec3 n = normalize(cross(dx, dy));
    float dist = length(c);
    float pixel = dist * 2.0 / (projection11 * resolution.y);
    float lo = 0.55 * pixel + 0.02;
    float hi = 1.1 * pixel + 0.05;
    float edge = (sL || sR || sD || sU) ? 1.0 : 0.0;
    edge = max(edge, smoothstep(lo, hi, abs(dot(l - c, n))));
    edge = max(edge, smoothstep(lo, hi, abs(dot(r - c, n))));
    edge = max(edge, smoothstep(lo, hi, abs(dot(d - c, n))));
    edge = max(edge, smoothstep(lo, hi, abs(dot(u - c, n))));
    edge *= 1.0 - smoothstep(900.0, 3000.0, dist);
    // В размытой дали и контуры растворяются.
    edge *= 1.0 - 0.85 * blurK;
    vec3 ink = color * 0.32 + vec3(0.025, 0.02, 0.02);
    color = mix(color, ink, edge * outlineStrength);
  }
  gl_FragColor = vec4(grade(color, vUv), source.a);
}`,
  });
  // ShaderPass копирует uniforms (и текстуры вместе с ними) — глубину отдаём ту самую, в которую рисует AO.
  pass.uniforms['tDepth']!.value = depth;
  const update = pass.render.bind(pass);
  // Перед каждым кадром — матрицы камеры и размер (камера двигается, окно меняется).
  pass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
    pass.uniforms['inverseProjection']!.value.copy(camera.projectionMatrixInverse);
    pass.uniforms['projection11']!.value = camera.projectionMatrix.elements[5];
    pass.uniforms['resolution']!.value.set(readBuffer.width, readBuffer.height);
    update(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  };
  return pass;
}
