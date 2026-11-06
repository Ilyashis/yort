import { useAppStore } from '../store/useAppStore';
import type { BaseBuildingProperties } from '../world/base/types';

function heightSourceText(b: BaseBuildingProperties): string {
  switch (b.heightSource) {
    case 'height':
      return 'из тега height';
    case 'levels':
      return `по этажности (${b.levels} эт.)`;
    case 'default':
      return 'оценка по типу здания';
  }
}

export function BuildingCard() {
  const building = useAppStore((s) => s.selectedBuilding);
  const selectBuilding = useAppStore((s) => s.selectBuilding);
  if (!building) return null;

  const [osmType, osmId] = building.id.split('/');

  return (
    <aside className="panel building-card">
      <button
        type="button"
        className="close"
        aria-label="Закрыть"
        onClick={() => selectBuilding(undefined)}
      >
        ×
      </button>
      <h2>{building.name ?? 'Здание без названия'}</h2>
      {building.address && <p className="muted">{building.address}</p>}

      <dl className="props">
        <dt>Тип (building)</dt>
        <dd>{building.building}</dd>
        <dt>Высота</dt>
        <dd>
          {building.height} м <span className="muted">— {heightSourceText(building)}</span>
        </dd>
        {building.minHeight > 0 && (
          <>
            <dt>Высота низа</dt>
            <dd>{building.minHeight} м</dd>
          </>
        )}
        <dt>OSM</dt>
        <dd>
          <a href={`https://www.openstreetmap.org/${osmType}/${osmId}`} target="_blank" rel="noreferrer">
            {building.id}
          </a>
        </dd>
      </dl>
    </aside>
  );
}
