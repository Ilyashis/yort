// Минимальная запись GLB (glTF 2.0, один меш, один материал): позиции, нормали, цвет вершин, индексы.

/**
 * @param {{ positions: Float32Array, normals: Float32Array, colors: Uint8Array, indices: Uint32Array,
 *   material: { name: string, metallicFactor: number, roughnessFactor: number }, generator: string }} mesh
 * @returns {Buffer}
 */
export function writeGlb({ positions, normals, colors, indices, material, generator }) {
  const views = [
    { data: Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), target: 34962 },
    { data: Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength), target: 34962 },
    { data: Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength), target: 34962 },
    { data: Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength), target: 34963 },
  ];
  let offset = 0;
  const bufferViews = views.map(({ data, target }) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: data.length, target };
    offset += align4(data.length);
    return view;
  });
  const count = positions.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'statue' }],
    meshes: [{ name: 'statue', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [
      {
        name: material.name,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: material.metallicFactor,
          roughnessFactor: material.roughnessFactor,
        },
      },
    ],
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, normalized: true, count, type: 'VEC4' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
  };
  const bin = Buffer.concat(views.map(({ data }) => pad(data, 0)));
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const body = Buffer.concat([chunk(jsonChunk, 0x4e4f534a), chunk(bin, 0x004e4942)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

const align4 = (n) => Math.ceil(n / 4) * 4;

function pad(buffer, byte) {
  return Buffer.concat([buffer, Buffer.alloc(align4(buffer.length) - buffer.length, byte)]);
}

function chunk(data, type) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data]);
}
