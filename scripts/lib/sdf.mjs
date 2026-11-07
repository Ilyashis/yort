// Лепка полем расстояний (SDF): каждая форма — функция (x, y, z) → расстояние до поверхности
// (меньше нуля — внутри). Формы сливаются «мягким объединением», как куски глины, — без швов.
// Все функции без выделения памяти на вызов: поле считается миллионы раз.

export const dot3 = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;

/** Мягкое объединение: k — ширина «наплыва» в метрах. */
export function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Мягкое вычитание b из a. */
export function ssub(a, b, k) {
  return -smin(-a, b, k);
}

/** Объединение списка форм с одним k. */
export function blend(parts, k) {
  return (x, y, z) => {
    let d = Infinity;
    for (const part of parts) d = smin(d, part(x, y, z), k);
    return d;
  };
}

export function sphere([cx, cy, cz], r) {
  return (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - r;
}

/**
 * Конус со скруглёнными концами между точками a и b, радиусы ra и rb (капсула, если равны).
 * Формула И. Килеза (sdRoundCone), точная.
 */
export function cone(a, b, ra, rb = ra) {
  const bax = b[0] - a[0];
  const bay = b[1] - a[1];
  const baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a[0];
    const pay = y - a[1];
    const paz = z - a[2];
    const t = pax * bax + pay * bay + paz * baz;
    const u = t - l2;
    const qx = pax * l2 - bax * t;
    const qy = pay * l2 - bay * t;
    const qz = paz * l2 - baz * t;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = t * t * l2;
    const z2 = u * u * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(u) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
    if (Math.sign(t) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
    return (Math.sqrt(x2 * a2 * il2) + t * rr) * il2 - ra;
  };
}

/** Цепочка конусов по точкам [x, y, z, r] — лапа, хвост, рука. */
export function chain(points, k = 0) {
  const parts = [];
  for (let i = 1; i < points.length; i++) {
    const [ax, ay, az, ar] = points[i - 1];
    const [bx, by, bz, br] = points[i];
    parts.push(cone([ax, ay, az], [bx, by, bz], ar, br));
  }
  return k > 0 ? blend(parts, k) : (x, y, z) => {
    let d = Infinity;
    for (const part of parts) d = Math.min(d, part(x, y, z));
    return d;
  };
}

/**
 * Базис по направлению: ось «вдоль» — dir, «вверх» — ближе к up. Возвращает три единичных вектора.
 */
export function basis(dir, up = [0, 0, 1]) {
  const l = Math.hypot(...dir);
  const ey = dir.map((v) => v / l);
  let ex = cross(ey, up);
  const lx = Math.hypot(...ex);
  ex = lx < 1e-6 ? [1, 0, 0] : ex.map((v) => v / lx);
  const ez = cross(ex, ey);
  return { ex, ey, ez };
}

/**
 * Эллипсоид: центр c, радиусы [поперёк (x), вдоль dir (y), «вверх» (z)].
 * Приближение Килеза: точное на поверхности, снаружи — нижняя оценка (для лепки хватает).
 */
export function ellipsoid(c, [rx, ry, rz], dir = [0, 1, 0], up = [0, 0, 1]) {
  const { ex, ey, ez } = basis(dir, up);
  return (x, y, z) => {
    const px = x - c[0];
    const py = y - c[1];
    const pz = z - c[2];
    const lx = px * ex[0] + py * ex[1] + pz * ex[2];
    const ly = px * ey[0] + py * ey[1] + pz * ey[2];
    const lz = px * ez[0] + py * ez[1] + pz * ez[2];
    const k0 = Math.hypot(lx / rx, ly / ry, lz / rz);
    const k1 = Math.hypot(lx / (rx * rx), ly / (ry * ry), lz / (rz * rz));
    return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
  };
}

/** Плита-овал: центр низа c, полуоси rx, ry, толщина h, скругление кромки e. */
export function ovalSlab(c, rx, ry, h, e = 0.01) {
  const r = Math.min(rx, ry);
  return (x, y, z) => {
    const dxy = (Math.hypot((x - c[0]) / rx, (y - c[1]) / ry) - 1) * r;
    const dz = Math.abs(z - c[2] - h / 2) - h / 2;
    const ox = Math.max(dxy + e, 0);
    const oz = Math.max(dz + e, 0);
    return Math.min(Math.max(dxy + e, dz + e), 0) + Math.hypot(ox, oz) - e;
  };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Детерминированный «шум» из синусов: складки ткани, пряди гривы. Амплитуда ~1. */
export function waves(x, y, z, f) {
  return (
    Math.sin(x * f * 1.3 + Math.sin(z * f * 0.7)) * 0.5 +
    Math.sin(y * f * 1.7 + z * f * 0.4) * 0.3 +
    Math.sin((x + y + z) * f * 2.9) * 0.2
  );
}
