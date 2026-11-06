import { useAppStore } from '../store/useAppStore';
import { formatArea } from '../utils/format';
import type { BaseBuildingProperties } from '../world/base/types';
import { BUILDING_TYPES } from '../world/user/building';
import { isUserBuildingId, userBuildingId } from '../world/user/UserBuildingsLayer';

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
  const userBuildings = useAppStore((s) => s.userBuildings);
  const removeUserBuilding = useAppStore((s) => s.removeUserBuilding);
  if (!building) return null;

  const closeButton = (
    <button type="button" className="close" aria-label="Закрыть" onClick={() => selectBuilding(undefined)}>
      ×
    </button>
  );

  if (isUserBuildingId(building.id)) {
    const own = userBuildings.find((b) => userBuildingId(b.id) === building.id);
    if (!own) return null;
    const { spec, building: geometry } = own;
    return (
      <aside className="panel building-card">
        {closeButton}
        <h2>Ваше здание</h2>
        <p className="muted">{BUILDING_TYPES[spec.type].label} · проект User World</p>
        <dl className="props">
          <dt>Этажей</dt>
          <dd>{spec.floors}</dd>
          <dt>Высота</dt>
          <dd>{geometry.totalHeight.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м</dd>
          <dt>Пятно застройки</dt>
          <dd>{formatArea(geometry.footprintArea)}</dd>
          <dt>Площадь этажей</dt>
          <dd>{formatArea(geometry.grossArea)}</dd>
          <dt>Крыша</dt>
          <dd>{geometry.roof === 'pitched' ? 'скатная' : 'плоская'}</dd>
        </dl>
        <div className="button-row">
          <button type="button" className="button" onClick={() => removeUserBuilding(own.id)}>
            Удалить здание
          </button>
        </div>
      </aside>
    );
  }

  const [osmType, osmId] = building.id.split('/');

  return (
    <aside className="panel building-card">
      {closeButton}
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
