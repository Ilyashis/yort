// Снегопад зимой: снежинки в коробке вокруг камеры падают и сносятся ветром; вышедшие за коробку возвращаются
// с другой стороны (коробка едет за камерой). Высоко над деревней снегопада не видно — выключается.

import { BufferAttribute, BufferGeometry, CanvasTexture, Points, PointsMaterial, SRGBColorSpace } from 'three';
import type { CityScene } from './CityScene';

/** Коробка вокруг камеры, м: по горизонтали и по вертикали. */
const BOX = 140;
const HEIGHT = 70;
const COUNT = 9000;
/** Выше этого над землёй снегопад не показываем, м. */
const MAX_ALTITUDE = 450;

function flakeTexture(): CanvasTexture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class SnowfallLayer {
  private readonly points: Points<BufferGeometry, PointsMaterial>;
  /** Смещения снежинок внутри коробки и их скорости падения. */
  private readonly offsets: Float32Array;
  private readonly speeds: Float32Array;
  private readonly removeAnimator: () => void;
  private enabled = false;
  private t = 0;

  constructor(
    private readonly city: CityScene,
    private readonly groundAt: (x: number, z: number) => number,
  ) {
    this.offsets = new Float32Array(COUNT * 3);
    this.speeds = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      this.offsets[i * 3] = (Math.random() - 0.5) * BOX;
      this.offsets[i * 3 + 1] = Math.random() * HEIGHT;
      this.offsets[i * 3 + 2] = (Math.random() - 0.5) * BOX;
      this.speeds[i] = 0.9 + Math.random() * 0.8;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(COUNT * 3), 3));
    this.points = new Points(
      geometry,
      new PointsMaterial({ size: 0.16, map: flakeTexture(), transparent: true, depthWrite: false, color: '#ffffff', fog: true }),
    );
    this.points.name = 'snowfall';
    this.points.frustumCulled = false;
    this.points.visible = false;
    city.scene.add(this.points);
    this.removeAnimator = city.addAnimator((dt) => this.step(dt));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.points.visible = on;
    this.city.requestRender();
  }

  private step(dt: number): boolean {
    if (!this.enabled) return false;
    const camera = this.city.camera.position;
    const altitude = camera.y - this.groundAt(camera.x, camera.z);
    this.points.visible = altitude < MAX_ALTITUDE;
    if (!this.points.visible) return false;
    this.t += dt;
    const position = this.points.geometry.getAttribute('position') as BufferAttribute;
    const array = position.array as Float32Array;
    const o = this.offsets;
    const base = camera.y - HEIGHT * 0.6;
    for (let i = 0; i < COUNT; i++) {
      const k = i * 3;
      // Падают и сносятся ветром (у каждой снежинки свой узор раскачивания).
      o[k + 1]! -= this.speeds[i]! * dt;
      o[k]! += (0.6 + Math.sin(this.t * 0.7 + i) * 0.5) * dt;
      o[k + 2]! += Math.cos(this.t * 0.5 + i * 1.3) * 0.35 * dt;
      if (o[k + 1]! < 0) o[k + 1]! += HEIGHT;
      // Коробка — вокруг камеры: снежинка, ушедшая за край, входит с другой стороны.
      const x = wrap(o[k]! + 0 - ((camera.x % BOX) + BOX) % BOX, BOX);
      const z = wrap(o[k + 2]! - ((camera.z % BOX) + BOX) % BOX, BOX);
      array[k] = camera.x + x;
      array[k + 1] = base + o[k + 1]!;
      array[k + 2] = camera.z + z;
    }
    position.needsUpdate = true;
    return true;
  }

  destroy(): void {
    this.removeAnimator();
    this.city.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.map?.dispose();
    this.points.material.dispose();
  }
}

/** В пределах [−size/2, size/2). */
function wrap(v: number, size: number): number {
  return ((((v + size / 2) % size) + size) % size) - size / 2;
}
