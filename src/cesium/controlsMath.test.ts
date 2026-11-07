import { describe, expect, it } from 'vitest';
import { OVERVIEW_KEYS, WALK_KEYS, approach, axesFrom, isShift, panSpeed } from './controlsMath';

describe('axesFrom', () => {
  it('складывает нажатые клавиши в оси и ограничивает их ±1', () => {
    expect(axesFrom(['KeyW', 'KeyD'], OVERVIEW_KEYS)).toEqual({ forward: 1, right: 1, turn: 0, zoom: 0 });
    // W и стрелка вверх вместе не дают двойной скорости, W + S гасят друг друга.
    expect(axesFrom(['KeyW', 'ArrowUp'], OVERVIEW_KEYS).forward).toBe(1);
    expect(axesFrom(['KeyW', 'KeyS'], OVERVIEW_KEYS).forward).toBe(0);
    expect(axesFrom(['KeyQ', 'KeyR'], OVERVIEW_KEYS)).toEqual({ forward: 0, right: 0, turn: -1, zoom: 1 });
  });

  it('на прогулке стрелки ←/→ поворачивают, а A/D шагают вбок', () => {
    expect(axesFrom(['ArrowLeft'], WALK_KEYS)).toEqual({ forward: 0, right: 0, turn: -1, zoom: 0 });
    expect(axesFrom(['KeyD'], WALK_KEYS)).toEqual({ forward: 0, right: 1, turn: 0, zoom: 0 });
  });

  it('игнорирует посторонние клавиши', () => {
    expect(axesFrom(['KeyZ', 'Space'], OVERVIEW_KEYS)).toEqual({ forward: 0, right: 0, turn: 0, zoom: 0 });
  });
});

describe('panSpeed', () => {
  it('растёт с высотой, но в разумных пределах, Shift — втрое быстрее', () => {
    expect(panSpeed(5, false)).toBe(12);
    expect(panSpeed(300, false)).toBeCloseTo(270, 5);
    expect(panSpeed(1_000_000, false)).toBe(2500);
    expect(panSpeed(300, true)).toBeCloseTo(810, 5);
  });
});

describe('approach', () => {
  it('плавно догоняет цель независимо от частоты кадров', () => {
    const oneStep = approach(0, 10, 0.1, 9);
    let twoSteps = approach(0, 10, 0.05, 9);
    twoSteps = approach(twoSteps, 10, 0.05, 9);
    expect(oneStep).toBeCloseTo(twoSteps, 10);
    expect(oneStep).toBeGreaterThan(5);
    expect(oneStep).toBeLessThan(10);
    expect(approach(3, 10, 5, 9)).toBeCloseTo(10, 5);
  });
});

describe('isShift', () => {
  it('узнаёт левый и правый Shift', () => {
    expect(isShift(new Set(['ShiftRight']))).toBe(true);
    expect(isShift(new Set(['KeyW']))).toBe(false);
  });
});
