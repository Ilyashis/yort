import { Cartesian3, PostProcessStage, type Scene } from 'cesium';

/** Настройки «рисованного» вида. */
export interface IllustrationOptions {
  /** Сила контуров 0..1. */
  outline: number;
  /** На каком расстоянии (м) дымка набирает ~63 % от максимума. */
  hazeDistance: number;
  /** Максимальная доля дымки вдали. */
  hazeMax: number;
  /** Цвет дымки — как у неба у горизонта. */
  hazeColor: Cartesian3;
}

export const ILLUSTRATION_DEFAULTS: IllustrationOptions = {
  outline: 0.75,
  hazeDistance: 5200,
  hazeMax: 0.62,
  hazeColor: new Cartesian3(0.79, 0.86, 0.93),
};

/**
 * Постобработка «как иллюстрация к книге о городе», один проход на весь экран:
 *  1. Контуры — тонкие тёмные линии по силуэтам и изломам поверхностей: стены и крыши,
 *     край дома на фоне земли, кроны деревьев. Ищутся по глубине: соседний пиксель лежит
 *     не в плоскости текущего — значит, здесь край. Порог — в долях размера пикселя на этом
 *     расстоянии, поэтому линии одной толщины и вблизи, и вдали; плоская земля линий не даёт.
 *  2. Воздушная перспектива — дальнее голубеет и светлеет, как в дымке.
 *  3. Цветокоррекция — чуть больше насыщенности, тёплый свет и прохладные тени, мягкая виньетка.
 * Работает после затенения в углах и перед сглаживанием FXAA: линии получаются гладкими.
 */
export function createIllustrationStage(scene: Scene, options: Partial<IllustrationOptions> = {}): PostProcessStage {
  const opts = { ...ILLUSTRATION_DEFAULTS, ...options };
  // Глубина земли — чтобы не обводить рельеф. Встроенная czm_globeDepthTexture на первых кадрах
  // ещё не создана, и Cesium падает с «reading '_target'», останавливая отрисовку. Поэтому отдаём
  // её сами, а пока её нет — пустую текстуру (тогда рельеф просто обводится как всё остальное).
  // uniformState и defaultTexture — внутренние поля Cesium; при обновлении стоит проверить.
  const context = (scene as unknown as { context: InternalContext }).context;
  return new PostProcessStage({
    name: 'citia_illustration',
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      globeDepth: () => context.uniformState.globeDepthTexture ?? context.defaultTexture,
      outlineStrength: () => opts.outline,
      hazeDistance: () => opts.hazeDistance,
      hazeMax: () => opts.hazeMax,
      hazeColor: () => opts.hazeColor,
    },
  });
}

interface InternalContext {
  uniformState: { globeDepthTexture?: unknown };
  defaultTexture: unknown;
}

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform sampler2D globeDepth;
uniform float outlineStrength;
uniform float hazeDistance;
uniform float hazeMax;
uniform vec3 hazeColor;

in vec2 v_textureCoordinates;

// Точка сцены в координатах камеры; sky — в пикселе только небо; ground — голый рельеф
// (глубина сцены совпадает с глубиной земли), а не дом, дерево или фонарь.
// Небо и землю узнаём по «сырой» логарифмической глубине: у пустого пикселя она ровно 1.0.
// После пересчёта в обычную глубину (czm_readDepth) на прогулке — ближняя плоскость 0,1 м,
// дальняя 10¹⁰ м — точности float не хватает: небо через кадр выходило «не небом» и мерцало дымкой.
// Расстояние — тоже прямо из логарифмической глубины: w = 2^(z·log2(far − near + 1)) − 1 + near.
vec3 eyeAt(vec2 uv, out bool sky, out bool ground)
{
    float logDepth = texture(depthTexture, uv).r;
    float groundLogDepth = czm_unpackDepth(texture(globeDepth, uv));
    sky = logDepth >= 1.0;
    ground = !sky && abs(logDepth - groundLogDepth) < 1e-6;
    float w = exp2(logDepth * czm_log2FarDepthFromNearPlusOne) - 1.0 + czm_currentFrustum.x;
    vec4 q = czm_inverseProjection * vec4(2.0 * uv - 1.0, -1.0, 1.0);
    vec3 ray = q.xyz / q.w;
    return ray * (w / -ray.z);
}

// Сила контура между центром c и соседом n по плоскости центра.
float edgeTo(vec3 c, vec3 n, vec3 normal, bool groundPair, float lo, float hi)
{
    // Рельеф с рельефом не обводим: швы тайлов дают микроступеньки, а склоны и так видны.
    if (groundPair) return 0.0;
    return smoothstep(lo, hi, abs(dot(n - c, normal)));
}

vec3 grade(vec3 color, vec2 uv)
{
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(lum), color, 1.12);
    vec3 shadowTint = vec3(0.95, 0.98, 1.05);
    vec3 lightTint = vec3(1.04, 1.0, 0.95);
    color *= mix(shadowTint, lightTint, smoothstep(0.12, 0.7, lum));
    color = clamp(color, 0.0, 1.0);
    color = mix(color, color * color * (3.0 - 2.0 * color), 0.12);
    float vignette = 1.0 - 0.1 * pow(clamp(length(uv - 0.5) * 1.35, 0.0, 1.0), 2.5);
    return color * vignette;
}

void main(void)
{
    vec2 uv = v_textureCoordinates;
    vec4 source = texture(colorTexture, uv);
    vec3 color = source.rgb;

    bool sky; bool ground;
    vec3 c = eyeAt(uv, sky, ground);
    if (sky) {
        out_FragColor = vec4(grade(color, uv), source.a);
        return;
    }
    float dist = length(c);

    // --- контуры ---------------------------------------------------------------
    vec2 px = max(czm_pixelRatio, 1.0) / czm_viewport.zw;
    bool skyL; bool skyR; bool skyD; bool skyU;
    bool gL; bool gR; bool gD; bool gU;
    vec3 l = eyeAt(uv - vec2(px.x, 0.0), skyL, gL);
    vec3 r = eyeAt(uv + vec2(px.x, 0.0), skyR, gR);
    vec3 d = eyeAt(uv - vec2(0.0, px.y), skyD, gD);
    vec3 u = eyeAt(uv + vec2(0.0, px.y), skyU, gU);

    // Нормаль по более коротким касательным — они скорее лежат на той же поверхности.
    vec3 dx = length(c - l) < length(r - c) ? c - l : r - c;
    vec3 dy = length(c - d) < length(u - c) ? c - d : u - c;
    vec3 n = normalize(cross(dx, dy));

    // Размер пикселя на этом расстоянии, м: от него и пороги.
    float pixel = dist * 2.0 / (czm_projection[1][1] * czm_viewport.w) * max(czm_pixelRatio, 1.0);
    float lo = 0.55 * pixel + 0.02;
    float hi = 1.1 * pixel + 0.05;

    float edge = 0.0;
    // Силуэт на фоне неба — всегда линия.
    if (skyL || skyR || skyD || skyU) edge = 1.0;
    edge = max(edge, edgeTo(c, l, n, ground && gL, lo, hi));
    edge = max(edge, edgeTo(c, r, n, ground && gR, lo, hi));
    edge = max(edge, edgeTo(c, d, n, ground && gD, lo, hi));
    edge = max(edge, edgeTo(c, u, n, ground && gU, lo, hi));
    // Вдали линии сливаются в «грязь» — гасим их.
    edge *= 1.0 - smoothstep(900.0, 3000.0, dist);

    vec3 ink = color * 0.32 + vec3(0.025, 0.02, 0.02);
    color = mix(color, ink, edge * outlineStrength);

    // --- воздушная перспектива ---------------------------------------------------
    float haze = hazeMax * (1.0 - exp(-dist / hazeDistance));
    color = mix(color, hazeColor, haze);

    out_FragColor = vec4(grade(color, uv), source.a);
}
`;
