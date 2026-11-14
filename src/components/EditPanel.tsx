import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { findTerritory } from '../core/data';
import { useStore } from '../state/store';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { hashString } from '../utils/hash';
import { HOUSE_MODELS, MODEL_ENTRANCE, MODEL_GROUPS, findHouseModel, type HouseModelId } from '../world/village/houseModels';
import { cumulative, defaultGateAt, GATE_KINDS, GATE_ORDER, placeGates, type FenceGateSpec } from '../world/base/fenceGates';
import {
  BUILDING_KINDS,
  FENCE_KINDS,
  FENCE_PAINTS,
  FACADE_COLORS,
  ROAD_KINDS,
  ROOF_COLORS,
  clampFloors,
  plotKey,
  setAddress,
  setPlotLift,
  removeBuilding,
  removeFence,
  removeRoad,
  turnFacade,
  upsertBuilding,
  upsertFence,
  upsertRoad,
  withModel,
  type LonLat,
  type EditBuildingKind,
  type EditRoadKind,
  type EditRoof,
  type EditedBuilding,
  type EditedFence,
  type FenceKind,
  type HouseModelRef,
  type EditedTree,
  TREE_KINDS,
  TREE_ORDER,
  TREE_SIZES,
} from '../world/edit/edits';

const KINDS = Object.keys(BUILDING_KINDS) as EditBuildingKind[];
const ROOFS: { roof: EditRoof; label: string }[] = [
  { roof: 'flat', label: 'Плоская' },
  { roof: 'gabled', label: 'Двускатная' },
  { roof: 'hipped', label: 'Вальмовая' },
];
const ROAD_ORDER: EditRoadKind[] = ['street', 'lane', 'track', 'path'];

/** Линия забора в метрах (для ворот важны только длины по линии). */
const metres = (line: readonly [number, number][]): [number, number][] => {
  const [lon0, lat0] = line[0] ?? [0, 0];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return line.map(([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * 111_320]);
};

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
          : selection.type === 'tree'
            ? { ...store.edits, trees: (store.edits.trees ?? []).filter((t) => t.id !== selection.id) }
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
    const fromMap = !!building.source?.startsWith('render/');
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
    const ref = building.model;
    const entrance = ref ? MODEL_ENTRANCE[ref.id] : undefined;
    const setRef = (patch: Partial<HouseModelRef>) => {
      if (!ref) return;
      const next: HouseModelRef = { ...ref, ...patch };
      // Значения «как у модели» не храним.
      for (const k of Object.keys(next) as (keyof HouseModelRef)[]) if (next[k] === undefined) delete next[k];
      update({ model: next });
    };
    const entranceSide = entrance ? (ref?.mirror ? (entrance.side === 'left' ? 'right' : 'left') : entrance.side) : undefined;
    const hasVeranda = entrance?.veranda !== undefined ? (ref?.veranda ?? entrance.veranda) : false;
    const wallColor = ref ? ref.wall : building.facadeColor;
    const roofColor = ref ? ref.roof : building.roofColor;
    const setWall = (color: string | undefined) => (ref ? setRef({ wall: color }) : color && update({ facadeColor: color }));
    const setRoof = (color: string | undefined) => (ref ? setRef({ roof: color }) : color && update({ roofColor: color }));
    const origin = fromMap ? (own ? 'Постройка с карты — изменена вами' : 'Постройка во дворе с карты') : fromOsm ? (own ? 'Дом из OSM — изменён вами' : 'Дом из OpenStreetMap') : 'Ваш дом';
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{model ? model.name : BUILDING_KINDS[building.kind].label}</h2>
        <p className="muted card-sub">{origin}. Тяните дом мышью; белые точки — растянуть, чуть снаружи угла — повернуть.</p>

        <Section id="kind" title="Вид дома">
          <select
            className="model-select"
            value={model?.id ?? ''}
            aria-label="Модель дома"
            onChange={(e) => setModel((e.target.value || undefined) as HouseModelId | undefined)}
          >
            <option value="">Простой объём — этажи, крыша, цвета</option>
            {MODEL_GROUPS.map(({ group, label }) => (
              <optgroup key={group} label={label}>
                {HOUSE_MODELS.filter((m) => m.group === group).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {model ? (
            <>
              <p className="muted model-note">{model.description} {sizeNote}</p>
              <a className="model-link" href="/houses.html" target="_blank" rel="noreferrer">
                Все модели в мастерской ↗
              </a>
            </>
          ) : (
            <>
              <Row label="Тип">
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
              </Row>
              {building.kind !== 'shed' && (
                <Row label={`Этажей: ${building.floors}`}>
                  <input
                    type="range"
                    min={1}
                    max={building.kind === 'house' ? 3 : 30}
                    step={1}
                    value={building.floors}
                    onChange={(e) => update({ floors: clampFloors(Number(e.target.value)) })}
                  />
                </Row>
              )}
              <Row label="Крыша">
                <div className="segmented segmented-small" role="group" aria-label="Крыша">
                  {ROOFS.map(({ roof, label }) => (
                    <button key={roof} type="button" className={building.roof === roof ? 'active' : ''} onClick={() => update({ roof })}>
                      {label}
                    </button>
                  ))}
                </div>
              </Row>
            </>
          )}
        </Section>

        <Section id="colors" title="Цвет">
          <Row label="Стены">
            <Swatches colors={FACADE_COLORS} value={wallColor} onPick={setWall} auto={!!ref} label="Цвет стен" />
          </Row>
          {(ref || building.roof !== 'flat') && (
            <Row label="Крыша">
              <Swatches colors={ROOF_COLORS} value={roofColor} onPick={setRoof} auto={!!ref} label="Цвет крыши" />
            </Row>
          )}
          {ref && (
            <button type="button" className="button button-small" onClick={() => commit(upsertBuilding(useEditStore.getState().edits, withModel(building, { ...ref, seed: ref.seed + 1 })))}>
              Другая окраска модели
            </button>
          )}
        </Section>

        {ref && entrance && (
          <Section id="entrance" title="Вход, крыльцо, веранда">
            <Row label="Вход с улицы">
              <div className="segmented segmented-small" role="group" aria-label="С какой стороны вход">
                {(['left', 'right'] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    className={entranceSide === side ? 'active' : ''}
                    title={side === 'left' ? 'Вход слева, если смотреть с улицы' : 'Вход справа, если смотреть с улицы'}
                    onClick={() => setRef({ mirror: side !== entrance.side ? true : undefined })}
                  >
                    {side === 'left' ? '← Слева' : 'Справа →'}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Крыльцо">
              <Toggle value={ref.porch !== false} onChange={(on) => setRef({ porch: on ? undefined : false })} label="Крыльцо со ступенями" />
            </Row>
            {entrance.veranda !== undefined && (
              <Row label="Веранда">
                <Toggle
                  value={hasVeranda}
                  onChange={(on) => setRef({ veranda: on === entrance.veranda ? undefined : on })}
                  label="Застеклённая веранда у входа"
                />
              </Row>
            )}
          </Section>
        )}

        {village && (
          <Section id="address" title="Адрес">
            <AddressField key={plotKey(building)} addressKey={plotKey(building)} plate={!!model && model.group !== 'small'} />
          </Section>
        )}

        {village && (
          <Section id="plot" title="Участок">
            {model && model.group === 'house' && (
              <Row label="Палисадник">
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
              </Row>
            )}
            <Row label={`Высота участка: ${lift ? `${lift > 0 ? '+' : '−'}${fmt(Math.abs(lift))} м` : 'как у земли'}`}>
              <div className="segmented segmented-small" role="group" aria-label="Высота участка">
                <button type="button" onClick={() => setLift(lift - 0.5)} title="Опустить участок на полметра">− 0,5</button>
                <button type="button" onClick={() => setLift(lift - 0.1)} title="Опустить на 10 см">− 0,1</button>
                <button type="button" className={lift ? '' : 'active'} onClick={() => setLift(0)} title="Вернуть естественную высоту">Авто</button>
                <button type="button" onClick={() => setLift(lift + 0.1)} title="Поднять на 10 см">+ 0,1</button>
                <button type="button" onClick={() => setLift(lift + 0.5)} title="Поднять участок на полметра">+ 0,5</button>
              </div>
            </Row>
          </Section>
        )}

        <Section id="place" title="Положение">
          <Row label="Повернуть">
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
          </Row>
          {model && (
            <button
              type="button"
              className="button button-small"
              onClick={() => commit(upsertBuilding(useEditStore.getState().edits, { ...building, footprint: turnFacade(building.footprint) }))}
              title="Фасад — на соседнюю сторону контура"
            >
              Развернуть фасад к другой стороне
            </button>
          )}
        </Section>

        <div className="button-row card-footer">
          <button type="button" className="button button-danger" onClick={remove}>
            Убрать дом <kbd>Del</kbd>
          </button>
        </div>
      </aside>
    );
  }

  if (selection.type === 'tree') {
    const tree = edits.trees?.find((t) => t.id === selection.id);
    if (!tree) return null;
    const setTreePatch = (patch: Partial<EditedTree>) => {
      const store = useEditStore.getState();
      store.commit({ ...store.edits, trees: (store.edits.trees ?? []).map((t) => (t.id === tree.id ? { ...t, ...patch } : t)) });
    };
    const size = TREE_SIZES.reduce((best, s) => (Math.abs(s.scale - tree.scale) < Math.abs(best.scale - tree.scale) ? s : best), TREE_SIZES[0]);
    return (
      <aside className="panel building-card edit-panel">
        {close}
        <h2>{TREE_KINDS[tree.kind].label}</h2>
        <p className="muted card-sub">Ваше дерево. Тяните его мышью, чтобы пересадить.</p>
        <Row label="Порода">
          <div className="segmented segmented-small" role="group" aria-label="Порода">
            {TREE_ORDER.map((kind) => (
              <button key={kind} type="button" title={TREE_KINDS[kind].hint} className={tree.kind === kind ? 'active' : ''} onClick={() => setTreePatch({ kind })}>
                {TREE_KINDS[kind].label}
              </button>
            ))}
          </div>
        </Row>
        <Row label={`Возраст — высота около ${fmt(treeHeight(tree.kind) * tree.scale)} м`}>
          <div className="segmented segmented-small" role="group" aria-label="Возраст">
            {TREE_SIZES.map((s) => (
              <button key={s.id} type="button" className={size.id === s.id ? 'active' : ''} onClick={() => setTreePatch({ scale: s.scale })}>
                {s.label}
              </button>
            ))}
          </div>
        </Row>
        <div className="button-row card-footer">
          <button type="button" className="button button-danger" onClick={remove}>
            Убрать дерево <kbd>Del</kbd>
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

  const ownFence = edits.fences.find((f) => f.id === selection.id);
  const own = !!ownFence;
  return (
    <aside className="panel building-card edit-panel">
      {close}
      <h2>Забор</h2>
      <p className="muted">{own ? 'Тяните забор мышью, чтобы подвинуть; белые точки — изломы, их можно тянуть по одной (прилипают к соседним заборам); полупрозрачная посередине — потяните, чтобы добавить излом; двойной щелчок по точке — убрать её; чуть снаружи точки — повернуть' : 'Двор вокруг дома — построен по правилу, в OSM границ участков нет'}</p>
      {ownFence && (
        <div className="field">
          <span>Вид забора</span>
          <div className="segmented segmented-small segmented-grid" role="group" aria-label="Вид забора">
            {(Object.keys(FENCE_KINDS) as FenceKind[]).map((kind) => (
              <button
                key={kind} type="button" title={FENCE_KINDS[kind].hint} className={(ownFence.kind ?? 'boards') === kind ? 'active' : ''}
                onClick={() => commit(upsertFence(useEditStore.getState().edits, { ...ownFence, kind }))}
              >
                {FENCE_KINDS[kind].label}
              </button>
            ))}
          </div>
        </div>
      )}
      {ownFence && (
        <div className="field">
          <span>Цвет</span>
          <div className="swatches" role="group" aria-label="Цвет забора">
            {FENCE_PAINTS.map((color) => (
              <button
                key={color} type="button" aria-label={color} className={ownFence.color === color ? 'active' : ''} style={{ background: color }}
                onClick={() => commit(upsertFence(useEditStore.getState().edits, { ...ownFence, color }))}
              />
            ))}
          </div>
        </div>
      )}
      {ownFence && <FenceGates fence={ownFence} />}
      {ownFence && (
        <div className="field">
          <span>Повернуть забор</span>
          <div className="segmented segmented-small" role="group" aria-label="Повернуть забор">
            {(
              [
                [-90, '↺ 90°'],
                [-15, '↺ 15°'],
                [-1, '↺ 1°'],
                [1, '1° ↻'],
                [15, '15° ↻'],
                [90, '90° ↻'],
              ] as [number, string][]
            ).map(([degrees, label]) => (
              <button key={degrees} type="button" onClick={() => commit(upsertFence(useEditStore.getState().edits, { ...ownFence, line: turned(ownFence.line, degrees) }))}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="button-row">
        <button type="button" className="button" onClick={remove}>
          {own ? 'Убрать забор' : 'Убрать забор двора'} <kbd>Del</kbd>
        </button>
      </div>
    </aside>
  );
}


/** Ворота и калитки своего забора: включить или убрать каждый вид, сдвинуть вдоль забора. */
function FenceGates({ fence }: { fence: EditedFence }) {
  const commit = useEditStore((s) => s.commit);
  const notify = useEditStore((s) => s.notify);
  const local = metres(fence.line);
  const total = cumulative(local).at(-1) ?? 0;
  const gates = fence.gates ?? [];
  const placed = placeGates(local, gates);
  const setGates = (next: FenceGateSpec[]) => commit(upsertFence(useEditStore.getState().edits, { ...fence, gates: next }));
  const toggle = (kind: FenceGateSpec['kind']) => {
    const index = gates.findIndex((g) => g.kind === kind);
    if (index >= 0) return setGates(gates.filter((_, i) => i !== index));
    const at = defaultGateAt(local, kind, gates);
    if (at === undefined) return notify(`${GATE_KINDS[kind].label} (${fmt(GATE_KINDS[kind].width)} м) здесь не помещается — нужен прямой участок забора подлиннее`);
    setGates([...gates, { kind, at }]);
  };
  return (
    <div className="field">
      <span>Ворота и калитки</span>
      <div className="segmented segmented-small segmented-grid" role="group" aria-label="Ворота и калитки">
        {GATE_ORDER.map((kind) => (
          <button key={kind} type="button" title={GATE_KINDS[kind].hint} className={gates.some((g) => g.kind === kind) ? 'active' : ''} onClick={() => toggle(kind)}>
            {GATE_KINDS[kind].label}
          </button>
        ))}
      </div>
      {gates.map((gate, i) => {
        const place = placed.find((p) => p.index === i);
        return (
          <label key={gate.kind} className="field">
            <span>
              {GATE_KINDS[gate.kind].label} — {place ? `${fmt(place.at)} м от начала` : 'не помещается, сдвиньте'}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, total)}
              step={0.1}
              value={place?.at ?? gate.at}
              onChange={(e) => setGates(gates.map((g, j) => (j === i ? { ...g, at: Number(e.target.value) } : g)))}
            />
          </label>
        );
      })}
      {gates.length > 0 && <p className="muted">Синие точки над забором — ворота: тяните их мышью вдоль забора.</p>}
    </div>
  );
}

/** Адрес дома: улица (с подсказкой из названий улиц) и номер; сохраняется по Enter или при уходе из поля. */
function AddressField({ addressKey, plate }: { addressKey: string; plate: boolean }) {
  const saved = useEditStore((s) => s.edits.addresses?.[addressKey]);
  const book = useEditStore((s) => s.addressBook);
  const osm = book.osm[addressKey];
  const current = saved ?? osm;
  const [street, setStreet] = useState(current?.street ?? '');
  const [number, setNumber] = useState(current?.number ?? '');
  useEffect(() => {
    setStreet(current?.street ?? '');
    setNumber(current?.number ?? '');
  }, [current?.street, current?.number]);
  const used = Object.values(useEditStore.getState().edits.addresses ?? {}).map((a) => a.street);
  const streets = [...new Set([...book.streets, ...used].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const save = () => {
    if (street.trim() === (current?.street ?? '') && number.trim() === (current?.number ?? '')) return;
    const store = useEditStore.getState();
    store.commit(setAddress(store.edits, addressKey, { street, number }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };
  return (
    <div className="field address-field">
      <small className="muted">{saved ? 'Указан вами' : osm ? 'Из OpenStreetMap' : 'Не указан'}</small>
      <div className="address-inputs">
        <input
          type="text"
          list="citia-streets"
          placeholder="Улица"
          value={street}
          maxLength={80}
          onChange={(e) => setStreet(e.target.value)}
          onBlur={save}
          onKeyDown={onKey}
          aria-label="Улица"
        />
        <input
          type="text"
          placeholder="№"
          value={number}
          maxLength={16}
          onChange={(e) => setNumber(e.target.value)}
          onBlur={save}
          onKeyDown={onKey}
          aria-label="Номер дома"
        />
      </div>
      <datalist id="citia-streets">
        {streets.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <p className="muted">
        {plate ? 'Табличка с улицей и номером висит у правого угла фасада.' : 'Табличка появится, когда у дома будет модель.'}
        {saved && osm ? ' Сотрите оба поля — вернётся адрес из OSM.' : ''}
      </p>
    </div>
  );
}

/** Раздел карточки: сворачивается, открытость запоминается в браузере. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const storageKey = `citia:card:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== '0';
    } catch {
      return true;
    }
  });
  return (
    <details
      className="card-section"
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        try {
          localStorage.setItem(storageKey, now ? '1' : '0');
        } catch {
          // Хранилище недоступно — раздел просто не запомнится.
        }
      }}
    >
      <summary>{title}</summary>
      <div className="card-section-body">{children}</div>
    </details>
  );
}

/** Строка раздела: подпись слева, управление справа (на узкой карточке — под подписью). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card-row">
      <span className="card-row-label">{label}</span>
      <div className="card-row-control">{children}</div>
    </div>
  );
}

/** Есть / нет. */
function Toggle({ value, onChange, label }: { value: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <div className="segmented segmented-small" role="group" aria-label={label}>
      <button type="button" className={value ? 'active' : ''} onClick={() => !value && onChange(true)}>
        Есть
      </button>
      <button type="button" className={!value ? 'active' : ''} onClick={() => value && onChange(false)}>
        Нет
      </button>
    </div>
  );
}

/** Цвета кружками; auto — первый кружок «как в модели». */
function Swatches({ colors, value, onPick, auto, label }: { colors: readonly string[]; value: string | undefined; onPick: (color: string | undefined) => void; auto: boolean; label: string }) {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {auto && (
        <button type="button" className={`swatch-auto ${!value ? 'active' : ''}`} title="Как в модели" aria-label="Как в модели" onClick={() => onPick(undefined)}>
          A
        </button>
      )}
      {colors.map((color) => (
        <button key={color} type="button" aria-label={color} title={color} className={value === color ? 'active' : ''} style={{ background: color }} onClick={() => onPick(color)} />
      ))}
    </div>
  );
}

/** Высота взрослого дерева породы (модель в масштабе 1), м. */
const treeHeight = (kind: EditedTree['kind']) => ({ birch: 9.6, spruce: 10.2, apple: 4.4, linden: 12 })[kind];
