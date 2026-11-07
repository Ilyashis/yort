// Сетка из поля расстояний методом surface nets: по вершине в каждой ячейке, через которую
// проходит поверхность (среднее точек пересечения рёбер), и по четырёхугольнику на каждое
// пересечённое ребро решётки. Без таблиц marching cubes, сетка ровная и замкнутая.

/**
 * @param {(x: number, y: number, z: number) => number} field поле расстояний
 * @param {{ min: number[], max: number[] }} box область
 * @param {number} step шаг решётки
 * @returns {{ positions: Float32Array, indices: Uint32Array }}
 */
export function surfaceNets(field, box, step) {
  const n = [0, 1, 2].map((k) => Math.ceil((box.max[k] - box.min[k]) / step) + 1);
  const [nx, ny, nz] = n;
  const at = (i, j, k) => i + nx * (j + ny * k);
  const values = sample(field, box, step, n);

  // Вершины: по одной на ячейку с разными знаками в углах.
  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const positions = [];
  const corners = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const v = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = corners[c];
          v[c] = values[at(i + di, j + dj, k + dk)];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let count = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          const ca = corners[a];
          const cb = corners[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          count++;
        }
        cellVertex[cellAt(i, j, k)] = positions.length / 3;
        positions.push(
          box.min[0] + (i + sx / count) * step,
          box.min[1] + (j + sy / count) * step,
          box.min[2] + (k + sz / count) * step,
        );
      }
    }
  }

  // Грани: на каждое ребро решётки со сменой знака — четырёхугольник из четырёх соседних ячеек.
  const indices = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const v0 = values[at(i, j, k)] < 0;
        // ребро вдоль x
        if (v0 !== values[at(i + 1, j, k)] < 0) {
          quad(cellVertex[cellAt(i, j - 1, k - 1)], cellVertex[cellAt(i, j, k - 1)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i, j - 1, k)], !v0);
        }
        // ребро вдоль y
        if (v0 !== values[at(i, j + 1, k)] < 0) {
          quad(cellVertex[cellAt(i - 1, j, k - 1)], cellVertex[cellAt(i - 1, j, k)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i, j, k - 1)], !v0);
        }
        // ребро вдоль z
        if (v0 !== values[at(i, j, k + 1)] < 0) {
          quad(cellVertex[cellAt(i - 1, j - 1, k)], cellVertex[cellAt(i, j - 1, k)], cellVertex[cellAt(i, j, k)], cellVertex[cellAt(i - 1, j, k)], !v0);
        }
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Значения поля в узлах решётки. Блоками 8³: если в центре блока поверхность дальше половины
 * его диагонали, весь блок одного знака — считаем одно значение вместо 512.
 */
function sample(field, box, step, [nx, ny, nz]) {
  const values = new Float32Array(nx * ny * nz);
  const B = 8;
  const half = (Math.sqrt(3) * B * step) / 2;
  for (let bk = 0; bk < nz; bk += B) {
    for (let bj = 0; bj < ny; bj += B) {
      for (let bi = 0; bi < nx; bi += B) {
        const ci = Math.min(bi + B / 2, nx - 1);
        const cj = Math.min(bj + B / 2, ny - 1);
        const ck = Math.min(bk + B / 2, nz - 1);
        const d = field(box.min[0] + ci * step, box.min[1] + cj * step, box.min[2] + ck * step);
        const far = Math.abs(d) > half + step;
        for (let k = bk; k < Math.min(bk + B, nz); k++) {
          for (let j = bj; j < Math.min(bj + B, ny); j++) {
            for (let i = bi; i < Math.min(bi + B, nx); i++) {
              values[i + nx * (j + ny * k)] = far ? d : field(box.min[0] + i * step, box.min[1] + j * step, box.min[2] + k * step);
            }
          }
        }
      }
    }
  }
  return values;
}
