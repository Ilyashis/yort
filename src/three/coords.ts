// Оси: данные Citia — локальные метры (x — восток, y — север, z — вверх), three.js — «y вверх».
// Переводим так: X = x (восток), Y = z (вверх), Z = −y (на юг). Правая тройка сохраняется.

import { Vector3 } from 'three';
import type { Vec2 } from '../world/walk/localFrame';

export const toThree = (x: number, y: number, z: number, out = new Vector3()): Vector3 => out.set(x, z, -y);

/** Точка three.js → локальные метры на плоскости (x — восток, y — север). */
export const toLocal2 = (v: Vector3): Vec2 => [v.x, -v.z];
