import { ShowGeometryInstanceAttribute, type Primitive, type Scene } from 'cesium';
import { pointsInsideAreas } from '../world/base/hiding';
import type { LonLat } from '../world/user/plot';

/**
 * Скрытие отдельных объектов внутри общего Primitive (деревья, фонари, скамейки),
 * когда на их месте появляется здание пользователя. У инстансов должен быть атрибут show.
 */
export class InstanceVisibility {
  private hidden: boolean[];

  constructor(
    private readonly primitive: Primitive,
    /** id инстансов каждого объекта (у дерева — ствол и части кроны). */
    private readonly instanceIds: readonly (readonly string[])[],
    private readonly positions: readonly LonLat[],
  ) {
    this.hidden = instanceIds.map(() => false);
  }

  hideWithin(scene: Scene, areas: readonly (readonly LonLat[])[], margin: number): void {
    const next = pointsInsideAreas(this.positions, areas, margin);
    const apply = () => {
      next.forEach((hide, i) => {
        if (hide === this.hidden[i]) return;
        for (const id of this.instanceIds[i] ?? []) {
          const attributes = this.primitive.getGeometryInstanceAttributes(id);
          attributes.show = ShowGeometryInstanceAttribute.toValue(!hide, attributes.show);
        }
        this.hidden[i] = hide;
      });
      scene.requestRender();
    };

    if (this.primitive.ready) {
      apply();
      return;
    }
    // Примитив ещё собирается в воркерах — применим, как только будет готов.
    const remove = scene.postRender.addEventListener(() => {
      if (this.primitive.isDestroyed()) remove();
      else if (this.primitive.ready) {
        remove();
        apply();
      }
    });
    scene.requestRender();
  }
}
