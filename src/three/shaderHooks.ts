// Свои вставки в стандартные шейдеры three.js совместно с каскадными тенями (CSM):
// CSM ставит материалу свой onBeforeCompile — наш вызываем после него. И у каждого вида
// материала свой ключ кэша программ, иначе three возьмёт чужую программу с тем же текстом обёртки.

import type { Material, WebGLProgramParametersWithUniforms, WebGLRenderer } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';

export type ShaderHook = (shader: WebGLProgramParametersWithUniforms, renderer: WebGLRenderer) => void;

export function hookMaterial(material: Material, key: string, hook: ShaderHook | undefined, csm: CSM | undefined): void {
  if (csm) csm.setupMaterial(material);
  const csmHook = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    csmHook(shader, renderer);
    hook?.(shader, renderer);
  };
  material.customProgramCacheKey = () => `citia:${key}`;
}
