import { describe, expect, it } from 'vitest';
import { formatTime, lightingAt, ramp, sunElevationAt } from './dayNight';

const elevationAt = (hours: number) => sunElevationAt(hours, 54.72, 55.94);

describe('время суток', () => {
  it('солнце над Уфой 15 июля: полдень высоко, полночь — неглубоко под горизонтом', () => {
    expect(elevationAt(13.5)).toBeGreaterThan(54);
    expect(elevationAt(13.5)).toBeLessThan(59);
    expect(elevationAt(1.5)).toBeLessThan(-11);
    expect(elevationAt(1.5)).toBeGreaterThan(-16);
    // Полдень по солнцу ~13:20 (Уфа западнее середины пояса UTC+5): закат ~21:50, восход ~4:55.
    expect(elevationAt(21.5)).toBeGreaterThan(0);
    expect(elevationAt(22.2)).toBeLessThan(0);
    expect(elevationAt(4.6)).toBeLessThan(0);
    expect(elevationAt(5.3)).toBeGreaterThan(0);
  });

  it('днём — солнце, без окон и звёзд; ночью — луна, окна, фонари, звёзды', () => {
    const day = lightingAt(40);
    expect(day.sunIntensity).toBeCloseTo(2.6, 5);
    expect(day.night).toBe(0);
    expect(day.windows).toBe(0);
    expect(day.stars).toBe(0);
    const night = lightingAt(-14);
    expect(night.sunIntensity).toBe(0);
    expect(night.moonIntensity).toBeGreaterThan(0.3);
    expect(night.night).toBe(1);
    expect(night.windows).toBe(1);
    expect(night.lamps).toBe(1);
    expect(night.stars).toBe(1);
    expect(night.exposure).toBeGreaterThan(day.exposure);
  });

  it('на закате солнце оранжевое, окна начинают зажигаться', () => {
    const sunset = lightingAt(1);
    expect(sunset.sunColor[2]).toBeLessThan(lightingAt(40).sunColor[2]);
    expect(sunset.windows).toBeGreaterThan(0.2);
    expect(sunset.windows).toBeLessThan(0.8);
  });

  it('свет меняется плавно, без скачков', () => {
    let previous = lightingAt(50);
    for (let e = 50; e >= -20; e -= 0.5) {
      const now = lightingAt(e);
      expect(Math.abs(now.sunIntensity - previous.sunIntensity)).toBeLessThan(0.25);
      expect(Math.abs(now.night - previous.night)).toBeLessThan(0.1);
      previous = now;
    }
    expect(ramp(0, 10, 5)).toBeCloseTo(0.5, 6);
    expect(ramp(10, 0, 5)).toBeCloseTo(0.5, 6);
  });

  it('время по-человечески', () => {
    expect(formatTime(17.5)).toBe('17:30');
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(23.99)).toBe('23:59');
    expect(formatTime(24.25)).toBe('0:15');
  });
});
