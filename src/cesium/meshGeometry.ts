import {
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  PrimitiveType,
} from 'cesium';

/**
 * Геометрия Cesium из треугольников в мировых координатах, с «плоскими» нормалями по граням —
 * скаты крыш освещаются каждый по-своему. Порядок вершин задаёт лицевую сторону.
 * Такие Geometry можно класть только в Primitive с asynchronous: false.
 */
export function meshFromTriangles(triangles: readonly (readonly [Cartesian3, Cartesian3, Cartesian3])[]): Geometry {
  const positions = new Float64Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  const u = new Cartesian3();
  const v = new Cartesian3();
  const n = new Cartesian3();
  triangles.forEach(([a, b, c], t) => {
    Cartesian3.subtract(b, a, u);
    Cartesian3.subtract(c, a, v);
    Cartesian3.cross(u, v, n);
    if (Cartesian3.magnitudeSquared(n) > 0) Cartesian3.normalize(n, n);
    [a, b, c].forEach((p, k) => {
      const i = t * 9 + k * 3;
      positions[i] = p.x;
      positions[i + 1] = p.y;
      positions[i + 2] = p.z;
      normals[i] = n.x;
      normals[i + 1] = n.y;
      normals[i + 2] = n.z;
    });
  });

  // В типах конструктор GeometryAttributes без аргументов — заполняем поля после создания.
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  });
  attributes.normal = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: normals,
  });
  const vertexCount = triangles.length * 3;
  return new Geometry({
    attributes,
    indices: vertexCount > 65535 ? new Uint32Array(vertexCount).map((_, i) => i) : new Uint16Array(vertexCount).map((_, i) => i),
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(positions)),
  });
}
