import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { hashString } from '../utils/hash';
import { HOUSE_MODELS, MODEL_GROUPS, findHouseModel, type HouseModelId } from '../world/village/houseModels';
import {
  BUILDING_KINDS,
  FACADE_COLORS,
  FENCE_HEIGHT,
  FENCE_STYLES,
  ROAD_KINDS,
  ROAD_WIDTH,
  roadWidth,
  ROOF_COLORS,
  clampFloors,
  removeBuilding,
  removeFence,
  removeRoad,
  setProp,
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

const PROP_NAMES: Record<string, string> = {
  woodpile: 'Поленница',
  beehive: 'Улей',
  haystack: 'Стог сена',
  doghouse: 'Собачья будка',
  bench: 'Лавочка',
  compost: 'Компостный ящик',
};

const FENCE_ORDER = Object.keys(FENCE_STYLES) as (keyof typeof FENCE_STYLES)[];

/** Ползунок, который меняет значение сразу на экране, а в правки пишет, когда его отпустили (одна правка — одна отмена). */
function Slider(props: { label: string; unit: string; min: number; max: number; step: number; value: number; whole?: boolean; onCommit: (v: number) => void }) {
  const [value, setValue] = useState(props.value);
  useEffect(() => setValue(props.value), [props.value]);
  const commit = () => {
    if (value !== props.value) props.onCommit(value);
  };
  return (
    <label className="field">
      <span>
        {props.label} <b>{props.whole ? value : fmt(value)}{props.unit ? ` ${props.unit}` : ''}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}

const fmt = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Стороны прямоугольника контура (lon/lat), м: вдоль фасада (первая сторона) и вглубь. */
function sidesOf(footprint: readonly LonLat[]): [number, number] {
  const [a, b, c] = footprint as [LonLat, LonLat, LonLat];
  const k = Math.cos((a[1] * Math.PI) / 180) * 111_320;
  const d = (p: LonLat, q: LonLat) => Math.hypot((q[0] - p[0]) * k, (q[1] - p[1]) * 110_574);
  return [d(a, b), d(b, c)];
}

/** Свойства выделенного в редакторе: дом (тип, этажи, крыша, цвета), дорога или забор. */
export function EditPanel() {
  const mode = useAppStore((s) => s.mode);
  const selection = useEditStore((s) => s.selection);
  const edits = useEditStore((s) => s.edits);
  const resolve = useEditStore((s) => s.resolveBuilding);
  const applyModel = useEditStore((s) => s.applyModel);
  const select = useEditStore((s) => s.select);
  const fenceTools = useEditStore((s) => s.fenceTools);
  const propTools = useEditStore((s) => s.propTools);
  const [fenceTarget, setFenceTarget] = useState<'street' | 'all'>('street');
  // Другой забор — снова «Уличный».
  useEffect(() => setFenceTarget('street'), [selection?.id]);
  if (mode !== 'explore' || !selection) return null;

  const commit = useEditStore.getState().commit;
  const remove = () => {
    const store = useEditStore.getState();
    if (selection.type === 'prop') {
      store.commit(setProp(store.edits, selection.id, { removed: true }));
      store.select(undefined);
      return;
    }
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
      const plan = model.plan({ seed: building.model!.seed, floors: building.model!.floors, width: w, depth: d });
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
          {fromOsm ? (own ? 'Дом из OSM — изменён вами' : 'Дом из OpenStreetMap') : 'Ваш дом'} · тяните его мышью, белые точки —
          растянуть, оранжевая — повернуть
        </p>

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
            {model.floors && (
              <div className="field">
                <span>Этажей</span>
                <div className="segmented segmented-small" role="group" aria-label="Этажей">
                  {Array.from({ length: model.floors.max - model.floors.min + 1 }, (_, k) => model.floors!.min + k).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={(building.model!.floors ?? model.floors!.value) === n ? 'active' : ''}
                      onClick={() => commit(upsertBuilding(useEditStore.getState().edits, withModel(building, { ...building.model!, floors: n })))}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
                  // Этажность — в пределах нового типа (у дома — не больше 3).
                  onClick={() => update({ kind, roof: BUILDING_KINDS[kind].roof, floors: kind === 'shed' ? 1 : Math.min(building.floors, kind === 'house' ? 3 : 30) })}
                >
                  {BUILDING_KINDS[kind].label}
                </button>
              ))}
            </div>

            {building.kind !== 'shed' && (
              <Slider
                label="Этажей"
                unit=""
                whole
                min={1}
                max={building.kind === 'house' ? 3 : 30}
                step={1}
                value={building.floors}
                onCommit={(floors) => update({ floors: clampFloors(floors) })}
              />
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

  if (selection.type === 'prop') {
    const info = propTools?.info(selection.id);
    if (!info) return null;
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{PROP_NAMES[info.kind] ?? 'Мелочь двора'}</h2>
        <p className="muted">Тяните её мышью — встанет, куда отпустите.</p>
        <div className="button-row">
          <button type="button" className="button" onClick={() => propTools?.rotate(selection.id, Math.PI / 6)} title="Повернуть против часовой на 30°">
            ↺ Повернуть
          </button>
          <button type="button" className="button" onClick={() => propTools?.rotate(selection.id, -Math.PI / 6)} title="Повернуть по часовой на 30°">
            ↻ Повернуть
          </button>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={remove}>
            Убрать <kbd>Del</kbd>
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
        {road && (
          <Slider
            label="Ширина"
            unit="м"
            min={ROAD_WIDTH[0]}
            max={ROAD_WIDTH[1]}
            step={0.5}
            value={roadWidth(road)}
            onCommit={(width) => commit(upsertRoad(useEditStore.getState().edits, { ...road, width }))}
          />
        )}
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
  const info = fenceTools?.info(selection.id);
  const editable = !!info;
  const edited = !own && !!fenceTools?.edited(selection.id);
  const target = fenceTarget === 'street' && info?.hasStreet ? 'street' : 'all';
  const setLook = (look: Parameters<NonNullable<typeof fenceTools>['setLook']>[2]) => fenceTools?.setLook(selection.id, target, look);
  return (
    <aside className="panel building-card edit-panel">
      {close}
      <h2>Забор</h2>
      <p className="muted">{own ? 'Нарисован вами' : 'Двор вокруг дома — построен по правилу, в OSM границ участков нет'}</p>
      {info && (
        <>
          {!own && info.hasStreet && (
            <div className="segmented segmented-small" role="group" aria-label="Какие заборы участка">
              <button type="button" className={target === 'street' ? 'active' : ''} onClick={() => setFenceTarget('street')}>
                Уличный
              </button>
              <button type="button" className={target === 'all' ? 'active' : ''} onClick={() => setFenceTarget('all')}>
                Весь участок
              </button>
            </div>
          )}
          <div className="field">
            <span>Тип</span>
            <div className="segmented segmented-small" role="group" aria-label="Тип забора">
              {FENCE_ORDER.map((style) => (
                <button
                  key={style}
                  type="button"
                  className={info.style === style ? 'active' : ''}
                  // Новый тип — своей обычной высоты и своего цвета.
                  onClick={() => setLook({ style, height: FENCE_STYLES[style].height, color: FENCE_STYLES[style].colors[0] })}
                >
                  {FENCE_STYLES[style].label}
                </button>
              ))}
            </div>
          </div>
          <Slider label="Высота" unit="м" min={FENCE_HEIGHT[0]} max={FENCE_HEIGHT[1]} step={0.1} value={info.height} onCommit={(height) => setLook({ height })} />
          <div className="field">
            <span>Цвет</span>
            <div className="swatches" role="group" aria-label="Цвет забора">
              {[...new Set([...FENCE_STYLES[info.style].colors, ...FENCE_STYLES.picket.colors])].map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={color}
                  className={info.color === color ? 'active' : ''}
                  style={{ background: color }}
                  onClick={() => setLook({ color })}
                />
              ))}
            </div>
          </div>
          <div className="field">
            <span>Ворота и калитка</span>
            <label className="toggle">
              <input type="checkbox" checked={info.gate.gate} onChange={(e) => fenceTools?.setGate(selection.id, { gate: e.target.checked })} />
              Ворота (две створки, проезд)
            </label>
            <label className="toggle">
              <input type="checkbox" checked={info.gate.wicket} onChange={(e) => fenceTools?.setGate(selection.id, { wicket: e.target.checked })} />
              Калитка
            </label>
            {info.gate.gate && info.gate.wicket && (
              <div className="segmented segmented-small" role="group" aria-label="Калитка">
                <button type="button" className={info.gate.wicketSide === -1 ? 'active' : ''} onClick={() => fenceTools?.setGate(selection.id, { wicketSide: -1 })}>
                  Калитка слева
                </button>
                <button type="button" className={info.gate.wicketSide === 1 ? 'active' : ''} onClick={() => fenceTools?.setGate(selection.id, { wicketSide: 1 })}>
                  Калитка справа
                </button>
              </div>
            )}
            {(info.gate.gate || info.gate.wicket) && (
              <label className="toggle">
                <input type="checkbox" checked={info.gate.canopy} onChange={(e) => fenceTools?.setGate(selection.id, { canopy: e.target.checked })} />
                Козырёк над входом
              </label>
            )}
            {(info.gate.gate || info.gate.wicket) && <p className="muted">Синюю точку на заборе тяните — проём поедет вдоль забора.</p>}
          </div>
        </>
      )}
      {editable && (
        <p className="muted">
          Тяните белые точки — у соседской точки или забора они примагнитятся (Alt — без магнита). «+» на середине — новая точка; клик по точке и{' '}
          <kbd>Del</kbd> — убрать излом.
        </p>
      )}
      <div className="button-row">
        {edited && (
          <button type="button" className="button" onClick={() => fenceTools?.reset(selection.id)}>
            Вернуть как было
          </button>
        )}
        <button type="button" className="button" onClick={remove}>
          {own ? 'Убрать забор' : 'Убрать забор двора'} <kbd>Del</kbd>
        </button>
      </div>
    </aside>
  );
}

