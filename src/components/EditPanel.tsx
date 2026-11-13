import { findTerritory } from '../core/data';
import { useStore } from '../state/store';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { hashString } from '../utils/hash';
import { HOUSE_MODELS, MODEL_GROUPS, findHouseModel, type HouseModelId } from '../world/village/houseModels';
import {
  BUILDING_KINDS,
  FACADE_COLORS,
  ROAD_KINDS,
  ROOF_COLORS,
  clampFloors,
  plotKey,
  setPlotLift,
  removeBuilding,
  removeFence,
  removeRoad,
  turnFacade,
  upsertBuilding,
  upsertRoad,
  withModel,
  type LonLat,
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

const fmt = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Стороны прямоугольника контура (lon/lat), м: вдоль фасада (первая сторона) и вглубь. */
function sidesOf(footprint: readonly LonLat[]): [number, number] {
  const [a, b, c] = footprint as [LonLat, LonLat, LonLat];
  const k = Math.cos((a[1] * Math.PI) / 180) * 111_320;
  const d = (p: LonLat, q: LonLat) => Math.hypot((q[0] - p[0]) * k, (q[1] - p[1]) * 110_574);
  return [d(a, b), d(b, c)];
}

/** Контур, повёрнутый вокруг своей середины на degrees градусов по часовой стрелке. */
function turned(footprint: readonly LonLat[], degrees: number): LonLat[] {
  const lon0 = footprint.reduce((s, p) => s + p[0], 0) / footprint.length, lat0 = footprint.reduce((s, p) => s + p[1], 0) / footprint.length;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320, ky = 110_574;
  const a = (-degrees * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  return footprint.map(([lon, lat]): LonLat => {
    const x = (lon - lon0) * kx, y = (lat - lat0) * ky;
    return [lon0 + (x * c - y * sn) / kx, lat0 + (x * sn + y * c) / ky];
  });
}

/** Свойства выделенного в редакторе: дом (тип, этажи, крыша, цвета), дорога или забор. */
export function EditPanel() {
  const mode = useAppStore((s) => s.mode);
  const place = useStore((s) => s.place);
  const selection = useEditStore((s) => s.selection);
  const edits = useEditStore((s) => s.edits);
  const resolve = useEditStore((s) => s.resolveBuilding);
  const applyModel = useEditStore((s) => s.applyModel);
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

  const village = findTerritory(place)?.kind === 'village';
  if (selection.type === 'building') {
    const building = resolve?.(selection.id);
    if (!building) return null;
    const own = edits.buildings.some((b) => b.id === selection.id);
    const fromOsm = !!building.source;
    const update = (patch: Partial<EditedBuilding>) => commit(upsertBuilding(useEditStore.getState().edits, { ...building, ...patch }));
    const lift = edits.plotLifts?.[plotKey(building)] ?? 0;
    const setLift = (value: number) => commit(setPlotLift(useEditStore.getState().edits, plotKey(building), value));
    const model = building.model && findHouseModel(building.model.id);
    const setModel = (id: HouseModelId | undefined) => {
      if (!applyModel) return;
      const seed = building.model?.seed ?? hashString(building.id) % 9973;
      commit(upsertBuilding(useEditStore.getState().edits, applyModel(building, id ? { id, seed } : undefined)));
    };
    // Модель вписана в контур, но у каждой свои пределы размеров — скажем, если не совпало.
    let sizeNote = '';
    if (model && building.footprint.length === 4) {
      const [w, d] = sidesOf(building.footprint);
      const plan = model.plan({ seed: building.model!.seed, width: w, depth: d });
      sizeNote =
        Math.abs(plan.width - w) > 0.3 || Math.abs(plan.depth - d) > 0.3
          ? `Модель ${fmt(plan.width)} × ${fmt(plan.depth)} м, контур ${fmt(w)} × ${fmt(d)} м — у этой модели другие пределы размеров.`
          : `${fmt(plan.width)} × ${fmt(plan.depth)} м по контуру, высота ${fmt(plan.height)} м.`;
    }
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{model ? model.name : BUILDING_KINDS[building.kind].label}</h2>
        <p className="muted">
          {fromOsm ? (own ? 'Дом из OSM — изменён вами' : 'Дом из OpenStreetMap') : 'Ваш дом'} · тяните его мышью; белые точки — растянуть,
          чуть снаружи угла — повернуть
        </p>

        {village && (
          <div className="field">
            <span>
              Высота участка <b>{lift ? `${lift > 0 ? '+' : '−'}${fmt(Math.abs(lift))} м` : 'как у земли'}</b>
            </span>
            <div className="segmented segmented-small" role="group" aria-label="Высота участка">
              <button type="button" onClick={() => setLift(lift - 0.5)} title="Опустить участок на полметра">
                − 0,5
              </button>
              <button type="button" onClick={() => setLift(lift - 0.1)} title="Опустить на 10 см">
                − 0,1
              </button>
              <button type="button" className={lift ? '' : 'active'} onClick={() => setLift(0)} title="Вернуть естественную высоту">
                Авто
              </button>
              <button type="button" onClick={() => setLift(lift + 0.1)} title="Поднять на 10 см">
                + 0,1
              </button>
              <button type="button" onClick={() => setLift(lift + 0.5)} title="Поднять участок на полметра">
                + 0,5
              </button>
            </div>
            <p className="muted">Двор выравнивается на этой высоте, улица рядом подстраивается под неё.</p>
          </div>
        )}

        <div className="field">
          <span>Повернуть дом</span>
          <div className="segmented segmented-small" role="group" aria-label="Повернуть дом">
            {(
              [
                [-90, '↺ 90°', 'Против часовой на четверть оборота'],
                [-15, '↺ 15°', 'Против часовой на 15°'],
                [-1, '↺ 1°', 'Против часовой на 1°'],
                [1, '1° ↻', 'По часовой на 1°'],
                [15, '15° ↻', 'По часовой на 15°'],
                [90, '90° ↻', 'По часовой на четверть оборота'],
              ] as [number, string, string][]
            ).map(([degrees, label, title]) => (
              <button key={degrees} type="button" title={title} onClick={() => update({ footprint: turned(building.footprint, degrees) })}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {village && model && model.group === 'house' && (
          <div className="field">
            <span>Палисадник</span>
            <div className="segmented segmented-small" role="group" aria-label="С какой стороны палисадник">
              {(
                [
                  [0, 'С улицы', 'Перед уличным фасадом'],
                  [3, 'Слева', 'Слева от дома, если смотреть с улицы'],
                  [1, 'Справа', 'Справа от дома, если смотреть с улицы'],
                  [2, 'Сзади', 'За домом'],
                  [-1, 'Нет', 'Без палисадника'],
                ] as [number, string, string][]
              ).map(([side, label, title]) => (
                <button key={side} type="button" title={title} className={(building.garden ?? 0) === side ? 'active' : ''} onClick={() => update({ garden: side })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {model && (
          <div className="field">
            <span>{model.id === 'veranda' ? 'Веранда' : 'Крыльцо и пристрой'}</span>
            <div className="segmented segmented-small" role="group" aria-label="С какой стороны веранда и крыльцо">
              {(
                [
                  [false, model.id === 'veranda' ? 'Справа' : 'Как есть', 'Как в модели'],
                  [true, model.id === 'veranda' ? 'Слева' : 'Зеркально', 'Модель отражена слева направо'],
                ] as [boolean, string, string][]
              ).map(([mirror, label, title]) => (
                <button
                  key={String(mirror)} type="button" title={title} className={!!building.model!.mirror === mirror ? 'active' : ''}
                  onClick={() => update({ model: { id: building.model!.id, seed: building.model!.seed, ...(mirror ? { mirror: true } : {}) } })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span>Модель дома</span>
          <div className="model-grid" role="group" aria-label="Модель дома">
            <button type="button" className={!model ? 'active' : ''} onClick={() => setModel(undefined)} title="Простой объём: тип, этажи, крыша и цвета">
              Объём
            </button>
          </div>
          {MODEL_GROUPS.map(({ group, label }) => (
            <div key={group}>
              <div className="model-group">{label}</div>
              <div className="model-grid" role="group" aria-label={label}>
                {HOUSE_MODELS.filter((m) => m.group === group).map((m) => (
                  <button key={m.id} type="button" className={model?.id === m.id ? 'active' : ''} onClick={() => setModel(m.id)} title={m.description}>
                    {m.short}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {model ? (
          <>
            <p className="muted model-note">{sizeNote}</p>
            <div className="button-row">
              <button
                type="button"
                className="button"
                onClick={() => commit(upsertBuilding(useEditStore.getState().edits, withModel(building, { ...building.model!, seed: building.model!.seed + 1 })))}
              >
                Другая окраска
              </button>
              <button
                type="button"
                className="button"
                onClick={() => commit(upsertBuilding(useEditStore.getState().edits, { ...building, footprint: turnFacade(building.footprint) }))}
                title="Фасад — на соседнюю сторону контура"
              >
                Развернуть фасад
              </button>
            </div>
            <a className="model-link" href="/houses.html" target="_blank" rel="noreferrer">
              Все модели в мастерской ↗
            </a>
          </>
        ) : (
          <>
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
          </>
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

