// Ядро 3D-сцены на three.js: рендер, небо и солнце, каскадные тени, постобработка («рисованный» вид),
// кадры по запросу (рисуем, только пока что-то меняется — бережём батарею), плавные перелёты камеры
// и выбор точки на земле лучом по карте высот (быстро и точно, без перебора треугольников).

import {
  ACESFilmicToneMapping,
  Clock,
  HalfFloatType,
  MathUtils,
  PCFShadowMap, PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Material,
  type Object3D,
} from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { dateAt, DEFAULT_TIME, lightingAt, type Lighting } from './dayNight';
import { SEASON } from './shaderHooks';
import { createIllustrationPass } from './illustrationPass';
import { NIGHT } from './nightUniforms';
import { linearColor, moonDirection, SkySystem, sunDirection } from './sky';
import { LITE } from '../config/device';

/** high — с затенением в углах (AO) и контурами, normal — только тени и сглаживание. */
export type GraphicsQuality = 'high' | 'normal';
export type ViewMode = 'top' | 'tilt';

/** Кто-то в кадре (перелёт, прогулка, догрузка земли): вызывается каждый кадр; true — нужны ещё кадры. */
export type Animator = (dt: number) => boolean | void;

interface Flight {
  from: { position: Vector3; target: Vector3 };
  to: { position: Vector3; target: Vector3 };
  t: number;
  duration: number;
  done?: () => void;
}

export class CityScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly csm: CSM;
  /** Точка, вокруг которой вращается камера (у управления обзором). */
  readonly target = new Vector3();
  private readonly composer: EffectComposer;
  private readonly ao: GTAOPass;
  /** Слои, которые не участвуют в затенении углов (AO). */
  private readonly noAo = new Set<Object3D>();
  private readonly illustration: ShaderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly sky: SkySystem;
  /** Освещение текущего времени суток. */
  lighting: Lighting = lightingAt(30);
  private hours = DEFAULT_TIME;
  private winter = false;
  private blurOn = false;
  private outlinesOn = false;
  private readonly animators = new Set<Animator>();
  private readonly clock = new Clock();
  private readonly raycaster = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private flight?: Flight;
  private dirty = true;
  private frameId = 0;
  private disposed = false;
  /** Высота земли в точке three.js (x, −z); задаётся, когда загружен рельеф. */
  private groundAt: (x: number, z: number) => number = () => 0;

  constructor(
    readonly container: HTMLElement,
    /** Где солнце считать: центр района (градусы). */
    private readonly location: { lat: number; lon: number },
  ) {
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    // Телефон: экран с плотностью 3× рисуем в 1,5× — разницы почти не видно, а пикселей вчетверо меньше.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, LITE ? 1.5 : 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = LITE ? PCFShadowMap : PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.className = 'city-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(45, 1, 1, 40_000);
    this.sky = new SkySystem(this.scene, this.renderer);
    const sun = sunDirection(dateAt(DEFAULT_TIME), location.lat, location.lon);

    this.csm = new CSM({
      // Телефон: два каскада вместо четырёх и ближе — каждый каскад заново рисует сцену.
      maxFar: LITE ? 1200 : 3000,
      cascades: LITE ? 2 : 4,
      mode: 'practical',
      parent: this.scene,
      shadowMapSize: LITE ? 1024 : 2048,
      lightDirection: sun.clone().negate(),
      camera: this.camera,
      lightIntensity: 2.6,
      lightMargin: 300,
    });
    this.csm.fade = true;
    for (const light of this.csm.lights) {
      light.shadow.bias = -0.0002;
      light.shadow.normalBias = 0.6;
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.renderTarget1.texture.type = HalfFloatType;
    this.composer.renderTarget2.texture.type = HalfFloatType;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 3, distanceExponent: 1.5, thickness: 2, scale: 1.2, samples: 12 });
    this.ao.blendIntensity = 0.9;
    // Накладки (заливка участка, линии и ручки редактора, метки подложки, небо) — не поверхности сцены:
    // в буфере глубины AO они затемняли бы то, что под ними. На время расчёта AO их прячем.
    const renderAo = this.ao.render.bind(this.ao);
    this.ao.render = (...args: Parameters<GTAOPass['render']>) => {
      const overlays: Object3D[] = [];
      this.scene.traverseVisible((object) => {
        const material = (object as { material?: Material | Material[] }).material;
        if (material && isOverlay(material)) overlays.push(object);
      });
      // Трава в AO не идёт: это второй проход всей сцены — вдвое больше вызовов и треугольников. Деревья идут:
      // без них затемнение у стен дома за кроной ложилось поверх кроны.
      // Заборы и палисадники — идут (иначе затемнение у стены дома за забором ложится на забор).
      // Размытие дали и контуры берут глубину из этого же прохода — с ними деревья нужны (иначе крона на фоне
      // неба размывалась бы как небо).
      const depthNeeded = this.illustration.uniforms['blurStrength']!.value > 0 || this.illustration.uniforms['useOutlines']!.value > 0;
      const skipped = depthNeeded ? [] : [...this.noAo].filter((object) => object.visible);
      for (const object of [...overlays, ...skipped]) object.visible = false;
      try {
        renderAo(...args);
      } finally {
        for (const object of [...overlays, ...skipped]) object.visible = true;
      }
    };
    this.composer.addPass(this.ao);
    // Вечером и ночью — мягкое свечение окон, вывесок и фонарей (днём выключено).
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0, 0.35, 1.05);
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    // Контуры и цветокоррекция; глубина — из прохода AO.
    this.illustration = createIllustrationPass(this.camera, this.ao.depthTexture);
    this.composer.addPass(this.illustration);
    this.composer.addPass(new FXAAPass());

    this.setTime(DEFAULT_TIME);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Перерисовать сцену в ближайшем кадре. */
  /** Не учитывать объект (и всё в нём) в затенении углов (AO): мелочь, которая удваивает его стоимость. */
  skipAo(object: Object3D): () => void {
    this.noAo.add(object);
    return () => this.noAo.delete(object);
  }

  requestRender(): void {
    this.dirty = true;
  }

  /** Подписка на кадры; возвращает отписку. */
  addAnimator(animator: Animator): () => void {
    this.animators.add(animator);
    this.dirty = true;
    return () => this.animators.delete(animator);
  }

  setGroundSampler(heightAt: (x: number, z: number) => number): void {
    this.groundAt = heightAt;
  }

  /** Время суток (местное, часы): солнце или луна, небо, свет, окна и фонари. */
  setTime(hours: number): void {
    this.hours = hours;
    const sun = sunDirection(dateAt(hours, this.winter), this.location.lat, this.location.lon);
    const lighting = lightingAt((Math.asin(sun.y) * 180) / Math.PI);
    const moon = moonDirection(sun);
    this.sky.update(sun, moon, lighting);
    // Тени — от того, кто светит сильнее: днём солнце, ночью луна (переход — когда оба еле светят).
    const byMoon = lighting.moonIntensity > lighting.sunIntensity;
    this.csm.lightDirection.copy(byMoon ? moon : sun).negate();
    const color = linearColor(byMoon ? lighting.moonColor : lighting.sunColor);
    for (const light of this.csm.lights) {
      light.intensity = byMoon ? lighting.moonIntensity : lighting.sunIntensity;
      light.color.copy(color);
      light.castShadow = this.shadowsOn;
    }
    this.renderer.toneMappingExposure = lighting.exposure;
    NIGHT.windows.value = lighting.windows;
    NIGHT.lamps.value = lighting.lamps;
    this.bloom.strength = lighting.bloom;
    this.bloom.enabled = lighting.bloom > 0.02;
    this.lighting = lighting;
    this.requestRender();
  }

  /** Время года: зима — снег на всём, что смотрит вверх, и зимнее (низкое) солнце. */
  setSeason(winter: boolean): void {
    this.winter = winter;
    SEASON.snow.value = winter ? 1 : 0;
    this.setTime(this.hours);
  }

  get isWinter(): boolean {
    return this.winter;
  }

  get time(): number {
    return this.hours;
  }

  /** Дымка вдали: даль уходит в цвет неба у горизонта (воздушная перспектива). */
  setHaze(on: boolean): void {
    this.sky.setHaze(on);
    this.requestRender();
  }

  /** Тонкие тёмные контуры, как на рисунке (тоже по глубине прохода AO). */
  setOutlines(on: boolean): void {
    this.outlinesOn = on;
    this.illustration.uniforms['useOutlines']!.value = on && this.ao.enabled ? 1 : 0;
    this.requestRender();
  }

  /** Мягкое размытие дали (нужен буфер глубины прохода AO — только с мягкими тенями). */
  setBlur(on: boolean): void {
    this.blurOn = on;
    this.illustration.uniforms['blurStrength']!.value = on && this.ao.enabled ? 1 : 0;
    this.requestRender();
  }

  /**
   * Тени от солнца и луны. Выключены — сцена не рисуется заново для каждого каскада теней: это самая
   * тяжёлая часть кадра (на телефоне — вдвое легче).
   */
  setShadows(on: boolean): void {
    if (on === this.shadowsOn) return;
    this.shadowsOn = on;
    for (const light of this.csm.lights) light.castShadow = on;
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  private shadowsOn = true;

  setQuality(quality: GraphicsQuality): void {
    this.ao.enabled = quality === 'high';
    // Без AO нет и буфера глубины для контуров.
    this.illustration.uniforms['useOutlines']!.value = this.outlinesOn && quality === 'high' ? 1 : 0;
    this.illustration.uniforms['blurStrength']!.value = this.blurOn && quality === 'high' ? 1 : 0;
    this.requestRender();
  }

  // --- камера ---------------------------------------------------------------------------------

  /** Плавный перелёт камеры: позиция и точка, на которую смотрим (координаты three.js). */
  flyTo(position: Vector3, target: Vector3, duration = 1.2, done?: () => void): void {
    this.flight = {
      from: { position: this.camera.position.clone(), target: this.target.clone() },
      to: { position: position.clone(), target: target.clone() },
      t: 0,
      duration: Math.max(duration, 0.001),
      done,
    };
    this.requestRender();
  }

  /** Мгновенно поставить камеру. */
  setView(position: Vector3, target: Vector3): void {
    this.flight = undefined;
    this.camera.position.copy(position);
    this.target.copy(target);
    this.camera.lookAt(target);
    this.requestRender();
  }

  get flying(): boolean {
    return !!this.flight;
  }

  cancelFlight(): void {
    this.flight = undefined;
  }

  /** Позиция камеры для взгляда на target с курса heading (от севера по часовой), наклона pitch и расстояния. */
  orbitPosition(target: Vector3, headingDeg: number, pitchDeg: number, distance: number): Vector3 {
    const h = MathUtils.degToRad(headingDeg);
    const p = MathUtils.degToRad(pitchDeg);
    // Камера позади цели: смотрит по курсу heading.
    return new Vector3(
      target.x - Math.sin(h) * Math.cos(p) * distance,
      target.y + Math.sin(p) * distance,
      target.z + Math.cos(h) * Math.cos(p) * distance,
    );
  }

  /** Курс камеры (от севера по часовой), градусы. */
  heading(): number {
    const d = this.target.clone().sub(this.camera.position);
    return (MathUtils.radToDeg(Math.atan2(d.x, -d.z)) + 360) % 360;
  }

  /** Наклон взгляда вниз, градусы (90 — отвесно). */
  pitch(): number {
    const d = this.target.clone().sub(this.camera.position).normalize();
    return MathUtils.radToDeg(Math.asin(-d.y));
  }

  viewMode(): ViewMode {
    return this.pitch() > 75 ? 'top' : 'tilt';
  }

  /** Сверху или под углом вокруг той же точки, с тем же курсом и примерно тем же расстоянием. */
  changeView(mode: ViewMode): void {
    const distance = MathUtils.clamp(this.camera.position.distanceTo(this.target), 60, 6000);
    const pitch = mode === 'top' ? 89.9 : 35;
    this.flyTo(this.orbitPosition(this.target, this.heading(), pitch, distance), this.target, 0.9);
  }

  // --- выбор ----------------------------------------------------------------------------------

  /** Луч из точки экрана (координаты клиента). */
  rayAt(clientX: number, clientY: number): Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster;
  }

  /** Точка земли под курсором (three.js) — шагами по лучу над картой высот, потом делением пополам. */
  pickGround(clientX: number, clientY: number): Vector3 | undefined {
    const { ray } = this.rayAt(clientX, clientY);
    return this.groundAlong(ray.origin, ray.direction);
  }

  /** Пересечение луча с землёй (three.js). */
  groundAlong(origin: Vector3, direction: Vector3, maxDistance = 30_000): Vector3 | undefined {
    const p = new Vector3();
    const above = (t: number) => {
      p.copy(direction).multiplyScalar(t).add(origin);
      return p.y - this.groundAt(p.x, p.z);
    };
    let t0 = 0;
    let h0 = above(0);
    if (h0 < 0) return undefined;
    let t = 0;
    while (t < maxDistance) {
      const step = Math.max(0.5, h0 * 0.5);
      t = t0 + step;
      const h = above(t);
      if (h < 0) {
        let lo = t0;
        let hi = t;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (above(mid) < 0) hi = mid;
          else lo = mid;
        }
        above(hi);
        return p.clone();
      }
      t0 = t;
      h0 = h;
    }
    return undefined;
  }

  /** Ближайший объект под курсором среди objects. */
  pickObject(clientX: number, clientY: number, objects: Object3D[]): Intersection | undefined {
    return this.rayAt(clientX, clientY).intersectObjects(objects, true)[0];
  }

  // --- кадр -----------------------------------------------------------------------------------

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.csm.updateFrustums();
    this.requestRender();
  }

  private readonly loop = () => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.loop);
    this.renderFrame();
  };

  /** Один кадр (вызывается циклом; в тестах и фоновой вкладке — вручную). */
  renderFrame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    let active = false;
    for (const animator of this.animators) if (animator(dt)) active = true;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.from.position, f.to.position, k);
      this.target.lerpVectors(f.from.target, f.to.target, k);
      this.camera.lookAt(this.target);
      if (f.t >= 1) {
        this.flight = undefined;
        f.done?.();
      }
      active = true;
    }
    if (!this.dirty && !active) return;
    this.dirty = false;
    // Фокус размытия — там, куда смотрит камера (на прогулке — в паре десятков метров впереди).
    this.illustration.uniforms['focusDistance']!.value = MathUtils.clamp(this.camera.position.distanceTo(this.target), 30, 900);
    this.csm.update();
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.csm.dispose();
    this.sky.dispose();
    this.composer.dispose();
    this.scene.traverse((object) => {
      const mesh = object as { geometry?: { dispose: () => void }; material?: { dispose: () => void } | { dispose: () => void }[] };
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Прозрачное или неосвещаемое (линии, точки, подписи, небо) — не поверхность для AO и контуров. */
function isOverlay(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((m) => m.transparent || !('roughness' in m));
}
