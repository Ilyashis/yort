// Шейдер фасадов: окна с рамами и разным оттенком стёкол (иногда — шторы), цоколь, карниз, тяги,
// витрины и вывески на первых этажах вдоль улиц, у деревенских домов — наличники, ставни и швы брёвен.
// Всё по координатам стены, без текстур. Вставляется в MeshStandardMaterial (свет, тени, отражения).
// Атрибуты вершин: facade = (земля, низ, верх, высота этажа), facadeStyle = (витрины/наличники, тип окон, зерно, крыша).

import { MeshStandardMaterial } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { NIGHT } from './nightUniforms';
import { hookMaterial } from './shaderHooks';

/** Материал стен с окнами (вершины с цветом и атрибутами facade, facadeStyle). */
export function createFacadeMaterial(csm: CSM | undefined): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  hookMaterial(material, 'facade', facadeHook, csm);
  return material;
}

/** Материал скатных крыш (крашеный металл, профнастил). */
export function createRoofMaterial(csm: CSM | undefined): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
  hookMaterial(material, 'roof', undefined, csm);
  return material;
}

/** Окна и детали фасада по координатам стены; цвета — в sRGB. */
export const facadeHook = (shader: { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string }) => {
  shader.uniforms['citiaWindows'] = NIGHT.windows;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
attribute vec4 facade;
attribute vec4 facadeStyle;
varying vec4 vFacade;
varying vec4 vStyle;
varying vec3 vLocal;
varying vec3 vNormalLocal;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vFacade = facade;
vStyle = facadeStyle;
vLocal = vec3(position.x, -position.z, position.y);
vNormalLocal = vec3(normal.x, -normal.z, normal.y);`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
varying vec4 vFacade;
varying vec4 vStyle;
varying vec3 vLocal;
varying vec3 vNormalLocal;
float citiaGlass = 0.0;
vec3 citiaEmissive = vec3(0.0);
uniform float citiaWindows;

float band(float t, float lo, float hi) {
    float x = fract(t);
    float w = max(fwidth(t), 1e-4);
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec3 signColor(float h) { return 0.5 + 0.38 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

vec3 facadeDetails(vec3 baseSrgb) {
    vec3 diffuse = baseSrgb;
    vec3 n = normalize(vNormalLocal);
    float ground = vFacade.x;
    float bottom = vFacade.y;
    float top = vFacade.z;
    float floorHeight = vFacade.w;
    bool hasShops = vStyle.x > 0.5 && vStyle.x < 1.5;
    bool carved = vStyle.x > 1.5;
    float variant = vStyle.y;
    float seed = vStyle.z;

    if (abs(n.z) > 0.5) {
        if (vStyle.w < 0.5) {
            vec3 roof = mix(vec3(0.63, 0.59, 0.54), vec3(0.47, 0.46, 0.45), seed);
            diffuse = mix(diffuse, roof, 0.7);
        }
        return diffuse;
    }
    float h = vLocal.z - ground;
    diffuse *= 1.0 - 0.25 * (1.0 - smoothstep(0.45, 0.55, h - bottom));
    diffuse *= 1.0 - 0.18 * smoothstep(top - 0.55, top - 0.45, h);
    if (floorHeight <= 0.0) return diffuse;

    vec2 tangent = normalize(vec2(-n.y, n.x));
    float along = dot(vLocal.xy, tangent);
    float floors = h / floorHeight;
    bool shopFloor = hasShops && h < floorHeight;

    float bay = 3.0;
    vec4 win = vec4(0.30, 0.76, 0.22, 0.78);
    if (variant > 1.5) { bay = 3.4; win = vec4(0.36, 0.72, 0.10, 0.90); }
    else if (variant > 0.5) { bay = 2.6; win = vec4(0.20, 0.80, 0.30, 0.70); }
    if (shopFloor) { bay = 4.5; win = vec4(0.06, 0.78, 0.06, 0.94); }
    if (carved) { bay = 2.6; win = vec4(0.30, 0.74, 0.34, 0.66); }

    float bays = along / bay;
    float inside = (1.0 - step(top - 0.9, h)) * (shopFloor ? 1.0 : step(bottom + 0.8, h));
    float outer = band(floors, win.x, win.y) * band(bays, win.z, win.w) * inside;
    float inner = band(floors, win.x + 0.035, win.y - 0.035) * band(bays, win.z + 0.03, win.w - 0.03) * inside;
    float tiny = smoothstep(0.2, 0.5, fwidth(floors) + fwidth(bays));

    float cell = hash12(vec2(floor(floors), floor(bays)) + seed * 97.0);
    vec3 glass = mix(vec3(0.10, 0.13, 0.17), vec3(0.22, 0.28, 0.34), cell);
    if (!shopFloor && cell > 0.82) glass = mix(glass, vec3(0.80, 0.72, 0.56), 0.35);
    if (shopFloor) glass = mix(glass, vec3(0.32, 0.35, 0.38), 0.3);
    vec3 frameColor = shopFloor ? vec3(0.17, 0.18, 0.20) : vec3(0.88, 0.87, 0.84);

    if (carved) {
        float woody = step(baseSrgb.b + 0.05, baseSrgb.g) * step(baseSrgb.g + 0.03, baseSrgb.r) * (1.0 - step(0.5, dot(baseSrgb, vec3(0.333))));
        diffuse *= 1.0 - 0.14 * woody * band(h / 0.26, 0.0, 0.14) * (1.0 - tiny);
        float pick = fract(seed * 13.0);
        vec3 shutterColor = pick < 0.3 ? vec3(0.30, 0.46, 0.68) : pick < 0.55 ? vec3(0.30, 0.52, 0.36) : pick < 0.8 ? vec3(0.50, 0.30, 0.19) : vec3(0.56, 0.22, 0.18);
        float rows = band(floors, win.x, win.y) * inside;
        float shutters = (band(bays, win.z - 0.21, win.z - 0.05) + band(bays, win.w + 0.05, win.w + 0.21)) * rows;
        diffuse = mix(diffuse, shutterColor, shutters * (1.0 - tiny));
        frameColor = fract(seed * 7.0) > 0.6 ? vec3(0.62, 0.77, 0.88) : vec3(0.94, 0.93, 0.89);
        outer = band(floors, win.x - 0.05, win.y + 0.1) * band(bays, win.z - 0.05, win.w + 0.05) * inside;
    }

    float glassAmount = mix(inner, 0.2 * inside, tiny);
    diffuse = mix(diffuse, frameColor, clamp(outer - inner, 0.0, 1.0) * (1.0 - tiny));
    diffuse = mix(diffuse, glass, glassAmount);
    float ledge = band(floors, 0.0, 0.05) * inside * (1.0 - tiny) * step(floorHeight, h);
    diffuse *= 1.0 - 0.12 * ledge;
    if (hasShops) {
        float signBand = band(floors, 0.82, 0.96) * (1.0 - step(floorHeight, h));
        float shopCell = hash12(vec2(floor(along / 9.0), seed * 31.0));
        diffuse = mix(diffuse, signColor(shopCell), signBand * step(0.25, shopCell) * (1.0 - tiny));
        // Вечером вывески подсвечены.
        citiaEmissive += toLinear(signColor(shopCell)) * signBand * step(0.25, shopCell) * (1.0 - tiny) * citiaWindows * 0.7;
    }
    // Свет в окнах вечером: у каждого окна своё «время отбоя» — горит часть окон, витрины — почти все.
    float lightPick = hash12(vec2(floor(floors), floor(bays)) + seed * 53.0 + 7.0);
    float lit = step(lightPick, citiaWindows * (shopFloor ? 0.7 : 0.38));
    vec3 lamp = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.8, 0.52), hash12(vec2(floor(bays), floor(floors)) + 3.1));
    if (shopFloor) lamp = vec3(0.95, 0.9, 0.8) * 0.55;
    // Издалека окна мельче пикселя — ровное слабое свечение фасада.
    float glow = lit * inner * (1.0 - tiny) + 0.07 * citiaWindows * inside * tiny;
    citiaEmissive += toLinear(lamp) * glow * 1.5;
    citiaGlass = glassAmount;
    return diffuse;
}`,
    )
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = toLinear(facadeDetails(toSrgb(diffuseColor.rgb)));')
    // Стекло — гладкое: в нём отражается небо.
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, citiaGlass);')
    // Свет в окнах и вывесках — собственное свечение (его не гасят тени и ночь).
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += citiaEmissive;');
};

