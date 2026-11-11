// Что слоям и инструментам из первой версии (дома-модели, участки, палисадники, редактор, подложка)
// нужно от сцены. В v2 это даёт Engine (см. engine/editing.ts и engine/village.ts).

import type { Intersection, Object3D, PerspectiveCamera, Raycaster, Scene, Vector3, WebGLRenderer } from 'three';

/** Вызывается каждый кадр; dt — секунды. */
export type Animator = (dt: number) => boolean | void;

export interface CityScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  /** Каскадных теней в v2 нет — материалы v1 работают с обычной картой теней. */
  readonly csm: undefined;
  requestRender(): void;
  addAnimator(animator: Animator): () => void;
  /** Точка земли под курсором (координаты клиента, px). */
  pickGround(clientX: number, clientY: number): Vector3 | undefined;
  pickObject(clientX: number, clientY: number, objects: Object3D[]): Intersection | undefined;
  rayAt(clientX: number, clientY: number): Raycaster;
  flyTo(position: Vector3, target: Vector3, duration?: number): void;
  orbitPosition(target: Vector3, headingDeg: number, pitchDeg: number, distance: number): Vector3;
}
