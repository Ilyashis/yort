// Правка рельефа прямо на сцене: горизонтали поверх земли и всего, что на ней стоит, опорные отметки
// высот (щелчок по земле) и сдвиг горизонтали мышью. Отметки — те же, что в окне «Рельеф» (edits.spots).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import type { World } from '../core/data';
import { useStore } from '../state/store';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { SPOT_RADIUS, upsertSpot } from '../world/edit/edits';
import type { HeightMap } from './terrain';

export interface ContourDeps {
  world: World;
  hm: HeightMap;
  /** Группа сеток рельефа: поверх них рисуются линии (геометрия общая — правки рельефа видны сразу). */
  terrain: Group;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  overview: { setEnabled: (enabled: boolean) => void };
  /** Точка земли под указателем (координаты окна). */
  pickGround: (clientX: number, clientY: number) => Vector3 | undefined;
}

/** Ближе стольких пикселей к линии нажатие берёт горизонталь, а не двигает карту. */
const GRAB_PX = 7;
const SPOT_PX = 14;

const format = (v: number, digits: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function dotTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.beginPath();
  ctx.arc(32, 32, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#1b1f27';
  ctx.stroke();
  return new CanvasTexture(c);
}

export function createContours(d: ContourDeps): { group: Group; update: () => void; dispose: () => void } {
  const { hm, world, camera, canvas } = d;
  const group = new Group();
  group.name = 'contours';
  group.visible = false;
  const uniforms = { uStep: { value: useStore.getState().contourStep }, uOrigin: { value: hm.origin } };
  // Линии — вторым проходом по тем же сеткам рельефа, без проверки глубины: видны сквозь дома и деревья.
  const lines = new ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying float vH;
      void main() {
        vH = position.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uStep, uOrigin;
      varying float vH;
      void main() {
        float f = (vH + uOrigin) / uStep;
        float w = fwidth(f);
        float thin = (1.0 - smoothstep(w * 0.6, w * 1.4, abs(fract(f - 0.5) - 0.5))) * (1.0 - smoothstep(0.3, 0.7, w));
        float f5 = f / 5.0;
        float w5 = fwidth(f5);
        float d5 = abs(fract(f5 - 0.5) - 0.5);
        float keep = 1.0 - smoothstep(0.3, 0.7, w5);
        float bold = (1.0 - smoothstep(w5 * 1.3, w5 * 2.2, d5)) * keep;
        // Светлая кайма у жирных линий — чтобы читались и на тёмном лесу, и на крышах.
        float halo = (1.0 - smoothstep(w5 * 2.2, w5 * 4.2, d5)) * keep;
        float dark = max(thin * 0.6, bold);
        float alpha = max(dark, halo * 0.55);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.2, 0.1, 0.02), dark / alpha), alpha);
      }`,
  });
  for (const child of d.terrain.children) {
    if (!(child as Mesh).isMesh) continue;
    const mesh = new Mesh((child as Mesh).geometry, lines);
    mesh.renderOrder = 20;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // Отметки: точки поверх всего, выбранная — крупнее и с кругом своего радиуса.
  const dot = dotTexture();
  const spotGeometry = new BufferGeometry();
  const spotMaterial = new PointsMaterial({ map: dot, size: 16, sizeAttenuation: false, transparent: true, depthTest: false, vertexColors: true });
  const spotPoints = new Points(spotGeometry, spotMaterial);
  spotPoints.renderOrder = 22;
  spotPoints.frustumCulled = false;
  const ringMaterial = new LineBasicMaterial({ color: 0xffc857, transparent: true, depthTest: false });
  const ring = new Line(new BufferGeometry(), ringMaterial);
  ring.renderOrder = 21;
  ring.frustumCulled = false;
  const pull = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0xffc857, transparent: true, depthTest: false }));
  pull.renderOrder = 23;
  pull.frustumCulled = false;
  pull.visible = false;
  group.add(spotPoints, ring, pull);

  const spots = () => (useEditStore.getState().edits.spots ?? []).map((spot) => ({ spot, xz: world.frame.xz(spot.at[0], spot.at[1]) }));
  const drawSpots = () => {
    const list = spots();
    const selected = useStore.getState().contourSpot;
    const pos = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3);
    list.forEach(({ spot, xz }, i) => {
      pos.set([xz[0], hm.at(xz[0], xz[1]), xz[1]], i * 3);
      col.set(spot.id === selected ? [1, 0.78, 0.34] : [1, 1, 1], i * 3);
    });
    spotGeometry.setAttribute('position', new BufferAttribute(pos, 3));
    spotGeometry.setAttribute('color', new BufferAttribute(col, 3));
    const chosen = list.find(({ spot }) => spot.id === selected);
    ring.visible = !!chosen;
    if (chosen) {
      const pts: number[] = [];
      for (let k = 0; k <= 72; k++) {
        const a = (k / 72) * Math.PI * 2, x = chosen.xz[0] + Math.cos(a) * chosen.spot.radius, z = chosen.xz[1] + Math.sin(a) * chosen.spot.radius;
        pts.push(x, hm.at(x, z), z);
      }
      ring.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    }
  };

  const active = () => {
    const s = useStore.getState();
    return s.contours && s.mode === 'overview' && !s.relief && !useEditStore.getState().tool && !useUnderlayStore.getState().mode;
  };
  const rect = () => canvas.getBoundingClientRect();
  const v = new Vector3();
  /** Точка мира → координаты окна; undefined — за камерой. */
  const screen = (x: number, y: number, z: number): [number, number] | undefined => {
    v.set(x, y, z).project(camera);
    if (v.z < -1 || v.z > 1) return undefined;
    const r = rect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };
  const sea = (x: number, z: number) => hm.at(x, z) + hm.origin;
  /** Метров земли в одном пикселе экрана возле точки. */
  const metresPerPixel = (p: Vector3) => (2 * camera.position.distanceTo(p) * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, canvas.clientHeight);
  /** Указатель рядом с линией горизонтали? */
  const nearLine = (p: Vector3): boolean => {
    const step = uniforms.uStep.value, h = sea(p.x, p.z);
    const off = Math.abs(h - Math.round(h / step) * step);
    const slope = Math.hypot(sea(p.x + 0.75, p.z) - sea(p.x - 0.75, p.z), sea(p.x, p.z + 0.75) - sea(p.x, p.z - 0.75)) / 1.5;
    return slope > 0.004 && off / slope / metresPerPixel(p) < GRAB_PX;
  };
  const spotAt = (clientX: number, clientY: number) => {
    let best: { id: string; distance: number } | undefined;
    for (const { spot, xz } of spots()) {
      const at = screen(xz[0], hm.at(xz[0], xz[1]), xz[1]);
      const distance = at ? Math.hypot(at[0] - clientX, at[1] - clientY) : Infinity;
      if (distance < SPOT_PX && (!best || distance < best.distance)) best = { id: spot.id, distance };
    }
    return best?.id;
  };
  const newSpot = (x: number, z: number, height: number, radius: number) => {
    const id = `spot/${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const store = useEditStore.getState();
    store.commit(upsertSpot(store.edits, { id, at: [world.frame.lon(x), world.frame.lat(z)], height, radius }));
    useStore.getState().set({ contourSpot: id });
  };

  let press: { x: number; y: number; moved: number; start?: Vector3; grab: boolean; last?: Vector3 } | undefined;
  let hoverCursor = false;
  const abort = new AbortController();
  const listen = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, handler: (e: HTMLElementEventMap[K]) => void) =>
    target.addEventListener(type, handler as EventListener, { signal: abort.signal });

  listen(canvas, 'pointerdown', (e) => {
    if (!active() || e.button !== 0 || e.shiftKey) return;
    const start = d.pickGround(e.clientX, e.clientY);
    const grab = !!start && !spotAt(e.clientX, e.clientY) && nearLine(start);
    press = { x: e.clientX, y: e.clientY, moved: 0, start, grab };
    // Взяли горизонталь — карта не едет, пока кнопку не отпустят.
    if (grab) d.overview.setEnabled(false);
  });
  listen(canvas, 'pointermove', (e) => {
    if (!active()) {
      if (hoverCursor) canvas.style.cursor = '';
      hoverCursor = false;
      return;
    }
    const p = d.pickGround(e.clientX, e.clientY);
    const store = useStore.getState();
    const hover = p ? { x: e.clientX, y: e.clientY, height: Math.round(sea(p.x, p.z) * 20) / 20 } : null;
    if (hover?.height !== store.contourHover?.height || hover?.x !== store.contourHover?.x || hover?.y !== store.contourHover?.y) store.set({ contourHover: hover });
    if (press) {
      press.moved += Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y);
      press.x = e.clientX;
      press.y = e.clientY;
      if (press.grab && press.start && p) {
        press.last = p;
        const pts: number[] = [];
        for (let k = 0; k <= 24; k++) {
          const x = press.start.x + ((p.x - press.start.x) * k) / 24, z = press.start.z + ((p.z - press.start.z) * k) / 24;
          pts.push(x, hm.at(x, z), z);
        }
        pull.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
        pull.visible = true;
      }
      return;
    }
    const cursor = p ? (spotAt(e.clientX, e.clientY) ? 'pointer' : nearLine(p) ? 'grab' : 'crosshair') : '';
    canvas.style.cursor = cursor;
    hoverCursor = !!cursor;
  });
  listen(window, 'pointerup', (e) => {
    const done = press;
    press = undefined;
    if (!done) return;
    pull.visible = false;
    if (done.grab) d.overview.setEnabled(true);
    if (!active() || e.button !== 0) return;
    if (done.grab && done.start && done.last && done.moved > 5) {
      // Горизонталь, взятая в start, теперь проходит через точку, где отпустили.
      const reach = Math.hypot(done.last.x - done.start.x, done.last.z - done.start.z);
      newSpot(done.last.x, done.last.z, sea(done.start.x, done.start.z), Math.min(SPOT_RADIUS.max, Math.max(6, Math.round(reach * 1.25))));
    } else if (done.moved <= 5) {
      const id = spotAt(e.clientX, e.clientY);
      if (id) useStore.getState().set({ contourSpot: id });
      else if (done.start) newSpot(done.start.x, done.start.z, sea(done.start.x, done.start.z), SPOT_RADIUS.initial);
    }
  });
  listen(canvas, 'pointerleave', () => useStore.getState().set({ contourHover: null }));

  // Подписи высот у жирных горизонталей и у отметок — обычным текстом поверх сцены; пересчитываются,
  // когда камера остановилась.
  let pose = '';
  let movedAt = 0;
  let stale = true;
  const label = () => {
    const r = rect();
    const major = uniforms.uStep.value * 5;
    const digits = major % 1 === 0 ? 0 : (major * 10) % 1 === 0 ? 1 : 2;
    const out: { x: number; y: number; text: string; spot?: boolean }[] = [];
    for (const row of [0.22, 0.4, 0.58, 0.76]) {
      let prev: { x: number; h: number } | undefined;
      for (let k = 0; k <= 56; k++) {
        const x = r.left + (r.width * (k + 0.5)) / 57, y = r.top + r.height * row;
        const p = d.pickGround(x, y);
        const cur = p && { x, h: sea(p.x, p.z) };
        if (cur && prev && cur.h !== prev.h) {
          const level = Math.ceil(Math.min(cur.h, prev.h) / major) * major;
          if (level <= Math.max(cur.h, prev.h)) {
            const lx = prev.x + ((cur.x - prev.x) * (level - prev.h)) / (cur.h - prev.h);
            if (!out.some((o) => Math.hypot(o.x - (lx - r.left), o.y - r.height * row) < 110)) out.push({ x: lx - r.left, y: r.height * row, text: format(level, digits) });
          }
        }
        prev = cur;
      }
    }
    for (const { spot, xz } of spots()) {
      const at = screen(xz[0], hm.at(xz[0], xz[1]), xz[1]);
      if (at && at[0] > r.left && at[0] < r.right && at[1] > r.top && at[1] < r.bottom) out.push({ x: at[0] - r.left, y: at[1] - r.top - 18, text: `${format(spot.height, 2)} м`, spot: true });
    }
    useStore.getState().set({ contourLabels: out });
  };

  const unsubscribe = [
    useStore.subscribe((s, prev) => {
      if (s.contourStep !== prev.contourStep) uniforms.uStep.value = s.contourStep;
      if (s.contourSpot !== prev.contourSpot || s.terrainRev !== prev.terrainRev || s.contours !== prev.contours) drawSpots();
      if (s.contourStep !== prev.contourStep || s.terrainRev !== prev.terrainRev || s.contours !== prev.contours || s.relief !== prev.relief) stale = true;
      if (!s.contours && prev.contours) {
        canvas.style.cursor = '';
        s.set({ contourLabels: [], contourHover: null });
      }
    }),
    useEditStore.subscribe((s, prev) => {
      if (s.edits.spots !== prev.edits.spots) {
        drawSpots();
        stale = true;
      }
    }),
  ];
  drawSpots();

  return {
    group,
    update: () => {
      const s = useStore.getState();
      const on = s.contours && s.mode === 'overview';
      group.visible = on;
      if (!on) return;
      const now = performance.now();
      const next = camera.matrixWorld.elements.map((e) => e.toFixed(2)).join();
      if (next !== pose) {
        pose = next;
        movedAt = now;
        stale = true;
        if (s.contourLabels.length) s.set({ contourLabels: [] });
      } else if (stale && now - movedAt > 220 && !s.relief) {
        stale = false;
        label();
      }
    },
    dispose: () => {
      abort.abort();
      unsubscribe.forEach((fn) => fn());
      d.overview.setEnabled(true);
      canvas.style.cursor = '';
      lines.dispose();
      spotGeometry.dispose();
      spotMaterial.dispose();
      dot.dispose();
      ring.geometry.dispose();
      ringMaterial.dispose();
      pull.geometry.dispose();
      (pull.material as LineBasicMaterial).dispose();
    },
  };
}
