import { describe, expect, it } from 'vitest';
import { HOUSE_MODELS } from './houseModels';
import { platePlacement } from './addressPlate';

describe('адресная табличка на доме', () => {
  it('у каждой модели — на уличном фасаде, у правого угла, перед стеной', () => {
    for (const model of HOUSE_MODELS.filter((m) => m.group !== 'small')) {
      const w = model.width.value, d = model.depth.value;
      const plan = model.plan({ seed: 3, width: w, depth: d });
      const at = platePlacement(plan.parts, plan.width, plan.depth);
      expect(at.x, model.id).toBeGreaterThan(0);
      expect(at.x, model.id).toBeLessThan(plan.width / 2);
      expect(at.y, model.id).toBeLessThan(0);
      expect(at.y, model.id).toBeGreaterThan(-plan.depth / 2 - 0.35);
      expect(at.z, model.id).toBeLessThan(plan.height);
    }
  });
});
