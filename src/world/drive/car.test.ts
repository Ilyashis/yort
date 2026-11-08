import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { CAR, angleDelta, bodyCircles, engineState, snapToRoad, stepCar, steerLimit, wheelSpots, type CarInput, type CarState, type Road } from './car';

const idle: CarInput = { throttle: 0, steer: 0, handbrake: false, fast: false };
const start = (speed = 0, heading = 0): CarState => ({ position: [0, 0], heading, speed, steer: 0 });

/** Прогнать физику seconds секунд с шагом 1/60. */
function drive(state: CarState, input: CarInput, seconds: number, road?: Road): CarState {
  let s = state;
  for (let t = 0; t < seconds; t += 1 / 60) s = stepCar(s, input, 1 / 60, road);
  return s;
}

describe('физика машины', () => {
  it('разгоняется до предела и не быстрее; с Shift — быстрее', () => {
    const normal = drive(start(), { ...idle, throttle: 1 }, 30);
    expect(normal.speed).toBeGreaterThan(CAR.maxSpeed * 0.9);
    expect(normal.speed).toBeLessThanOrEqual(CAR.maxSpeed);
    const fast = drive(start(), { ...idle, throttle: 1, fast: true }, 40);
    expect(fast.speed).toBeGreaterThan(CAR.maxSpeed * 1.2);
    // До 60 км/ч — секунд за 5–9, как у обычной легковушки.
    const fiveSeconds = drive(start(), { ...idle, throttle: 1 }, 5);
    expect(fiveSeconds.speed).toBeGreaterThan(10);
    expect(fiveSeconds.speed).toBeLessThan(CAR.maxSpeed);
  });

  it('едет туда, куда смотрит: курс 90° — на восток', () => {
    const s = drive(start(10, Math.PI / 2), { ...idle, throttle: 1 }, 1);
    expect(s.position[0]).toBeGreaterThan(9);
    expect(Math.abs(s.position[1])).toBeLessThan(1e-6);
  });

  it('без газа катится и останавливается, стоящая — стоит', () => {
    const rolled = drive(start(10), idle, 60);
    expect(rolled.speed).toBe(0);
    expect(rolled.position[1]).toBeGreaterThan(30);
    const parked = drive(start(), idle, 5, { slope: 0.15, grip: 1 });
    expect(parked.position).toEqual([0, 0]);
  });

  it('тормоз останавливает, а не уводит сразу назад; потом — задний ход не быстрее предела', () => {
    let s = drive(start(15), { ...idle, throttle: -1 }, 1);
    expect(s.speed).toBeGreaterThan(0);
    s = drive(s, { ...idle, throttle: -1 }, 1.5);
    expect(s.speed).toBeLessThanOrEqual(0);
    s = drive(s, { ...idle, throttle: -1 }, 20);
    expect(s.speed).toBeLessThan(-CAR.reverseSpeed * 0.8);
    expect(s.speed).toBeGreaterThanOrEqual(-CAR.reverseSpeed);
  });

  it('ручник тормозит сильнее наката', () => {
    const coast = drive(start(12), idle, 1);
    const hand = drive(start(12), { ...idle, handbrake: true }, 1);
    expect(hand.speed).toBeLessThan(coast.speed - 5);
  });

  it('в гору разгоняется хуже, по траве медленнее', () => {
    const flat = drive(start(), { ...idle, throttle: 1 }, 6);
    const hill = drive(start(), { ...idle, throttle: 1 }, 6, { slope: 0.12, grip: 1 });
    const grass = drive(start(), { ...idle, throttle: 1 }, 30, { slope: 0, grip: 0.6 });
    expect(hill.speed).toBeLessThan(flat.speed - 2);
    expect(grass.speed).toBeLessThanOrEqual(CAR.maxSpeed * 0.6);
  });

  it('руль вправо — поворачивает по часовой; на скорости — плавнее', () => {
    const slow = drive(start(5), { ...idle, throttle: 0.3, steer: 1 }, 1);
    expect(slow.heading).toBeGreaterThan(0.3);
    const left = drive(start(5), { ...idle, throttle: 0.3, steer: -1 }, 1);
    expect(left.heading).toBeLessThan(-0.3);
    expect(steerLimit(20)).toBeLessThan(steerLimit(5));
    // Боковое ускорение на полном руле не выше сцепления.
    for (const v of [5, 10, 15, 20, 25]) {
      expect((v * v * Math.tan(steerLimit(v))) / CAR.wheelbase).toBeLessThanOrEqual(CAR.grip + 1e-9);
    }
    // На месте руль крутится, но машина не поворачивается.
    const standing = drive(start(), { ...idle, steer: 1 }, 1);
    expect(standing.heading).toBe(0);
    expect(standing.steer).toBeGreaterThan(0.5);
  });

  it('колёса и круги кузова — вокруг центра по курсу', () => {
    const [fl, fr, rl, rr] = wheelSpots([0, 0], 0);
    expect(fl[1]).toBeCloseTo(CAR.wheelbase / 2, 9);
    expect(fl[0]).toBeCloseTo(-CAR.track / 2, 9);
    expect(fr[0]).toBeCloseTo(CAR.track / 2, 9);
    expect(rl[1]).toBeCloseTo(-CAR.wheelbase / 2, 9);
    expect(rr[0]).toBeCloseTo(CAR.track / 2, 9);
    const circles = bodyCircles([10, 0], Math.PI / 2);
    expect(circles.map((c) => c[0])).toEqual([10 + CAR.circleOffsets[0], 10, 10 + CAR.circleOffsets[2]]);
  });

  it('передачи и обороты: растут со скоростью, на переключении падают', () => {
    expect(engineState(0, 0).gear).toBe('N');
    expect(engineState(-2, -1).gear).toBe('R');
    expect(engineState(3, 1).gear).toBe('1');
    expect(engineState(16, 1).gear).toBe('4');
    expect(engineState(4.9, 1).rpm).toBeGreaterThan(engineState(5.1, 1).rpm);
    expect(engineState(25.9, 1).rpm).toBeLessThanOrEqual(1);
  });

  it('angleDelta — кратчайший угол', () => {
    expect(angleDelta(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2, 9);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(-0.2, 9);
  });
});

describe('машина на дорогу', () => {
  const street: Vec2[] = [
    [-100, 0],
    [100, 0],
  ];

  it('встаёт на ось ближайшей дороги по направлению взгляда, на правую полосу', () => {
    const east = snapToRoad([10, 7], [{ coords: street, width: 12 }], Math.PI / 2 - 0.3)!;
    expect(east.heading).toBeCloseTo(Math.PI / 2, 9);
    expect(east.position[0]).toBeCloseTo(10, 9);
    expect(east.position[1]).toBeCloseTo(-3, 9); // правее по ходу на восток — южнее
    const west = snapToRoad([10, 7], [{ coords: street, width: 12 }], -Math.PI / 2)!;
    expect(Math.abs(west.heading)).toBeCloseTo(Math.PI / 2, 9);
    expect(west.heading).toBeLessThan(0);
    expect(west.position[1]).toBeCloseTo(3, 9);
  });

  it('узкая деревенская улица — по оси; односторонняя — только по направлению движения', () => {
    const narrow = snapToRoad([0, 2], [{ coords: street, width: 4.5 }], 0)!;
    expect(narrow.position).toEqual([0, 0]);
    const oneway = snapToRoad([0, 2], [{ coords: street, width: 12, oneway: true }], -Math.PI / 2)!;
    expect(oneway.heading).toBeCloseTo(Math.PI / 2, 9);
    expect(oneway.position[1]).toBeCloseTo(0, 9);
  });

  it('далеко от дорог — не ставит', () => {
    expect(snapToRoad([0, 80], [{ coords: street, width: 6 }], 0)).toBeUndefined();
  });
});
