import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { controlPoints, crsFromGeoKeys, tmForward, tmInverse, utmZone, webMercatorForward, webMercatorInverse } from './geoReference';

describe('пересчёт координат ортофото', () => {
  it('UTM: эталонные точки', () => {
    const zone31 = utmZone(31, false); // осевой меридиан 3° в. д.
    const [e0, n0] = tmForward([3, 0], zone31);
    expect(e0).toBeCloseTo(500_000, 3);
    expect(n0).toBeCloseTo(0, 3);
    // 45° с. ш. на осевом меридиане — 4 982 950,4 м (справочное значение).
    expect(tmForward([3, 45], zone31)[1]).toBeCloseTo(4_982_950.4, 0);
  });

  it('UTM туда и обратно — миллиметры (Уфа, зона 40)', () => {
    const zone40 = utmZone(40, false);
    for (const p of [[55.9449, 54.7388], [58.1, 52.4], [54.2, 56.9]] as [number, number][]) {
      const [lon, lat] = tmInverse(tmForward(p, zone40), zone40);
      expect(Math.abs(lon - p[0]) * 111_000 * Math.cos((p[1] * Math.PI) / 180)).toBeLessThan(0.001);
      expect(Math.abs(lat - p[1]) * 111_000).toBeLessThan(0.001);
    }
    // Южное полушарие и широта начала не на экваторе.
    const south = utmZone(23, true);
    const back = tmInverse(tmForward([-45.3, -23.5], south), south);
    expect(back[0]).toBeCloseTo(-45.3, 8);
    expect(back[1]).toBeCloseTo(-23.5, 8);
    const local = { lon0: 56, lat0: 54, k0: 1, falseEasting: 1_300_000, falseNorthing: -5_000 };
    expect(tmForward([56, 54], local)[1]).toBeCloseTo(-5_000, 6);
    const back2 = tmInverse(tmForward([55.8, 54.3], local), local);
    expect(back2[0]).toBeCloseTo(55.8, 8);
    expect(back2[1]).toBeCloseTo(54.3, 7); // 1e-7° ≈ 1 см; на деле — меньше миллиметра
  });

  it('Web Mercator туда и обратно', () => {
    const [lon, lat] = webMercatorInverse(webMercatorForward([55.9449, 54.7388]));
    expect(lon).toBeCloseTo(55.9449, 9);
    expect(lat).toBeCloseTo(54.7388, 9);
  });

  it('система координат по геоключам', () => {
    const utm = crsFromGeoKeys({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32640 });
    expect('toLonLat' in utm && utm.name).toBe('UTM 40N');
    if ('toLonLat' in utm) {
      const [lon, lat] = utm.toLonLat(tmForward([55.95, 54.74], utmZone(40, false)));
      expect(lon).toBeCloseTo(55.95, 8);
      expect(lat).toBeCloseTo(54.74, 7);
    }
    expect('toLonLat' in crsFromGeoKeys({ GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 })).toBe(true);
    expect('toLonLat' in crsFromGeoKeys({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 })).toBe(true);
    expect(crsFromGeoKeys({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 28410 })).toHaveProperty('error');
    expect(crsFromGeoKeys(null)).toHaveProperty('error');
  });

  it('опорные точки: сдвиг и масштаб, поворот, центр пикселя', () => {
    const plain = controlPoints({ modelTiepoint: [0, 0, 0, 1000, 2000, 0], modelPixelScale: [0.5, 0.5, 0] }, [100, 80])!;
    expect(plain).toHaveLength(25);
    const corner = plain.find((p) => p.pixel[0] === 100 && p.pixel[1] === 80)!;
    expect(corner.model).toEqual([1050, 1960]);
    // То же, но координаты относятся к центрам пикселей — угол на полпикселя дальше.
    const point = controlPoints({ modelTiepoint: [0, 0, 0, 1000, 2000, 0], modelPixelScale: [0.5, 0.5, 0], pixelIsPoint: true }, [100, 80])!;
    expect(point[0]!.model).toEqual([999.75, 2000.25]);
    // Матрица с поворотом.
    const rotated = controlPoints({ modelTransformation: [0.3, 0.4, 0, 10, 0.4, -0.3, 0, 20, 0, 0, 0, 0, 0, 0, 0, 1] }, [10, 10])!;
    const p = rotated.find((c) => c.pixel[0] === 10 && c.pixel[1] === 0)!;
    expect(p.model[0]).toBeCloseTo(13, 9);
    expect(p.model[1]).toBeCloseTo(24, 9);
    // Свои опорные точки (GCP).
    const gcp = controlPoints({ modelTiepoint: [0, 0, 0, 1, 2, 0, 9, 0, 0, 3, 2, 0, 9, 9, 0, 3, 0, 0, 0, 9, 0, 1, 0, 0] }, [10, 10])!;
    expect(gcp.map((c) => c.pixel)).toEqual([[0, 0], [9, 0], [9, 9], [0, 9]] as Vec2[]);
    expect(controlPoints({}, [10, 10])).toBeUndefined();
  });
});
