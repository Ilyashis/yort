import { Cartesian3, Cartesian4, Matrix4, PerInstanceColorAppearance, Transforms } from 'cesium';

/**
 * Разбиение double на high/low так же, как Cesium кодирует position3DHigh/Low
 * (EncodedCartesian3 не входит в публичное API): high кратен 65536.
 */
function encode(value: number): [high: number, low: number] {
  const high = Math.floor(Math.abs(value) / 65536) * 65536 * Math.sign(value);
  return [high, value - high];
}

function encodeCartesian(c: Cartesian3): { high: Cartesian3; low: Cartesian3 } {
  const [hx, lx] = encode(c.x);
  const [hy, ly] = encode(c.y);
  const [hz, lz] = encode(c.z);
  return { high: new Cartesian3(hx, hy, hz), low: new Cartesian3(lx, ly, lz) };
}

/**
 * Внешний вид зданий: цвет фасада из атрибута color + процедурные детали.
 *
 * Атрибуты каждого здания:
 *  - `facade` = (земля, низ, верх, высота этажа), м; высота этажа 0 — без окон;
 *  - `facadeStyle` = (витрины 0/1, тип окон 0..2, зерно 0..1, —).
 *
 * В шейдере точка переводится в локальные метры (восток, север, вверх) относительно
 * центра района: так окна ложатся ровными рядами без текстур и без потери точности.
 * Детали: цоколь, карниз, межэтажные тяги, окна с рамами и разным оттенком стёкол
 * (иногда — шторы), на первых этажах вдоль улиц — витрины и цветные вывески.
 */
export function createBuildingAppearance(center: Cartesian3): PerInstanceColorAppearance {
  const encoded = encodeCartesian(center);
  const enu = Transforms.eastNorthUpToFixedFrame(center);
  const east = Matrix4.getColumn(enu, 0, new Cartesian4());
  const north = Matrix4.getColumn(enu, 1, new Cartesian4());
  const up = Matrix4.getColumn(enu, 2, new Cartesian4());

  const f = (n: number) => {
    const s = String(n);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  };
  const vec3 = (c: Cartesian3) => `vec3(${f(c.x)}, ${f(c.y)}, ${f(c.z)})`;
  // Столбцы mat3 подобраны так, что TO_ENU * v = (east·v, north·v, up·v).
  const toEnu = `mat3(${[east.x, north.x, up.x, east.y, north.y, up.y, east.z, north.z, up.z].map(f).join(', ')})`;

  const vertexShaderSource = /* glsl */ `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec4 color;
in float batchId;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec4 v_color;
out vec3 v_local;
out vec3 v_normalLocal;
out vec4 v_facade;
out vec4 v_style;

const vec3 CENTER_HIGH = ${vec3(encoded.high)};
const vec3 CENTER_LOW = ${vec3(encoded.low)};
const mat3 TO_ENU = ${toEnu};

void main()
{
    vec4 p = czm_computePosition();
    v_positionEC = (czm_modelViewRelativeToEye * p).xyz;
    v_normalEC = czm_normal * normal;
    v_color = color;
    v_local = TO_ENU * ((position3DHigh - CENTER_HIGH) + (position3DLow - CENTER_LOW));
    v_normalLocal = TO_ENU * normal;
    v_facade = czm_batchTable_facade(batchId);
    v_style = czm_batchTable_facadeStyle(batchId);
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

  const fragmentShaderSource = /* glsl */ `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec4 v_color;
in vec3 v_local;
in vec3 v_normalLocal;
in vec4 v_facade;
in vec4 v_style;

// 1 внутри полосы [lo, hi] периода t, края смягчены по размеру пикселя.
float band(float t, float lo, float hi)
{
    float x = fract(t);
    float w = max(fwidth(t), 1e-4);
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
}

float hash12(vec2 p)
{
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

// Цвета вывесок: насыщенные, но не кислотные.
vec3 signColor(float h)
{
    return 0.5 + 0.38 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67)));
}

void main()
{
    vec3 positionToEyeEC = -v_positionEC;
    vec3 normalEC = normalize(v_normalEC);
    vec4 base = czm_gammaCorrect(v_color);
    vec3 diffuse = base.rgb;
    float specular = 0.0;
    float shininess = 1.0;

    vec3 n = normalize(v_normalLocal);
    float ground = v_facade.x;
    float bottom = v_facade.y;
    float top = v_facade.z;
    float floorHeight = v_facade.w;
    // facadeStyle.x: 0 — обычные окна, 1 — витрины на первом этаже, 2 — деревенский дом с наличниками.
    bool hasShops = v_style.x > 0.5 && v_style.x < 1.5;
    bool carved = v_style.x > 1.5;
    float variant = v_style.y;
    float seed = v_style.z;

    if (abs(n.z) > 0.5) {
        // Плоская крыша и днище: тёплый светло-серый рубероид, у каждого дома свой оттенок.
        // Скатные крыши и купола приходят уже со своим цветом (facadeStyle.w = 1) — их не трогаем.
        if (v_style.w < 0.5) {
            vec3 roof = mix(vec3(0.63, 0.59, 0.54), vec3(0.47, 0.46, 0.45), seed);
            diffuse = mix(diffuse, roof, 0.7);
        }
    } else {
        float h = v_local.z - ground;

        // Цоколь и карниз — тёмные полосы внизу и вверху стены.
        diffuse *= 1.0 - 0.25 * (1.0 - smoothstep(0.45, 0.55, h - bottom));
        diffuse *= 1.0 - 0.18 * smoothstep(top - 0.55, top - 0.45, h);

        if (floorHeight > 0.0) {
            vec2 tangent = normalize(vec2(-n.y, n.x));
            float along = dot(v_local.xy, tangent);
            float floors = h / floorHeight;
            bool shopFloor = hasShops && h < floorHeight;

            // Тип окон: шаг по горизонтали и границы стекла (низ, верх, лево, право) в долях ячейки.
            // Шаги и ширины продублированы в windowGrid (facades.ts) — по ним стоят двери и балконы.
            float bay = 3.0;
            vec4 win = vec4(0.30, 0.76, 0.22, 0.78);
            if (variant > 1.5) { bay = 3.4; win = vec4(0.36, 0.72, 0.10, 0.90); }      // ленточные
            else if (variant > 0.5) { bay = 2.6; win = vec4(0.20, 0.80, 0.30, 0.70); } // высокие узкие
            if (shopFloor) { bay = 4.5; win = vec4(0.06, 0.78, 0.06, 0.94); }        // витрины
            if (carved) { bay = 2.6; win = vec4(0.30, 0.74, 0.34, 0.66); }           // окна избы

            float bays = along / bay;
            float inside = (1.0 - step(top - 0.9, h)) * (shopFloor ? 1.0 : step(bottom + 0.8, h));
            float outer = band(floors, win.x, win.y) * band(bays, win.z, win.w) * inside;
            float inner = band(floors, win.x + 0.035, win.y - 0.035) * band(bays, win.z + 0.03, win.w - 0.03) * inside;

            // Издалека окна мельче пикселя — усредняем, чтобы не было муара.
            float tiny = smoothstep(0.2, 0.5, fwidth(floors) + fwidth(bays));

            float cell = hash12(vec2(floor(floors), floor(bays)) + seed * 97.0);
            vec3 viewDir = normalize(positionToEyeEC);
            float fresnel = pow(1.0 - abs(dot(normalEC, viewDir)), 3.0);
            vec3 glass = mix(vec3(0.12, 0.16, 0.21), vec3(0.60, 0.71, 0.83), 0.12 + 0.6 * fresnel);
            glass *= 0.8 + 0.4 * cell;
            if (!shopFloor && cell > 0.82) glass = mix(glass, vec3(0.80, 0.72, 0.56), 0.35); // шторы
            if (shopFloor) glass = mix(glass, vec3(0.32, 0.35, 0.38), 0.3);
            vec3 frameColor = shopFloor ? vec3(0.17, 0.18, 0.20) : vec3(0.88, 0.87, 0.84);

            if (carved) {
                // Бревенчатая стена: тонкие тёмные швы между венцами (только у «деревянных» цветов).
                float woody = step(base.b + 0.05, base.g) * step(base.g + 0.03, base.r) * (1.0 - step(0.5, dot(base.rgb, vec3(0.333))));
                diffuse *= 1.0 - 0.14 * woody * band(h / 0.26, 0.0, 0.14) * (1.0 - tiny);

                // Ставни по бокам окна — у каждого дома свой цвет.
                float pick = fract(seed * 13.0);
                vec3 shutterColor = pick < 0.3 ? vec3(0.30, 0.46, 0.68)
                    : pick < 0.55 ? vec3(0.30, 0.52, 0.36)
                    : pick < 0.8 ? vec3(0.50, 0.30, 0.19)
                    : vec3(0.56, 0.22, 0.18);
                float rows = band(floors, win.x, win.y) * inside;
                float shutters = (band(bays, win.z - 0.21, win.z - 0.05) + band(bays, win.w + 0.05, win.w + 0.21)) * rows;
                diffuse = mix(diffuse, shutterColor, shutters * (1.0 - tiny));

                // Наличник: широкая рамка, сверху выше («кокошник»); белый или голубой.
                frameColor = fract(seed * 7.0) > 0.6 ? vec3(0.62, 0.77, 0.88) : vec3(0.94, 0.93, 0.89);
                outer = band(floors, win.x - 0.05, win.y + 0.1) * band(bays, win.z - 0.05, win.w + 0.05) * inside;
            }

            float glassAmount = mix(inner, 0.2 * inside, tiny);
            diffuse = mix(diffuse, frameColor, clamp(outer - inner, 0.0, 1.0) * (1.0 - tiny));
            diffuse = mix(diffuse, glass, glassAmount);

            // Межэтажная тяга — едва заметная тёмная полоса (выше первого этажа).
            float ledge = band(floors, 0.0, 0.05) * inside * (1.0 - tiny) * step(floorHeight, h);
            diffuse *= 1.0 - 0.12 * ledge;

            // Вывески над витринами: свой цвет у каждого «магазина» (участка фасада ~9 м).
            if (hasShops) {
                float signBand = band(floors, 0.82, 0.96) * (1.0 - step(floorHeight, h));
                float shopCell = hash12(vec2(floor(along / 9.0), seed * 31.0));
                diffuse = mix(diffuse, signColor(shopCell), signBand * step(0.25, shopCell) * (1.0 - tiny));
            }

            specular = 0.35 * glassAmount;
            shininess = 40.0;
        }
    }

    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = positionToEyeEC;
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = diffuse;
    material.specular = specular;
    material.shininess = shininess;
    material.alpha = base.a;

    out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
}
`;

  return new PerInstanceColorAppearance({
    closed: true,
    translucent: false,
    vertexShaderSource,
    fragmentShaderSource,
  });
}
