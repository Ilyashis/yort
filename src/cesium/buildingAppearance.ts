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
 * Внешний вид зданий: цвет фасада из атрибута color + процедурные окна по этажам.
 *
 * Каждому зданию передаётся атрибут `facade` = (земля, низ, верх, высота этажа), м.
 * В шейдере точка переводится в локальные метры (восток, север, вверх) относительно
 * центра района: так окна ложатся ровными рядами без текстур и без потери точности.
 * Высота этажа 0 — здание без окон (гаражи, навесы).
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

const float BAY = 3.0; // шаг окон по горизонтали, м

// 1 внутри полосы [lo, hi] периода t, края смягчены по размеру пикселя.
float band(float t, float lo, float hi)
{
    float x = fract(t);
    float w = max(fwidth(t), 1e-4);
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
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

    if (abs(n.z) > 0.5) {
        // Крыша и днище: темнее и холоднее фасада.
        diffuse = mix(diffuse, vec3(0.40, 0.42, 0.45), 0.6);
    } else if (floorHeight > 0.0) {
        float h = v_local.z - ground;
        vec2 tangent = normalize(vec2(-n.y, n.x));
        float along = dot(v_local.xy, tangent);
        float floors = h / floorHeight;
        float bays = along / BAY;

        float inside = step(bottom + 0.8, h) * (1.0 - step(top - 0.9, h));
        float window = band(floors, 0.30, 0.76) * band(bays, 0.22, 0.78) * inside;
        // Издалека окна мельче пикселя — усредняем, чтобы не было муара.
        float tiny = smoothstep(0.2, 0.5, fwidth(floors) + fwidth(bays));
        window = mix(window, 0.22 * inside, tiny);
        // Межэтажная тяга — едва заметная тёмная полоса.
        float ledge = band(floors, 0.0, 0.05) * inside * (1.0 - tiny);
        diffuse *= 1.0 - 0.12 * ledge;

        vec3 viewDir = normalize(positionToEyeEC);
        float fresnel = pow(1.0 - abs(dot(normalEC, viewDir)), 3.0);
        vec3 glass = mix(vec3(0.12, 0.16, 0.21), vec3(0.60, 0.71, 0.83), 0.12 + 0.6 * fresnel);
        diffuse = mix(diffuse, glass, window);
        specular = 0.35 * window;
        shininess = 40.0;
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
