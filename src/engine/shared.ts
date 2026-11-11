// Общие для шейдеров значения (время, ночь) и кусочки GLSL.

export const shared = {
  uTime: { value: 0 },
  /** 0 — день, 1 — ночь. */
  uNight: { value: 0 },
  /** Доля горящих окон. */
  uWindows: { value: 0 },
  /** Сила фонарей 0..1. */
  uLamps: { value: 0 },
};

export const NOISE_GLSL = /* glsl */ `
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}
`;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Даёт браузеру отрисовать кадр между тяжёлыми шагами сборки сцены. */
export const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
