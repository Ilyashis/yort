import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import {
  BUILDING_KINDS,
  FACADE_COLORS,
  ROAD_KINDS,
  ROOF_COLORS,
  clampFloors,
  removeBuilding,
  removeFence,
  removeRoad,
  upsertBuilding,
  upsertRoad,
  type EditBuildingKind,
  type EditRoadKind,
  type EditRoof,
  type EditedBuilding,
} from '../world/edit/edits';

const KINDS = Object.keys(BUILDING_KINDS) as EditBuildingKind[];
const ROOFS: { roof: EditRoof; label: string }[] = [
  { roof: 'flat', label: 'Плоская' },
  { roof: 'gabled', label: 'Двускатная' },
  { roof: 'hipped', label: 'Вальмовая' },
];
const ROAD_ORDER: EditRoadKind[] = ['street', 'lane', 'track', 'path'];

/** Свойства выделенного в редакторе: дом (тип, этажи, крыша, цвета), дорога или забор. */
export function EditPanel() {
  const mode = useAppStore((s) => s.mode);
  const selection = useEditStore((s) => s.selection);
  const edits = useEditStore((s) => s.edits);
  const resolve = useEditStore((s) => s.resolveBuilding);
  const select = useEditStore((s) => s.select);
  if (mode !== 'explore' || !selection) return null;

  const commit = useEditStore.getState().commit;
  const remove = () => {
    const store = useEditStore.getState();
    const next =
      selection.type === 'building'
        ? removeBuilding(store.edits, selection.id)
        : selection.type === 'road'
          ? removeRoad(store.edits, selection.id)
          : removeFence(store.edits, selection.id);
    store.commit(next);
    store.select(undefined);
  };
  const close = (
    <button type="button" className="close" aria-label="Закрыть" onClick={() => select(undefined)}>
      ×
    </button>
  );

  if (selection.type === 'building') {
    const building = resolve?.(selection.id);
    if (!building) return null;
    const own = edits.buildings.some((b) => b.id === selection.id);
    const fromOsm = !!building.source;
    const update = (patch: Partial<EditedBuilding>) => commit(upsertBuilding(useEditStore.getState().edits, { ...building, ...patch }));
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{BUILDING_KINDS[building.kind].label}</h2>
        <p className="muted">
          {fromOsm ? (own ? 'Дом из OSM — изменён вами' : 'Дом из OpenStreetMap') : 'Ваш дом'} · тяните его мышью, белые точки —
          растянуть, оранжевая — повернуть
        </p>

        <div className="segmented segmented-small" role="group" aria-label="Тип дома">
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={building.kind === kind ? 'active' : ''}
              onClick={() => update({ kind, roof: BUILDING_KINDS[kind].roof, floors: kind === 'shed' ? 1 : building.floors })}
            >
              {BUILDING_KINDS[kind].label}
            </button>
          ))}
        </div>

        {building.kind !== 'shed' && (
          <label className="field">
            <span>
              Этажей <b>{building.floors}</b>
            </span>
            <input
              type="range"
              min={1}
              max={building.kind === 'house' ? 3 : 30}
              step={1}
              value={building.floors}
              onChange={(e) => update({ floors: clampFloors(Number(e.target.value)) })}
            />
          </label>
        )}

        <div className="field">
          <span>Крыша</span>
          <div className="segmented segmented-small" role="group" aria-label="Крыша">
            {ROOFS.map(({ roof, label }) => (
              <button key={roof} type="button" className={building.roof === roof ? 'active' : ''} onClick={() => update({ roof })}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Стены</span>
          <div className="swatches" role="group" aria-label="Цвет стен">
            {FACADE_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                className={building.facadeColor === color ? 'active' : ''}
                style={{ background: color }}
                onClick={() => update({ facadeColor: color })}
              />
            ))}
          </div>
        </div>

        {building.roof !== 'flat' && (
          <div className="field">
            <span>Кровля</span>
            <div className="swatches" role="group" aria-label="Цвет кровли">
              {ROOF_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={color}
                  className={building.roofColor === color ? 'active' : ''}
                  style={{ background: color }}
                  onClick={() => update({ roofColor: color })}
                />
              ))}
            </div>
          </div>
        )}

        <div className="button-row">
          <button type="button" className="button" onClick={remove}>
            Убрать дом <kbd>Del</kbd>
          </button>
        </div>
      </aside>
    );
  }

  if (selection.type === 'road') {
    const road = edits.roads.find((r) => r.id === selection.id);
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{road ? ROAD_KINDS[road.kind].label : 'Дорога из OpenStreetMap'}</h2>
        {road ? (
          <div className="segmented segmented-small" role="group" aria-label="Тип дороги">
            {ROAD_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                className={road.kind === kind ? 'active' : ''}
                onClick={() => commit(upsertRoad(useEditStore.getState().edits, { ...road, kind }))}
              >
                {ROAD_KINDS[kind].label}
              </button>
            ))}
          </div>
        ) : (
          <p className="muted">Убрать её можно только у себя — в OSM она останется.</p>
        )}
        <div className="button-row">
          <button type="button" className="button" onClick={remove}>
            Убрать дорогу <kbd>Del</kbd>
          </button>
        </div>
      </aside>
    );
  }

  const own = edits.fences.some((f) => f.id === selection.id);
  return (
    <aside className="panel building-card edit-panel">
      {close}
      <h2>Забор</h2>
      <p className="muted">{own ? 'Нарисован вами' : 'Двор вокруг дома — построен по правилу, в OSM границ участков нет'}</p>
      <div className="button-row">
        <button type="button" className="button" onClick={remove}>
          {own ? 'Убрать забор' : 'Убрать забор двора'} <kbd>Del</kbd>
        </button>
      </div>
    </aside>
  );
}

