import { describe, expect, it } from 'vitest';
import { findHouseModel, MODEL_ENTRANCE, type HouseModelId } from './houseModels';
import { repaintParts } from './houseParts';

const glass = (parts: { type: string }[]) => parts.filter((p) => p.type === 'glass').length;

describe('крыльцо, веранда и цвета модели', () => {
  for (const [id, entrance] of Object.entries(MODEL_ENTRANCE) as [HouseModelId, NonNullable<(typeof MODEL_ENTRANCE)[HouseModelId]>][]) {
    const model = findHouseModel(id)!;
    it(`${id}: без крыльца — меньше деталей`, () => {
      const base = model.plan({ seed: 2 });
      const bare = model.plan({ seed: 2, porch: false });
      expect(bare.parts.length).toBeLessThan(base.parts.length);
    });
    if (entrance.veranda !== undefined) {
      it(`${id}: веранда добавляет застеклённую пристройку`, () => {
        const without = model.plan({ seed: 2, veranda: false });
        const withIt = model.plan({ seed: 2, veranda: true });
        expect(glass(withIt.parts)).toBeGreaterThan(glass(without.parts) + 4);
        // Веранда — сбоку, со стороны входа.
        const xs = withIt.parts.filter((p) => p.type === 'glass').map((p) => ('center' in p ? p.center[0] : 0));
        const outside = xs.filter((x) => Math.abs(x) > withIt.width / 2 + 0.6);
        expect(outside.length).toBeGreaterThan(4);
        expect(outside.every((x) => (entrance.side === 'right' ? x > 0 : x < 0))).toBe(true);
      });
    }
  }

  it('перекраска меняет стены и кровлю, оттенки сохраняются', () => {
    const plan = findHouseModel('hipped')!.plan({ seed: 2 });
    const parts = repaintParts(plan.parts, { wall: '#3366aa', roof: '#aa3333' });
    const walls = parts.filter((p) => 'paint' in p && p.paint?.role === 'wall');
    const roofs = parts.filter((p) => 'paint' in p && p.paint?.role === 'roof');
    expect(walls.length).toBeGreaterThan(0);
    expect(roofs.length).toBeGreaterThan(0);
    expect(walls.some((p) => p.type !== 'glass' && p.type !== 'sign' && 'color' in p && p.color.toLowerCase() === '#3366aa')).toBe(true);
    expect(roofs.some((p) => 'color' in p && p.color.toLowerCase() === '#aa3333')).toBe(true);
  });
});
