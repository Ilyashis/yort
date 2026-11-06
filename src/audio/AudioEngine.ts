/**
 * Звуковой движок на Web Audio: всё генерируется в браузере, без скачанных файлов.
 * Три шины — музыка, звуки города, эффекты (шаги, щелчки) — и общая «комнатная» реверберация.
 *
 * Браузеры запрещают звук без действия пользователя, поэтому AudioContext создаётся
 * и запускается при первом клике или нажатии клавиши (unlock).
 */
export class AudioEngine {
  ctx: AudioContext | undefined;
  master!: GainNode;
  music!: GainNode;
  ambience!: GainNode;
  sfx!: GainNode;
  /** Вход реверберации: отправляйте сюда часть сигнала для «объёма». */
  reverb!: GainNode;
  /** Петля белого шума — сырьё для ветра, машин, воды и шагов. */
  noise!: AudioBuffer;

  private enabled = false;
  private readonly readyCallbacks: (() => void)[] = [];

  get isRunning(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Вызывается из обработчика жеста пользователя. */
  unlock(): void {
    if (!this.ctx) this.create();
    if (this.ctx && this.ctx.state !== 'running' && this.enabled) void this.ctx.resume();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(enabled ? 1 : 0, now, 0.25);
    if (enabled && this.ctx.state !== 'running') void this.ctx.resume();
  }

  /** Колбэк сразу, если движок уже создан, иначе — после первого unlock. */
  onReady(callback: () => void): void {
    if (this.ctx) callback();
    else this.readyCallbacks.push(callback);
  }

  destroy(): void {
    void this.ctx?.close();
    this.ctx = undefined;
  }

  private create(): void {
    const AudioCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    // Мягкий лимитер: ни один слой не «выстрелит» по ушам.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 6;
    this.master.connect(limiter).connect(ctx.destination);

    this.music = this.bus(0.55);
    this.ambience = this.bus(0.9);
    this.sfx = this.bus(0.8);

    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx, 3.2);
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.9;
    this.reverb.connect(convolver).connect(this.master);

    this.noise = whiteNoise(ctx, 2);

    for (const callback of this.readyCallbacks.splice(0)) callback();
  }

  private bus(level: number): GainNode {
    const gain = this.ctx!.createGain();
    gain.gain.value = level;
    gain.connect(this.master);
    return gain;
  }
}

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/** Искусственная реверберация: стерео-шум с экспоненциальным затуханием. */
function impulseResponse(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.5);
    }
  }
  return buffer;
}

/** Нота MIDI → частота, Гц. */
export const midiToHz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);
