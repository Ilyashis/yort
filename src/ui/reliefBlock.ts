// Блок-модель рельефа для окна «Рельеф»: кусок земли «кубом» со срезанными боками, раскрашенный по
// высоте, с горизонталями. Своя маленькая сцена three.js на отдельном холсте; вращается мышью.

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { P2 } from '../core/geo';

export interface BlockData {
  /** Центр куска (мир) и сторона, м. */
  x: number;
  z: number;
  size: number;
  /** Высота земли в точке мира, м. */
  heightAt: (x: number, z: number) => number;
  /** Сколько прибавить к высоте, чтобы получить метры над уровнем моря (для подписей). */
  origin: number;
  /** Контуры домов: у каждого первое кольцо — внешнее. */
  buildings: readonly P2[][][];
  roads: readonly { pts: readonly P2[]; width: number }[];
}

export interface BlockMarks {
  spots: readonly { id: string; x: number; z: number; radius: number }[];
  /** Области правок: круг, у плоскости с уклоном — стрелка вверх по склону (° от севера). */
  areas?: readonly { id: string; x: number; z: number; radius: number; uphill?: number }[];
  /** Сдвиг горизонтали, который сейчас тянут мышью: откуда и куда. */
  pull?: readonly [P2, P2];
  selected?: string;
  section?: readonly [P2, P2?];
}

/** Узлов по стороне. */
const N = 121;

/** Цвет по относительной высоте: низины зелёные, выше — охра, верх — светлый. */
const TINT = /* glsl */ `
vec3 tint(float t) {
  vec3 a = vec3(0.16, 0.36, 0.3), b = vec3(0.38, 0.52, 0.24), c = vec3(0.72, 0.64, 0.36), d = vec3(0.86, 0.8, 0.7);
  return t < 0.33 ? mix(a, b, t / 0.33) : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33) : mix(c, d, (t - 0.66) / 0.34);
}`;

export class ReliefBlock {
  /** Самая низкая и самая высокая точка куска, м. */
  min = 0;
  max = 0;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(32, 1, 1, 5000);
  private readonly block = new Group();
  private readonly marks = new Group();
  /** Подписи горизонталей и метка севера: не растягиваются вместе с высотами. */
  private readonly labels = new Group();
  private heights?: Float32Array;
  /** Тянуть по блоку — не вращать его, а вести линию (сдвиг горизонтали). */
  lineDrag = false;
  private readonly uniforms = { uRange: { value: new Vector2(0, 1) }, uStep: { value: 0.5 } };
  private readonly material: MeshStandardMaterial;
  private top?: Mesh;
  private data?: BlockData;
  private yaw = 0.7;
  private pitch = 0.62;
  private zoom = 1;
  private exaggeration = 3;
  private frame = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: {
      onPick: (x: number, z: number) => void;
      onHover: (point: { x: number; z: number; height: number } | undefined) => void;
      /** Линию ведут по блоку: from → to; done — кнопку отпустили. */
      onLine?: (from: P2, to: P2, done: boolean) => void;
    },
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.add(new AmbientLight(0xffffff, 1.1));
    const sun = new DirectionalLight(0xffffff, 2.4);
    sun.position.set(-0.6, 1, 0.45);
    this.scene.add(sun, this.block, this.labels);
    this.block.add(this.marks);

    this.material = new MeshStandardMaterial({ roughness: 0.95, metalness: 0, side: DoubleSide });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aInfo;\nvarying vec2 vInfo;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInfo = aInfo;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vInfo;\nuniform vec2 uRange;\nuniform float uStep;\n${TINT}`)
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          {
            // vInfo: высота точки в метрах и признак бока (1 — срез земли).
            float h = vInfo.x;
            vec3 col = tint(clamp((h - uRange.x) / max(uRange.y - uRange.x, 0.01), 0.0, 1.0));
            col = mix(col, vec3(0.34, 0.27, 0.2) * (0.75 + 0.25 * col.g), vInfo.y * 0.8);
            float f = h / uStep;
            float w = fwidth(f);
            float line = 1.0 - smoothstep(w * 0.6, w * 1.6, abs(fract(f - 0.5) - 0.5));
            float f5 = f / 5.0;
            float major = 1.0 - smoothstep(w * 0.24, w * 0.5, abs(fract(f5 - 0.5) - 0.5));
            // Когда горизонтали сливаются (кусок большой, шаг мелкий) — гасим их, оставляя каждую пятую.
            float fade = 1.0 - smoothstep(0.25, 0.6, w);
            col = mix(col, vec3(0.08, 0.07, 0.05), max(line * 0.5 * fade, major * 0.75 * (1.0 - smoothstep(0.1, 0.2, w / 5.0))));
            diffuseColor.rgb = col;
          }`,
        );
    };

    const dom = canvas;
    let drag: { x: number; y: number; moved: number; from?: P2; to?: P2 } | undefined;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      // Линию ведём левой кнопкой; с Shift или правой кнопкой блок по-прежнему вращается.
      if (this.lineDrag && e.button === 0 && !e.shiftKey) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) drag.from = [hit.x, hit.z];
      }
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag?.from) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) {
          drag.to = [hit.x, hit.z];
          this.events.onLine?.(drag.from, drag.to, false);
          this.events.onHover({ ...hit, height: this.data!.heightAt(hit.x, hit.z) });
        }
        return;
      }
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.moved > 4) {
          this.yaw -= dx * 0.008;
          this.pitch = Math.min(1.5, Math.max(0.08, this.pitch + dy * 0.006));
          this.render();
        }
        return;
      }
      const hit = this.pick(e.clientX, e.clientY);
      this.events.onHover(hit && { ...hit, height: this.data!.heightAt(hit.x, hit.z) });
    };
    const up = (e: PointerEvent) => {
      if (drag?.from) {
        const { from, to } = drag;
        drag = undefined;
        if (to && Math.hypot(to[0] - from[0], to[1] - from[1]) > 0.5) this.events.onLine?.(from, to, true);
        return;
      }
      const click = drag && drag.moved <= 4;
      drag = undefined;
      if (!click) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.events.onPick(hit.x, hit.z);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.zoom = Math.min(3, Math.max(0.5, this.zoom * Math.exp(-e.deltaY * 0.0012)));
      this.render();
    };
    const leave = () => this.events.onHover(undefined);
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointerleave', leave);
    dom.addEventListener('wheel', wheel, { passive: false });
    const menu = (e: Event) => e.preventDefault();
    dom.addEventListener('contextmenu', menu);
    const observer = new ResizeObserver(() => this.render());
    observer.observe(dom);
    this.cleanup.push(() => {
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointerleave', leave);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('contextmenu', menu);
      observer.disconnect();
    });
  }

  /** Новый кусок земли или новые высоты того же куска. */
  setData(data: BlockData): void {
    this.data = data;
    for (const child of [...this.block.children]) {
      if (child === this.marks) continue;
      this.block.remove(child);
      (child as Mesh).geometry?.dispose();
    }
    const { size, heightAt } = data;
    const cell = size / (N - 1);
    const heights = new Float32Array(N * N);
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h = heightAt(data.x - size / 2 + i * cell, data.z - size / 2 + j * cell);
        heights[j * N + i] = h;
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    }
    this.min = min;
    this.max = max;
    this.heights = heights;
    this.uniforms.uRange.value.set(min, max);
    // Подошва блока — ниже самой низкой точки на шестую часть перепада, но не тоньше метра.
    const floor = min - Math.max(1, (max - min) / 6);
    const local = (i: number, j: number, h: number) => [-size / 2 + i * cell, h - min, -size / 2 + j * cell];

    const pos: number[] = [], info: number[] = [], index: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      pos.push(...local(i, j, heights[j * N + i]));
      info.push(heights[j * N + i], 0);
    }
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
    const topGeometry = new BufferGeometry();
    topGeometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    topGeometry.setAttribute('aInfo', new BufferAttribute(new Float32Array(info), 2));
    topGeometry.setIndex(index);
    topGeometry.computeVertexNormals();
    this.top = new Mesh(topGeometry, this.material);
    this.block.add(this.top);

    // Бока: срез земли от поверхности до подошвы — по нему виден профиль склона.
    const side: number[] = [], sideInfo: number[] = [];
    const wall = (cells: [number, number][]) => {
      for (let k = 0; k + 1 < cells.length; k++) {
        const [i0, j0] = cells[k], [i1, j1] = cells[k + 1];
        const h0 = heights[j0 * N + i0], h1 = heights[j1 * N + i1];
        const a = local(i0, j0, h0), b = local(i1, j1, h1), a0 = local(i0, j0, floor), b0 = local(i1, j1, floor);
        side.push(...a, ...a0, ...b, ...b, ...a0, ...b0);
        sideInfo.push(h0, 1, floor, 1, h1, 1, h1, 1, floor, 1, floor, 1);
      }
    };
    const run = Array.from({ length: N }, (_, k) => k);
    wall(run.map((i): [number, number] => [i, 0]));
    wall(run.map((i): [number, number] => [i, N - 1]));
    wall(run.map((j): [number, number] => [0, j]));
    wall(run.map((j): [number, number] => [N - 1, j]));
    const sideGeometry = new BufferGeometry();
    sideGeometry.setAttribute('position', new BufferAttribute(new Float32Array(side), 3));
    sideGeometry.setAttribute('aInfo', new BufferAttribute(new Float32Array(sideInfo), 2));
    sideGeometry.computeVertexNormals();
    this.block.add(new Mesh(sideGeometry, this.material));

    // Дома — простыми объёмами, дороги — линиями по земле: чтобы узнавать место.
    const half = size / 2;
    const inside = (x: number, z: number) => Math.abs(x - data.x) <= half && Math.abs(z - data.z) <= half;
    const houseMaterial = new MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.8 });
    for (const rings of data.buildings) {
      const ring = rings[0];
      if (!ring || ring.length < 3 || !ring.every(([x, z]) => inside(x, z))) continue;
      const shape = new Shape(ring.map(([x, z]) => new Vector2(x - data.x, -(z - data.z))));
      const base = Math.min(...ring.map(([x, z]) => heightAt(x, z)));
      const geometry = new ExtrudeGeometry(shape, { depth: 3.2, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, base - min, 0);
      this.block.add(new Mesh(geometry, houseMaterial));
    }
    const roadPoints: number[] = [];
    for (const road of data.roads) {
      for (let k = 0; k + 1 < road.pts.length; k++) {
        const [ax, az] = road.pts[k], [bx, bz] = road.pts[k + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cell * 1.5)));
        for (let m = 0; m < steps; m++) {
          const p: P2 = [ax + ((bx - ax) * m) / steps, az + ((bz - az) * m) / steps];
          const q: P2 = [ax + ((bx - ax) * (m + 1)) / steps, az + ((bz - az) * (m + 1)) / steps];
          if (!inside(p[0], p[1]) || !inside(q[0], q[1])) continue;
          roadPoints.push(p[0] - data.x, heightAt(p[0], p[1]) - min + 0.12, p[1] - data.z, q[0] - data.x, heightAt(q[0], q[1]) - min + 0.12, q[1] - data.z);
        }
      }
    }
    if (roadPoints.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(roadPoints), 3));
      this.block.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })));
    }
    this.label();
    this.render();
  }

  /** Отметки и линия разреза поверх блока. */
  setMarks(marks: BlockMarks): void {
    const data = this.data;
    if (!data) return;
    for (const child of [...this.marks.children]) {
      this.marks.remove(child);
      (child as Mesh).geometry?.dispose();
    }
    const y = (x: number, z: number) => data.heightAt(x, z) - this.min;
    const dot = (x: number, z: number, colour: number, r: number) => {
      const mesh = new Mesh(new SphereGeometry(r, 16, 10), new MeshStandardMaterial({ color: colour, roughness: 0.5, emissive: new Color(colour), emissiveIntensity: 0.35 }));
      mesh.position.set(x - data.x, y(x, z), z - data.z);
      mesh.userData.round = true;
      this.marks.add(mesh);
    };
    const r = data.size / 70;
    for (const spot of marks.spots) {
      dot(spot.x, spot.z, spot.id === marks.selected ? 0xffc857 : 0xf4f4f4, spot.id === marks.selected ? r * 1.35 : r);
      // Круг — докуда отметка меняет землю.
      const ring: number[] = [];
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2, x = spot.x + Math.cos(a) * spot.radius, z = spot.z + Math.sin(a) * spot.radius;
        if (Math.abs(x - data.x) > data.size / 2 || Math.abs(z - data.z) > data.size / 2) continue;
        ring.push(x - data.x, y(x, z) + 0.1, z - data.z);
      }
      if (ring.length >= 6) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(ring), 3));
        this.marks.add(new Line(geometry, new LineBasicMaterial({ color: spot.id === marks.selected ? 0xffc857 : 0xffffff, transparent: true, opacity: 0.55 })));
      }
    }
    const circle = (x0: number, z0: number, radius: number, colour: number, opacity: number) => {
      const ring: number[] = [];
      for (let k = 0; k <= 56; k++) {
        const a = (k / 56) * Math.PI * 2, x = x0 + Math.cos(a) * radius, z = z0 + Math.sin(a) * radius;
        if (Math.abs(x - data.x) > data.size / 2 || Math.abs(z - data.z) > data.size / 2) continue;
        ring.push(x - data.x, y(x, z) + 0.12, z - data.z);
      }
      if (ring.length < 6) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(ring), 3));
      this.marks.add(new Line(geometry, new LineBasicMaterial({ color: colour, transparent: true, opacity })));
    };
    const stroke = (from: P2, to: P2, colour: number) => {
      const line: number[] = [];
      for (let k = 0; k <= 40; k++) {
        const x = from[0] + ((to[0] - from[0]) * k) / 40, z = from[1] + ((to[1] - from[1]) * k) / 40;
        line.push(x - data.x, y(x, z) + 0.15, z - data.z);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(line), 3));
      this.marks.add(new Line(geometry, new LineBasicMaterial({ color: colour })));
    };
    for (const area of marks.areas ?? []) {
      const on = area.id === marks.selected;
      const colour = on ? 0xffc857 : 0x7fd4ff;
      dot(area.x, area.z, colour, on ? r : r * 0.7);
      circle(area.x, area.z, area.radius, colour, on ? 0.95 : 0.6);
      if (area.uphill !== undefined) {
        const b = (area.uphill * Math.PI) / 180;
        stroke([area.x, area.z], [area.x + Math.sin(b) * area.radius * 0.85, area.z - Math.cos(b) * area.radius * 0.85], colour);
      }
    }
    if (marks.pull) {
      dot(marks.pull[0][0], marks.pull[0][1], 0xff5a4f, r * 0.7);
      dot(marks.pull[1][0], marks.pull[1][1], 0xffc857, r);
      stroke(marks.pull[0], marks.pull[1], 0xffc857);
    }
    const [a, b] = marks.section ?? [];
    if (a) dot(a[0], a[1], 0xff5a4f, r);
    if (a && b) {
      dot(b[0], b[1], 0xff5a4f, r);
      const line: number[] = [];
      for (let k = 0; k <= 80; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / 80, z = a[1] + ((b[1] - a[1]) * k) / 80;
        line.push(x - data.x, y(x, z) + 0.15, z - data.z);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(line), 3));
      this.marks.add(new Line(geometry, new LineBasicMaterial({ color: 0xff5a4f })));
    }
    this.render();
  }

  setExaggeration(value: number): void {
    this.exaggeration = value;
    this.render();
  }

  setContourStep(step: number): void {
    this.uniforms.uStep.value = step;
    this.label();
    this.render();
  }

  /** Куда на земле смотрят «вправо» и «от себя» на экране — чтобы двигать кусок стрелками. */
  heading(): { right: P2; away: P2 } {
    return { right: [Math.cos(this.yaw), -Math.sin(this.yaw)], away: [-Math.sin(this.yaw), -Math.cos(this.yaw)] };
  }

  private sprite(text: string, colour: string, width: number): Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 38px Inter, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(12, 14, 18, 0.85)';
    ctx.strokeText(text, 96, 34);
    ctx.fillStyle = colour;
    ctx.fillText(text, 96, 34);
    const sprite = new Sprite(new SpriteMaterial({ map: new CanvasTexture(canvas), depthTest: false, transparent: true }));
    sprite.scale.set(width, width / 3, 1);
    sprite.renderOrder = 5;
    return sprite;
  }

  /** Подписи высот на утолщённых горизонталях (каждой пятой) и метка севера. */
  private label(): void {
    const data = this.data, heights = this.heights;
    if (!data || !heights) return;
    for (const child of [...this.labels.children]) {
      this.labels.remove(child);
      const material = (child as Sprite).material;
      material.map?.dispose();
      material.dispose();
    }
    const { size } = data;
    const cell = size / (N - 1);
    const major = this.uniforms.uStep.value * 5;
    const digits = major % 1 === 0 ? 0 : major * 10 % 1 === 0 ? 1 : 2;
    const placed: [number, number][] = [];
    // Идём по трём линиям через блок и подписываем горизонталь там, где линия её пересекает.
    for (const j of [Math.round(N * 0.25), Math.round(N * 0.5), Math.round(N * 0.75)]) {
      for (let i = 2; i < N - 3 && placed.length < 18; i++) {
        const h0 = heights[j * N + i], h1 = heights[j * N + i + 1];
        const level = Math.ceil(Math.min(h0 + data.origin, h1 + data.origin) / major) * major;
        if (level > Math.max(h0 + data.origin, h1 + data.origin) || h0 === h1) continue;
        const x = -size / 2 + (i + (level - data.origin - h0) / (h1 - h0)) * cell, z = -size / 2 + j * cell;
        if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < size / 6)) continue;
        placed.push([x, z]);
        const sprite = this.sprite(level.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }), '#f3ead2', size / 7);
        sprite.position.set(x, 0, z);
        sprite.userData.h = level - data.origin - this.min;
        this.labels.add(sprite);
      }
    }
    const north = this.sprite('С ↑', '#ffc857', size / 8);
    north.position.set(0, 0, -size / 2 - size / 16);
    north.userData.h = heights[Math.floor(N / 2)] - this.min;
    this.labels.add(north);
  }

  /** Точка земли под указателем (мир). */
  private pick(clientX: number, clientY: number): { x: number; z: number } | undefined {
    if (!this.top || !this.data) return undefined;
    const box = this.canvas.getBoundingClientRect();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1), this.camera);
    const hit = ray.intersectObject(this.top, false)[0];
    if (!hit) return undefined;
    const p = this.block.worldToLocal(hit.point.clone());
    return { x: p.x + this.data.x, z: p.z + this.data.z };
  }

  /** Перерисовать на следующем кадре. */
  render(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const data = this.data;
      if (!data) return;
      const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.block.scale.set(1, this.exaggeration, 1);
      // Отметки остаются круглыми при любом преувеличении высот.
      for (const child of this.marks.children) if (child.userData.round) child.scale.set(1, 1 / this.exaggeration, 1);
      for (const child of this.labels.children) child.position.y = child.userData.h * this.exaggeration + data.size / 60;
      const tall = (this.max - this.min) * this.exaggeration;
      // Кадр — по всему блоку: высокий склон отодвигает камеру, чтобы блок не вылезал из окна.
      const extent = Math.hypot(data.size, tall * 1.25);
      const distance = (extent * 1.9) / this.zoom / Math.min(1, this.camera.aspect * 0.75);
      // Смотрим чуть ниже середины блока: внизу окна лежит подсказка.
      const target = new Vector3(0, tall * 0.4 - extent * 0.07, 0);
      this.camera.position.set(
        target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * distance,
        target.y + Math.sin(this.pitch) * distance,
        target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * distance,
      );
      this.camera.near = distance / 50;
      this.camera.far = distance * 6;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(target);
      this.renderer.render(this.scene, this.camera);
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.cleanup.forEach((fn) => fn());
    this.block.traverse((o) => (o as Mesh).geometry?.dispose());
    for (const child of this.labels.children) (child as Sprite).material.map?.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
