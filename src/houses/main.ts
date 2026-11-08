// Мастерская моделей: башкирские деревенские дома в ряд вдоль улицы — посмотреть со всех сторон,
// сменить окраску и размеры, посмотреть днём и ночью. Отдельная страница: /houses.html.
// Когда модели устроят, их можно будет ставить в редакторе вместо домов OSM или добавлять новые.

import { Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import '../styles.css';
import './houses.css';
import { CityScene } from '../three/CityScene';
import { formatTime, TIME_PRESETS } from '../three/dayNight';
import { buildHouseMesh, buildPartsMesh, createHouseMaterials, type HouseMesh } from '../three/houseMesh';
import { readPref, writePref } from '../utils/prefs';
import { HOUSE_MODELS, MODEL_GROUPS, type HouseModel, type HousePlan } from '../world/village/houseModels';
import type { HousePart, Vec3 } from '../world/village/houseParts';
import { planFrontGarden, shiftParts } from '../world/village/frontGarden';

/** 1-е Иткулово: отсюда считаем солнце. */
const LOCATION = { lat: 52.632, lon: 57.96 };
/** Промежуток между домами и ось улицы перед ними (локальные метры, улица — со стороны −y). */
const GAP = 7;
const STREET_Y = -11;
const STREET_WIDTH = 6;

interface Slot {
  model: HouseModel;
  seed: number;
  /** Зерно палисадника (у жилых домов). */
  gardenSeed: number;
  width: number;
  depth: number;
  plan: HousePlan;
  /** Габариты по x относительно центра дома. */
  minX: number;
  maxX: number;
  x: number;
  mesh?: HouseMesh;
}

const fmt = (v: number, digits = 1) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function extentX(plan: HousePlan): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  const take = (p: Vec3) => {
    min = Math.min(min, p[0]);
    max = Math.max(max, p[0]);
  };
  for (const p of plan.parts) {
    if (p.type === 'slab') p.points.forEach(take);
    else if (p.type === 'cylinder') {
      take(p.from);
      take(p.to);
    } else if (p.type === 'blob') {
      take([p.center[0] - Math.max(p.radii[0], p.radii[1]), 0, 0]);
      take([p.center[0] + Math.max(p.radii[0], p.radii[1]), 0, 0]);
    } else {
      const r = Math.hypot(p.size[0], p.size[1]) / 2;
      take([p.center[0] - r, 0, 0]);
      take([p.center[0] + r, 0, 0]);
    }
  }
  return [min, max];
}

// --- сцена ----------------------------------------------------------------------------------------

const stage = document.createElement('div');
stage.className = 'houses-stage';
document.body.appendChild(stage);
const city = new CityScene(stage, LOCATION);
city.setGroundSampler(() => 0);
const materials = createHouseMaterials(city.csm);

const slots: Slot[] = HOUSE_MODELS.map((model) => {
  const plan = model.plan({ seed: 1 });
  const [minX, maxX] = extentX(plan);
  return { model, seed: 1, gardenSeed: HOUSE_MODELS.indexOf(model) + 1, width: plan.width, depth: plan.depth, plan, minX, maxX, x: 0 };
});
/** Палисадники перед жилыми домами (запоминается). */
let gardensOn = readPref('houses-garden', ['on', 'off'] as const, 'on') === 'on';
const hasGarden = (slot: Slot) => slot.model.group === 'house' && slot.model.id !== 'banya';

/** Палисадник от стены до обочины улицы (не глубже 3,2 м) — перед фасадом, со стороны −y. */
function withGarden(slot: Slot, plan: HousePlan): HousePlan {
  if (!gardensOn || !hasGarden(slot)) return plan;
  const facade = -plan.depth / 2 - 0.15;
  const depth = Math.min(3.2, Math.max(1.2, facade - (STREET_Y + STREET_WIDTH / 2) - 0.9));
  const garden = planFrontGarden({ width: plan.width + 0.2, depth, seed: slot.gardenSeed });
  return { ...plan, parts: [...plan.parts, ...shiftParts(garden.parts, 0, facade)] };
}
let ground: HouseMesh | undefined;
let selected = 0;

/** Дома в ряд по габаритам, ряд — по центру; земля и улица под ними. */
function layout(): void {
  const total = slots.reduce((s, slot) => s + slot.maxX - slot.minX, 0) + GAP * (slots.length - 1);
  let cursor = -total / 2;
  for (const slot of slots) {
    slot.x = cursor - slot.minX;
    cursor += slot.maxX - slot.minX + GAP;
    slot.mesh?.group.position.set(slot.x, 0, 0);
  }
  if (!ground) {
    const half = total / 2 + 60;
    const parts: HousePart[] = [
      {
        type: 'slab',
        points: [
          [-half - 200, -220, 0],
          [half + 200, -220, 0],
          [half + 200, 220, 0],
          [-half - 200, 220, 0],
        ],
        thickness: 0.2,
        color: '#8fa560',
        surface: 'grass',
      },
      {
        type: 'slab',
        points: [
          [-half, STREET_Y - STREET_WIDTH / 2, 0.02],
          [half, STREET_Y - STREET_WIDTH / 2, 0.02],
          [half, STREET_Y + STREET_WIDTH / 2, 0.02],
          [-half, STREET_Y + STREET_WIDTH / 2, 0.02],
        ],
        thickness: 0.05,
        color: '#b39e80',
        surface: 'dirt',
      },
    ];
    ground = buildPartsMesh(parts, materials, 'houses-ground');
    ground.group.traverse((o) => (o.castShadow = false));
    city.scene.add(ground.group);
  }
  city.requestRender();
}

function rebuild(slot: Slot): void {
  if (slot.mesh) {
    city.scene.remove(slot.mesh.group);
    slot.mesh.dispose();
  }
  slot.plan = slot.model.plan({ seed: slot.seed, width: slot.width, depth: slot.depth });
  const shown = withGarden(slot, slot.plan);
  [slot.minX, slot.maxX] = extentX(shown);
  slot.mesh = buildHouseMesh(shown, materials);
  city.scene.add(slot.mesh.group);
}

for (const slot of slots) rebuild(slot);
layout();

// Камера: вращение вокруг выбранного дома мышью, колесо — ближе/дальше.
const controls = new OrbitControls(city.camera, city.canvas);
controls.target = city.target;
controls.enableDamping = true;
controls.dampingFactor = 0.1;
controls.minDistance = 3;
controls.maxDistance = 220;
controls.maxPolarAngle = (88 * Math.PI) / 180;
controls.autoRotateSpeed = 0.7;
controls.addEventListener('change', () => city.requestRender());
city.addAnimator(() => !city.flying && controls.update());

function viewOf(slot: Slot): { position: Vector3; target: Vector3 } {
  const target = new Vector3(slot.x, slot.plan.height * 0.42, 0);
  const size = Math.max(slot.plan.width, slot.plan.depth, 5);
  return { position: city.orbitPosition(target, 22, 16, size * 2 + 7), target };
}

function overview(): void {
  const first = slots[0]!;
  const last = slots[slots.length - 1]!;
  const span = last.x + last.maxX - (first.x + first.minX);
  const target = new Vector3((first.x + first.minX + last.x + last.maxX) / 2, 2, -STREET_Y / 2);
  city.flyTo(city.orbitPosition(target, 0, 24, span * 0.85), target, 1.4);
}

// --- панель ---------------------------------------------------------------------------------------

const panel = document.createElement('aside');
panel.className = 'panel houses-panel';
panel.innerHTML = `
  <div class="houses-brand">AI UFA · мастерская</div>
  <h1>Башкирская деревня</h1>
  <p class="muted">Модели для деревни: жилые дома, школа, музей, клуб, контора, магазины, остановка, колодец.
  Мышь — вращать, колесо — ближе, ← → — соседнее здание. В редакторе их ставят вместо домов OSM или новыми.</p>
  <div class="houses-groups"></div>
  <div class="houses-detail">
    <h2 class="houses-name"></h2>
    <p class="houses-description"></p>
    <p class="muted houses-numbers"></p>
    <label class="field"><span>Ширина по улице <b class="houses-width-value"></b></span><input class="houses-width" type="range" step="0.1" /></label>
    <label class="field"><span>Глубина во двор <b class="houses-depth-value"></b></span><input class="houses-depth" type="range" step="0.1" /></label>
    <div class="button-row">
      <button type="button" class="button houses-variant">Другая окраска</button>
      <button type="button" class="button houses-variant-all">Перекрасить все</button>
      <button type="button" class="button houses-garden-variant">Другой палисадник</button>
    </div>
  </div>
  <div class="houses-time">
    <div class="time-head"><span>Время суток</span><b class="houses-time-value"></b></div>
    <input class="time-slider houses-time-slider" type="range" min="0" max="24" step="0.0833" aria-label="Время суток" />
    <div class="segmented segmented-small houses-presets"></div>
  </div>
  <label class="toggle"><input type="checkbox" class="houses-garden" /> Палисадники перед домами</label>
  <label class="toggle"><input type="checkbox" class="houses-spin" /> Медленно вращаться вокруг дома</label>
  <button type="button" class="button houses-overview">Вся улица</button>
`;
document.body.appendChild(panel);
const $ = <T extends Element>(selector: string) => panel.querySelector<T>(selector)!;

// Список по разделам: жилые дома, общественные здания, двор и улица.
const list = $<HTMLDivElement>('.houses-groups');
const buttons: HTMLButtonElement[] = [];
for (const { group, label } of MODEL_GROUPS) {
  const heading = document.createElement('h3');
  heading.className = 'houses-group';
  heading.textContent = label;
  const ol = document.createElement('ol');
  ol.className = 'houses-list';
  for (const [i, slot] of slots.entries()) {
    if (slot.model.group !== group) continue;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<b>${slot.model.name}</b><span>${slot.model.summary}</span>`;
    button.addEventListener('click', () => select(i, true));
    buttons[i] = button;
    item.appendChild(button);
    ol.appendChild(item);
  }
  list.append(heading, ol);
}

const widthInput = $<HTMLInputElement>('.houses-width');
const depthInput = $<HTMLInputElement>('.houses-depth');

function showDetail(): void {
  const slot = slots[selected]!;
  buttons.forEach((b, i) => b.classList.toggle('active', i === selected));
  $('.houses-name').textContent = slot.model.name;
  $('.houses-description').textContent = slot.model.description;
  $('.houses-numbers').textContent =
    `${fmt(slot.plan.width)} × ${fmt(slot.plan.depth)} м, высота ${fmt(slot.plan.height)} м · ` +
    `${(slot.mesh?.triangles ?? 0).toLocaleString('ru-RU')} треугольников · вариант ${slot.seed}`;
  for (const [input, range, value] of [
    [widthInput, slot.model.width, slot.width],
    [depthInput, slot.model.depth, slot.depth],
  ] as const) {
    input.min = String(range.min);
    input.max = String(range.max);
    input.value = String(value);
  }
  $('.houses-width-value').textContent = `${fmt(slot.plan.width)} м`;
  $('.houses-depth-value').textContent = `${fmt(slot.plan.depth)} м`;
  // У юрты один размер — диаметр.
  const round = slot.model.id === 'yurt';
  depthInput.closest('label')!.toggleAttribute('hidden', round);
  $('.houses-garden-variant').toggleAttribute('hidden', !hasGarden(slot) || !gardensOn);
  $('.houses-width').closest('label')!.querySelector('span')!.firstChild!.textContent = round ? 'Диаметр ' : 'Ширина по улице ';
}

function select(index: number, fly: boolean): void {
  selected = (index + slots.length) % slots.length;
  showDetail();
  if (fly) {
    const view = viewOf(slots[selected]!);
    city.flyTo(view.position, view.target, 1.2);
  }
}

$('.houses-variant').addEventListener('click', () => {
  const slot = slots[selected]!;
  slot.seed += 1;
  rebuild(slot);
  layout();
  showDetail();
});
$('.houses-garden-variant').addEventListener('click', () => {
  const slot = slots[selected]!;
  slot.gardenSeed += 17;
  rebuild(slot);
  layout();
  showDetail();
});
const gardenToggle = $<HTMLInputElement>('.houses-garden');
gardenToggle.checked = gardensOn;
gardenToggle.addEventListener('change', () => {
  gardensOn = gardenToggle.checked;
  writePref('houses-garden', gardensOn ? 'on' : 'off');
  for (const slot of slots) if (hasGarden(slot)) rebuild(slot);
  layout();
  showDetail();
});
$('.houses-variant-all').addEventListener('click', () => {
  for (const slot of slots) {
    slot.seed += 1;
    rebuild(slot);
  }
  layout();
  showDetail();
});
const resize = () => {
  const slot = slots[selected]!;
  slot.width = Number(widthInput.value);
  slot.depth = slot.model.id === 'yurt' ? slot.width : Number(depthInput.value);
  rebuild(slot);
  layout();
  showDetail();
};
widthInput.addEventListener('input', resize);
depthInput.addEventListener('input', resize);

// Время суток: по умолчанию — светлый день; запоминается.
const timeSlider = $<HTMLInputElement>('.houses-time-slider');
const presets = $<HTMLDivElement>('.houses-presets');
for (const preset of TIME_PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = preset.label;
  b.addEventListener('click', () => setTime(preset.hours));
  presets.appendChild(b);
}
function setTime(hours: number): void {
  city.setTime(hours);
  timeSlider.value = String(hours);
  $('.houses-time-value').textContent = formatTime(hours);
  presets.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', Math.abs(TIME_PRESETS[i]!.hours - hours) < 0.05));
  writePref('houses-time', hours.toFixed(3));
}
timeSlider.addEventListener('input', () => setTime(Number(timeSlider.value)));
const savedTime = Number(readPref('houses-time', Array.from({ length: 24 * 12 + 1 }, (_, i) => (i / 12).toFixed(3)), '15.500'));
setTime(Number.isFinite(savedTime) ? savedTime : 15.5);

$<HTMLInputElement>('.houses-spin').addEventListener('change', (e) => {
  controls.autoRotate = (e.target as HTMLInputElement).checked;
  city.requestRender();
});
$('.houses-overview').addEventListener('click', overview);

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type !== 'checkbox' && event.target.type !== 'range') return;
  if (event.code === 'ArrowRight') select(selected + 1, true);
  else if (event.code === 'ArrowLeft') select(selected - 1, true);
});

// Сразу — вид на первый дом.
select(0, false);
const first = viewOf(slots[0]!);
city.setView(first.position, first.target);

if (import.meta.env.DEV) Object.assign(window, { __houses: { city, slots, select, setTime, overview, controls } });
