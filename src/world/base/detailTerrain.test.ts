import { describe, expect, it } from 'vitest';
import { DetailHeights, decodeDetailFile, fadeWeights, type DetailGridData, type DetailTerrainFile } from './detailTerrain';

const bbox = { west: 57.0, south: 52.0, east: 57.01, north: 52.01 }; // ~680 × 1113 м
const N = 101; // узлы ~6,8 × 11 м
const base = () => 100;

/** Сетка съёмки: везде value (или NaN в hole). */
function grid(value: number, hole?: (x: number, y: number) => boolean, fade = 50): DetailGridData {
  const values = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) values[y * N + x] = hole?.(x, y) ? Number.NaN : value;
  return { bbox, width: N, height: N, values, fade };
}

const lonAt = (x: number) => bbox.west + ((bbox.east - bbox.west) * x) / (N - 1);
const latAt = (y: number) => bbox.north - ((bbox.north - bbox.south) * y) / (N - 1);

describe('подробный рельеф поверх общего', () => {
  it('снаружи — общий рельеф, в середине снятого — съёмка', () => {
    const h = new DetailHeights(grid(103), base);
    expect(h.heightAt(56.99, 52.005)).toBe(100);
    expect(h.heightAt(lonAt(50), latAt(50))).toBeCloseTo(103, 6);
  });

  it('к краю снятого — плавный переход, без ступенек', () => {
    const h = new DetailHeights(grid(110), base);
    let prev = h.heightAt(lonAt(0.01), latAt(50));
    expect(prev).toBeCloseTo(100, 1);
    // Шагаем от края к середине: высота растёт монотонно и без скачков больше 1,5 м на узел.
    for (let x = 0.5; x <= 30; x += 0.5) {
      const v = h.heightAt(lonAt(x), latAt(50));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(v - prev).toBeLessThan(1.5);
      prev = v;
    }
    expect(prev).toBeCloseTo(110, 6);
  });

  it('в «дырке» съёмки (лес) — общий рельеф, вокруг — переход', () => {
    const hole = (x: number, y: number) => Math.hypot(x - 50, y - 50) < 10;
    const h = new DetailHeights(grid(108, hole), base);
    expect(h.heightAt(lonAt(50), latAt(50))).toBe(100);
    const near = h.heightAt(lonAt(61), latAt(50));
    expect(near).toBeGreaterThan(100);
    expect(near).toBeLessThan(108);
    expect(h.heightAt(lonAt(85), latAt(50))).toBeCloseTo(108, 6);
  });

  it('охват — там, где съёмка что-то меняет', () => {
    const onlyCorner = (x: number, y: number) => !(x >= 10 && x <= 40 && y >= 60 && y <= 90);
    const h = new DetailHeights(grid(105, onlyCorner), base);
    const c = h.coverage!;
    expect(c.west).toBeGreaterThanOrEqual(lonAt(9));
    expect(c.east).toBeLessThanOrEqual(lonAt(41));
    expect(c.north).toBeLessThanOrEqual(latAt(59));
    expect(c.south).toBeGreaterThanOrEqual(latAt(91));
    expect(new DetailHeights(grid(105, () => true), base).coverage).toBeUndefined();
  });

  it('вес растёт от края к середине: 0 у края, 1 дальше fade', () => {
    const values = new Float32Array(21 * 21).fill(1);
    const w = fadeWeights(values, 21, 21, 10, 10, 50);
    expect(w[10 * 21 + 0]).toBe(0);
    expect(w[10 * 21 + 2]).toBeGreaterThan(0);
    expect(w[10 * 21 + 2]).toBeLessThan(w[10 * 21 + 4]!);
    expect(w[10 * 21 + 10]).toBe(1);
  });

  it('под улицей — ровное полотно по уклону, к обочине — переход, вдали — съёмка как есть', () => {
    // Сетка 1 м, 141 × 141 м: уклон 2 % на восток плюс «шум» съёмки ±0,3 м; посередине дорога шириной 7 м.
    const S = 141;
    const mLon = 111_320 * Math.cos((52 * Math.PI) / 180);
    const box = { west: 57, south: 52, east: 57 + (S - 1) / mLon, north: 52 + (S - 1) / 111_320 };
    const ground = (x: number, y: number) => 100 + 0.02 * x + 0.3 * Math.sin(x * 1.7 + y * 0.9) * Math.cos(y * 2.3 - x * 0.4);
    const values = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) values[y * S + x] = ground(x, y);
    values[90 * S + 90] = Number.NaN;
    const h = new DetailHeights({ bbox: box, width: S, height: S, values, fade: 0.5 }, () => 0);
    const lon = (x: number) => box.west + x / mLon;
    const lat = (y: number) => box.north - y / 111_320;
    h.flattenRoads([{ coords: [[lon(5), lat(70)], [lon(135), lat(70)]], width: 7 }]);

    for (const x of [30, 60, 100]) {
      // Поперёк проезжей части — одна высота, и она близка к уклону местности.
      const across = [67, 68, 69, 70, 71, 72, 73].map((y) => h.heightAt(lon(x), lat(y)));
      expect(Math.max(...across) - Math.min(...across)).toBeLessThan(1e-3);
      expect(Math.abs(across[3]! - (100 + 0.02 * x))).toBeLessThan(0.15);
      // Обочина (узел в 2,5 м за ровной полосой) — между полотном и съёмкой.
      const shoulder = h.heightAt(lon(x), lat(77));
      const road = across[3]!;
      const raw = ground(x, 77);
      expect(Math.abs(shoulder - road)).toBeLessThanOrEqual(Math.abs(raw - road) + 1e-6);
      // Вдали от дороги — съёмка без изменений.
      expect(h.heightAt(lon(x), lat(40))).toBeCloseTo(ground(x, 40), 4);
    }
    // Вдоль дороги — плавно: без изломов больше 2 см на метр.
    const along = Array.from({ length: 81 }, (_, i) => h.heightAt(lon(30 + i), lat(70)));
    for (let i = 1; i + 1 < along.length; i++) expect(Math.abs(along[i + 1]! - 2 * along[i]! + along[i - 1]!)).toBeLessThan(0.02);
    // Где съёмки нет — так и остаётся.
    expect(h.heightAt(lon(90), lat(90))).toBeCloseTo(0, 6);
  });

  /** Сетка 1 м, 141 × 141 м: уклон 3 % на восток плюс «шум» съёмки ±0,3 м. */
  function noisySlope() {
    const S = 141;
    const mLon = 111_320 * Math.cos((52 * Math.PI) / 180);
    const box = { west: 57, south: 52, east: 57 + (S - 1) / mLon, north: 52 + (S - 1) / 111_320 };
    const ground = (x: number, y: number) => 100 + 0.03 * x + 0.3 * Math.sin(x * 1.7 + y * 0.9) * Math.cos(y * 2.3 - x * 0.4);
    const values = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) values[y * S + x] = ground(x, y);
    const h = new DetailHeights({ bbox: box, width: S, height: S, values, fade: 0.5 }, () => 0);
    const at = (x: number, y: number) => h.heightAt(box.west + x / mLon, box.north - y / 111_320);
    const ll = (x: number, y: number): [number, number] => [box.west + x / mLon, box.north - y / 111_320];
    return { h, ground, at, ll };
  }

  it('двор — плоскостью по уклону: без бугров, но и без ступени', () => {
    const { h, ground, at, ll } = noisySlope();
    h.flattenYards([[ll(40, 40), ll(70, 40), ll(70, 60), ll(40, 60)]]);
    for (const y of [42, 50, 58]) {
      for (const x of [42, 55, 68]) {
        // Внутри двора — плоскость с уклоном местности (3 %), шум ±0,3 м убран.
        expect(Math.abs(at(x, y) - (100 + 0.03 * x))).toBeLessThan(0.08);
      }
      // Строго плоско: вторые разности по x — ноль.
      expect(Math.abs(at(50, y) - 2 * at(55, y) + at(60, y))).toBeLessThan(1e-3);
    }
    // Вдали от двора — съёмка как есть.
    expect(at(100, 100)).toBeCloseTo(ground(100, 100), 4);
  });

  it('под домом — ровная площадка: пол и низ стен почти на одной высоте', () => {
    const { h, ground, at, ll } = noisySlope();
    const house: [number, number][] = [ll(60, 60), ll(68, 60), ll(68, 70), ll(60, 70)];
    h.flattenPads([house]);
    const under = [60, 62, 64, 66, 68].flatMap((x) => [60, 65, 70].map((y) => at(x, y)));
    expect(Math.max(...under) - Math.min(...under)).toBeLessThan(1e-3);
    // Уровень площадки — земля под домом, не выше и не ниже её.
    expect(Math.abs(under[0]! - (100 + 0.03 * 64))).toBeLessThan(0.15);
    expect(at(100, 100)).toBeCloseTo(ground(100, 100), 4);
  });

  it('файл: «нет данных» — NaN, высоты — в дециметрах со сдвигом', () => {
    const raw = new Int16Array([10, -32768, 25, 0]);
    const heights = btoa(String.fromCharCode(...new Uint8Array(raw.buffer)));
    const file: DetailTerrainFile = {
      metadata: { source: 'дрон', license: '', credit: '' },
      bbox,
      width: 2,
      height: 2,
      scale: 0.1,
      offset: 400,
      heights,
      nodata: -32768,
      fade: 30,
    };
    const data = decodeDetailFile(file);
    expect(data.values[0]).toBeCloseTo(401, 6);
    expect(Number.isNaN(data.values[1]!)).toBe(true);
    expect(data.values[2]).toBeCloseTo(402.5, 6);
    expect(data.fade).toBe(30);
  });
});
