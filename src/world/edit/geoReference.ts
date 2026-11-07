// Привязка ортофото GeoTIFF: из тегов файла — где на Земле лежит каждый пиксель.
// Только чистая математика (без чтения файла): пиксель → координаты в системе снимка → долгота/широта.
// Поддерживаются системы, в которых ортофото отдают программы для дронов (WebODM, DJI Terra,
// Pix4D, Agisoft): WGS 84 в градусах, UTM на WGS 84, Web Mercator и поперечный Меркатор на WGS 84.

import type { LonLat } from '../user/plot';
import type { Vec2 } from '../walk/localFrame';

// --- поперечный Меркатор (ряды Крюгера, эллипсоид WGS 84) ----------------------------------

const A_AXIS = 6_378_137;
const FLATTENING = 1 / 298.257223563;
const N = FLATTENING / (2 - FLATTENING);
const N2 = N * N;
const N3 = N2 * N;
/** Длина дуги меридиана на радиан (радиус «спрямляющей сферы»). */
const RECTIFYING = (A_AXIS / (1 + N)) * (1 + N2 / 4 + (N2 * N2) / 64);
const ALPHA = [N / 2 - (2 * N2) / 3 + (5 * N3) / 16, (13 * N2) / 48 - (3 * N3) / 5, (61 * N3) / 240];
const BETA = [N / 2 - (2 * N2) / 3 + (37 * N3) / 96, N2 / 48 + N3 / 15, (17 * N3) / 480];
const DELTA = [2 * N - (2 * N2) / 3 - 2 * N3, (7 * N2) / 3 - (8 * N3) / 5, (56 * N3) / 15];
const ECC = (2 * Math.sqrt(N)) / (1 + N);
const RAD = Math.PI / 180;

export interface TransverseMercator {
  /** Осевой меридиан и широта начала, градусы. */
  lon0: number;
  lat0: number;
  /** Масштаб на осевом меридиане. */
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

/** Без учёта сдвигов: (восток, север) в метрах от осевого меридиана и экватора, при k0 = 1. */
function tmForwardRaw(lon: number, lat: number, lon0: number): Vec2 {
  const phi = lat * RAD;
  const lambda = (lon - lon0) * RAD;
  const sin = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sin) - ECC * Math.atanh(ECC * sin));
  const xi = Math.atan2(t, Math.cos(lambda));
  const eta = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let east = eta;
  let north = xi;
  ALPHA.forEach((a, j) => {
    const k = 2 * (j + 1);
    east += a * Math.cos(k * xi) * Math.sinh(k * eta);
    north += a * Math.sin(k * xi) * Math.cosh(k * eta);
  });
  return [RECTIFYING * east, RECTIFYING * north];
}

/** Долгота/широта → координаты поперечного Меркатора, м. */
export function tmForward([lon, lat]: LonLat, p: TransverseMercator): Vec2 {
  const [east, north] = tmForwardRaw(lon, lat, p.lon0);
  const north0 = p.lat0 === 0 ? 0 : tmForwardRaw(p.lon0, p.lat0, p.lon0)[1];
  return [p.falseEasting + p.k0 * east, p.falseNorthing + p.k0 * (north - north0)];
}

/** Координаты поперечного Меркатора, м → долгота/широта. */
export function tmInverse([x, y]: Vec2, p: TransverseMercator): LonLat {
  const north0 = p.lat0 === 0 ? 0 : tmForwardRaw(p.lon0, p.lat0, p.lon0)[1];
  const xi = ((y - p.falseNorthing) / p.k0 + north0) / RECTIFYING;
  const eta = (x - p.falseEasting) / p.k0 / RECTIFYING;
  let xi1 = xi;
  let eta1 = eta;
  BETA.forEach((b, j) => {
    const k = 2 * (j + 1);
    xi1 -= b * Math.sin(k * xi) * Math.cosh(k * eta);
    eta1 -= b * Math.cos(k * xi) * Math.sinh(k * eta);
  });
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  DELTA.forEach((d, j) => (phi += d * Math.sin(2 * (j + 1) * chi)));
  const lambda = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return [p.lon0 + lambda / RAD, phi / RAD];
}

/** Параметры зоны UTM (6°): например, Уфа — зона 40 север. */
export function utmZone(zone: number, south: boolean): TransverseMercator {
  return { lon0: zone * 6 - 183, lat0: 0, k0: 0.9996, falseEasting: 500_000, falseNorthing: south ? 10_000_000 : 0 };
}

// --- Web Mercator (EPSG:3857) ---------------------------------------------------------

export function webMercatorInverse([x, y]: Vec2): LonLat {
  return [x / A_AXIS / RAD, (2 * Math.atan(Math.exp(y / A_AXIS)) - Math.PI / 2) / RAD];
}

export function webMercatorForward([lon, lat]: LonLat): Vec2 {
  return [A_AXIS * lon * RAD, A_AXIS * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))];
}

// --- геоключи GeoTIFF -----------------------------------------------------------------

/** Геоключи из GeoKeyDirectory (имена — как в спецификации GeoTIFF). */
export type GeoKeys = Partial<Record<string, unknown>>;

const USER_DEFINED = 32767;
/** Датумы, которые в пределах сантиметров совпадают с WGS 84. */
const WGS84_LIKE_GEOGRAPHIC = new Set([4326, 4258, 4269, 4167, 7844]);
const WGS84_LIKE_DATUM = new Set([6326, 6258, 6269]);
const METRE = 9001;
const FOOT = 9002;
const US_FOOT = 9003;

/** Система координат снимка: перевод своих координат в долготу/широту — или текст ошибки. */
export type CrsResult = { toLonLat: (point: Vec2) => LonLat; name: string } | { error: string };

export function crsFromGeoKeys(keys: GeoKeys | null | undefined): CrsResult {
  if (!keys) return { error: 'В файле нет привязки к координатам (это обычный TIFF, не GeoTIFF).' };
  const num = (name: string) => (typeof keys[name] === 'number' ? (keys[name] as number) : undefined);
  const model = num('GTModelTypeGeoKey');
  const projected = num('ProjectedCSTypeGeoKey');
  const geographic = num('GeographicTypeGeoKey');
  const datum = num('GeogGeodeticDatumGeoKey');
  const wgs84Like = (geographic !== undefined && WGS84_LIKE_GEOGRAPHIC.has(geographic)) || (datum !== undefined && WGS84_LIKE_DATUM.has(datum));

  if (model === 2 || (model === undefined && projected === undefined && geographic !== undefined)) {
    if (geographic !== undefined && geographic !== USER_DEFINED && !wgs84Like) {
      return { error: `Снимок в географической системе EPSG:${geographic} — нужна WGS 84 (EPSG:4326).` };
    }
    return { toLonLat: ([x, y]) => [x, y], name: 'WGS 84' };
  }

  if (projected === 3857 || projected === 3785 || projected === 900913) {
    return { toLonLat: webMercatorInverse, name: 'Web Mercator' };
  }
  if (projected !== undefined && projected >= 32601 && projected <= 32660) {
    const zone = projected - 32600;
    const tm = utmZone(zone, false);
    return { toLonLat: (p) => tmInverse(p, tm), name: `UTM ${zone}N` };
  }
  if (projected !== undefined && projected >= 32701 && projected <= 32760) {
    const zone = projected - 32700;
    const tm = utmZone(zone, true);
    return { toLonLat: (p) => tmInverse(p, tm), name: `UTM ${zone}S` };
  }
  if (projected === USER_DEFINED && num('ProjCoordTransGeoKey') === 1 && wgs84Like) {
    // Свой поперечный Меркатор на WGS 84 (так иногда пишут местные зоны).
    const unit = num('ProjLinearUnitsGeoKey') ?? METRE;
    const toMetres = unit === METRE ? 1 : unit === FOOT ? 0.3048 : unit === US_FOOT ? 1200 / 3937 : num('ProjLinearUnitSizeGeoKey');
    if (!toMetres) return { error: 'Непонятные единицы длины в файле.' };
    const tm: TransverseMercator = {
      lon0: num('ProjNatOriginLongGeoKey') ?? num('ProjCenterLongGeoKey') ?? 0,
      lat0: num('ProjNatOriginLatGeoKey') ?? num('ProjCenterLatGeoKey') ?? 0,
      k0: num('ProjScaleAtNatOriginGeoKey') ?? num('ProjScaleAtCenterGeoKey') ?? 1,
      falseEasting: (num('ProjFalseEastingGeoKey') ?? 0) * toMetres,
      falseNorthing: (num('ProjFalseNorthingGeoKey') ?? 0) * toMetres,
    };
    return { toLonLat: ([x, y]) => tmInverse([x * toMetres, y * toMetres], tm), name: 'поперечный Меркатор' };
  }
  const code = projected && projected !== USER_DEFINED ? `EPSG:${projected}` : 'своя система координат';
  return {
    error: `Снимок в системе ${code}. Сохраните ортофото в WGS 84 (EPSG:4326) или UTM на WGS 84 — в WebODM, DJI Terra, QGIS это выбирается при экспорте.`,
  };
}

// --- пиксель → координаты снимка ----------------------------------------------------------

export interface ModelTags {
  modelTransformation?: ArrayLike<number>;
  modelTiepoint?: ArrayLike<number>;
  modelPixelScale?: ArrayLike<number>;
  /** GTRasterTypeGeoKey = 2: координаты относятся к центрам пикселей, а не к их углам. */
  pixelIsPoint?: boolean;
}

/** Пары «пиксель — координаты снимка», по которым строится привязка. */
export interface ControlPoint {
  pixel: Vec2;
  model: Vec2;
}

/**
 * Опорные точки снимка шириной w и высотой h (пиксели — по углам, как в canvas): сетка 5×5 точек
 * по аффинной привязке файла либо его собственные точки привязки (GCP), если их не меньше четырёх.
 */
export function controlPoints(tags: ModelTags, [w, h]: [number, number]): ControlPoint[] | undefined {
  const shift = tags.pixelIsPoint ? 0.5 : 0;
  let affine: ((i: number, j: number) => Vec2) | undefined;
  const t = tags.modelTransformation;
  const tie = tags.modelTiepoint;
  const scale = tags.modelPixelScale;
  if (t && t.length >= 16) {
    affine = (i, j) => [t[0]! * i + t[1]! * j + t[3]!, t[4]! * i + t[5]! * j + t[7]!];
  } else if (tie && tie.length >= 6 && scale && scale.length >= 2) {
    const [ti, tj, , tx, ty] = [tie[0]!, tie[1]!, tie[2]!, tie[3]!, tie[4]!];
    affine = (i, j) => [tx + (i - ti) * scale[0]!, ty - (j - tj) * scale[1]!];
  } else if (tie && tie.length >= 24) {
    const points: ControlPoint[] = [];
    for (let k = 0; k + 5 < tie.length; k += 6) points.push({ pixel: [tie[k]! + shift, tie[k + 1]! + shift], model: [tie[k + 3]!, tie[k + 4]!] });
    return points;
  }
  if (!affine) return undefined;
  const points: ControlPoint[] = [];
  const steps = 4;
  for (let a = 0; a <= steps; a++) {
    for (let b = 0; b <= steps; b++) {
      const pixel: Vec2 = [(w * a) / steps, (h * b) / steps];
      points.push({ pixel, model: affine(pixel[0] - shift, pixel[1] - shift) });
    }
  }
  return points;
}
