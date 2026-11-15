// Свои вставки в стандартные шейдеры three.js совместно с каскадными тенями (CSM):
// CSM ставит материалу свой onBeforeCompile — наш вызываем после него. И у каждого вида
// материала свой ключ кэша программ, иначе three возьмёт чужую программу с тем же текстом обёртки.

import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';

export type ShaderHook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

/** Время года для всех материалов сцены: snow — 0 летом, 1 зимой (снег на земле и на всём, что смотрит вверх). */
export const SEASON = { snow: { value: 0 } };

/** Без снега: стёкла, вывески и таблички, машина, трава (зимой её нет), гирлянды. */
const NO_SNOW = /^(village-glass|village-sign|address-plates|car-|grass|garland)/;
const SNOW_COLOR = 'vec3(0.86, 0.89, 0.94)';

/**
 * Снег. Земля — по яркости и насыщенности: зелень и грунт — белые, тёмный серый асфальт — укатанный серый снег.
 * Остальное — по нормали: крыши, верх заборов, лапы елей — белые, стены — как были.
 */
function injectSnow(shader: WebGLProgramParametersWithUniforms, ground: boolean): void {
  shader.uniforms['citiaSnow'] = SEASON.snow;
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float citiaSnow;');
  if (ground && shader.fragmentShader.includes('#include <color_fragment>')) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
if (citiaSnow > 0.0) {
  vec3 c = diffuseColor.rgb;
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  // Серое и тёмное (асфальт) — снег укатан, видно дорогу; остальное — под снегом.
  float cover = mix(0.62, 1.0, smoothstep(0.004, 0.02, sat));
  diffuseColor.rgb = mix(c, ${SNOW_COLOR} * (0.93 + 0.4 * lum), citiaSnow * cover);
}`,
    );
    return;
  }
  if (!shader.fragmentShader.includes('#include <normal_fragment_maps>')) return;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    /* glsl */ `#include <normal_fragment_maps>
if (citiaSnow > 0.0) {
  vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float k = citiaSnow * smoothstep(0.35, 0.75, dot(normal, upView));
  diffuseColor.rgb = mix(diffuseColor.rgb, ${SNOW_COLOR}, k);
}`,
  );
}

export function hookMaterial(material: Material, key: string, hook: ShaderHook | undefined, csm: CSM | undefined): void {
  if (csm) csm.setupMaterial(material);
  const csmHook = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    csmHook(shader, renderer);
    hook?.(shader, renderer);
    if (!NO_SNOW.test(key)) injectSnow(shader, key.startsWith('ground'));
  };
  material.customProgramCacheKey = () => `citia:${key}`;
}
