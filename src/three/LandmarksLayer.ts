// Памятники: гранитные ступени, цоколь, ствол, карниз, бронзовая доска, статуя (GLB) и подпись
// над ней (видна до 3 км).

import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  type BufferGeometry,
  type Material,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Landmark } from '../config/landmarks';
import { CORNICE, PEDESTAL_COLORS, PEDESTAL_TOP, PLAQUE, PLATFORM_SKIRT, PLINTH, SHAFT, STATUE_TOP, STEPS } from '../world/base/pedestal';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { hookMaterial } from './shaderHooks';

const LABEL_MAX_DISTANCE = 3000;

export class LandmarksLayer {
  readonly group = new Group();
  private readonly labels: Sprite[] = [];
  private readonly removeAnimator: () => void;

  private constructor(private readonly city: CityScene) {
    this.group.name = 'landmarks';
    city.scene.add(this.group);
    // Подписи — только ближе 3 км.
    this.removeAnimator = city.addAnimator(() => {
      for (const label of this.labels) label.visible = label.position.distanceTo(city.camera.position) < LABEL_MAX_DISTANCE;
      return false;
    });
  }

  static async create(
    city: CityScene,
    landmarks: readonly Landmark[],
    frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    csm: CSM,
  ): Promise<LandmarksLayer> {
    const layer = new LandmarksLayer(city);
    const materials = new Map<string, MeshStandardMaterial>();
    const material = (color: string) => {
      let m = materials.get(color);
      if (!m) {
        m = new MeshStandardMaterial({ color, roughness: 0.8 });
        hookMaterial(m, `granite-${color}`, undefined, csm);
        materials.set(color, m);
      }
      return m;
    };
    const loader = new GLTFLoader();

    for (const landmark of landmarks) {
      const [cx, cy] = frame.toLocal(landmark.position);
      // Земля — самая низкая точка под площадкой: на склоне площадка не повиснет.
      let ground = heightAt(cx, cy);
      for (let a = 0; a < 24; a++) {
        const t = (a / 24) * Math.PI * 2;
        ground = Math.min(ground, heightAt(cx + Math.cos(t) * STEPS[0]!.radius, cy + Math.sin(t) * STEPS[0]!.radius));
      }
      const root = new Object3D();
      root.position.set(cx, ground, -cy);
      // Курс от севера по часовой → поворот вокруг вертикали (против часовой — положительный).
      root.rotation.y = -(landmark.heading * Math.PI) / 180;
      layer.group.add(root);
      const add = (geometry: BufferGeometry, mat: Material, x: number, z: number, y: number) => {
        const mesh = new Mesh(geometry, mat);
        mesh.position.set(x, z, -y);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
      };
      let z = 0;
      STEPS.forEach((step, k) => {
        const skirt = k === 0 ? PLATFORM_SKIRT : 0;
        add(new CylinderGeometry(step.radius, step.radius, step.height + skirt, 48), material(k === 0 ? PEDESTAL_COLORS.graniteLight : PEDESTAL_COLORS.granite), 0, z + (step.height - skirt) / 2, 0);
        z += step.height;
      });
      const box = (size: { width: number; length: number; height: number }, color: string) => {
        add(new BoxGeometry(size.width, size.height, size.length), material(color), 0, z + size.height / 2, 0);
        z += size.height;
      };
      box(PLINTH, PEDESTAL_COLORS.granite);
      const shaftBottom = z;
      box(SHAFT, PEDESTAL_COLORS.graniteDark);
      add(new BoxGeometry(PLAQUE.width, PLAQUE.height, PLAQUE.depth * 2), material(PEDESTAL_COLORS.bronze), 0, shaftBottom + SHAFT.height * 0.55, SHAFT.length / 2);
      box(CORNICE, PEDESTAL_COLORS.granite);

      if (landmark.model) {
        try {
          const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}${landmark.model}`);
          gltf.scene.position.set(0, PEDESTAL_TOP, 0);
          gltf.scene.traverse((object) => {
            const mesh = object as Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            hookMaterial(mesh.material as MeshStandardMaterial, 'bronze', undefined, csm);
          });
          root.add(gltf.scene);
        } catch (error) {
          console.warn('[landmarks] статуя не загрузилась', error);
        }
      }

      const label = makeLabel(landmark.name);
      label.position.set(cx, ground + STATUE_TOP + 3, -cy);
      layer.labels.push(label);
      layer.group.add(label);
    }
    city.requestRender();
    return layer;
  }

  destroy(): void {
    this.removeAnimator();
    this.city.scene.remove(this.group);
  }
}

/** Подпись: светлый текст на тёмной плашке, всегда к камере и одного размера на экране. */
function makeLabel(text: string): Sprite {
  const scale = 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `600 ${15 * scale}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 16 * scale;
  const height = 28 * scale;
  canvas.width = width;
  canvas.height = height;
  ctx.font = font;
  ctx.fillStyle = 'rgba(18, 22, 30, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 6 * scale);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8 * scale, height / 2 + scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true, toneMapped: false, fog: false }));
  // Размер на экране: доли высоты кадра (sizeAttenuation: false).
  const h = 0.045;
  sprite.scale.set((h * width) / height, h, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 10;
  return sprite;
}
