import { describe, expect, it } from 'vitest';
import { treeRow } from './snapLine';

describe('аллея деревьев', () => {
  it('деревья через ровный шаг вдоль ломаной', () => {
    const spots = treeRow(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      5,
    );
    expect(spots).toEqual([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
    ]);
  });

  it('одна точка — одно дерево', () => {
    expect(treeRow([[3, 4]], 5)).toEqual([[3, 4]]);
  });
});
