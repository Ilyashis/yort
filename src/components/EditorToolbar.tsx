import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useEditStore, type EditTool } from '../store/useEditStore';
import { alignHint, useUnderlayStore } from '../store/useUnderlayStore';
import { MOVE_HINT, UnderlayPanel } from './UnderlayPanel';
import { EMPTY_EDITS, ROAD_KINDS, TREE_KINDS, TREE_ORDER, TREE_SIZES, isEmpty, parseEdits, type EditRoadKind } from '../world/edit/edits';
import { formatMetres, type SnapKind } from '../world/edit/snapLine';
import { HOUSE_MODELS, MODEL_GROUPS, findHouseModel, type HouseModelGroup } from '../world/village/houseModels';
import { SCULPT_MODES, SCULPT_RADIUS, SCULPT_STRENGTH, type SculptMode } from '../world/base/sculpt';

const TOOLS: { tool: EditTool; label: string; key: string; hint: string; icon: ReactNode }[] = [
  {
    tool: 'select',
    label: 'Выбор',
    key: 'V',
    hint: 'Клик — выбрать дом, дорогу или забор. Дом тяните мышью; белые точки — растянуть, чуть снаружи угла — повернуть. Delete — убрать.',
    icon: <path d="M5 3l12 7-5 1.5L9.5 17z" />,
  },
  {
    tool: 'house',
    label: 'Дом',
    key: 'Y',
    hint: 'Тяните по земле — дом вырастет ровно под участок и встанет вдоль ближайшей улицы.',
    icon: <path d="M3 10l7-6 7 6v7H3zM8 17v-4h4v4" />,
  },
  {
    tool: 'road',
    label: 'Дорога',
    key: 'T',
    hint: 'Щёлкайте — дорога пойдёт по точкам (двойной щелчок или Enter — готово). Или ведите с зажатой кнопкой, как кистью. Концы прилипнут к соседним улицам.',
    icon: <path d="M6 18L9 2M14 18L11 2M10 4v2M10 9v2M10 14v2" />,
  },
  {
    tool: 'fence',
    label: 'Забор',
    key: 'B',
    hint: 'Щёлкайте по углам участка — забор пойдёт по точкам. Точка прилипает к углам и линиям соседних заборов (жёлтая метка) и встаёт под прямым углом (голубая). Или ведите с зажатой кнопкой.',
    icon: <path d="M3 17V6l2-2 2 2v11M9 17V6l2-2 2 2v11M15 17V6l2-2 2 2v11M2 9h18M2 14h18" />,
  },
  {
    tool: 'tree',
    label: 'Дерево',
    key: 'N',
    hint: 'Щелчок — посадить дерево; протяните — аллея вдоль линии с ровным шагом. В режиме «Ластик» ведите по деревьям, чтобы убрать их.',
    icon: <path d="M10 18v-5M10 13c-4 0-6-2.5-6-5.2C4 4.8 6.6 2.5 10 2.5s6 2.3 6 5.3c0 2.7-2 5.2-6 5.2zM7 18h6" />,
  },
  {
    tool: 'terrain',
    label: 'Рельеф',
    key: 'G',
    hint: 'Ведите кистью по земле с зажатой кнопкой; [ и ] — меньше и больше кисть.',
    icon: <path d="M1 16l5-7 3 4 4-7 6 10zM2 18h16" />,
  },
];

const SCULPT_ORDER: SculptMode[] = ['raise', 'lower', 'flatten', 'smooth'];

const ROAD_ORDER: EditRoadKind[] = ['street', 'lane', 'track', 'path'];

const SNAP_TEXT: Record<SnapKind, string> = {
  vertex: 'прилипло к углу забора',
  line: 'прилипло к линии забора',
  angle: 'прямой угол',
};

const FENCE_SELECTED_HINT =
  'Забор: тяните белые точки; полупрозрачная точка посередине отрезка — потяните, чтобы добавить излом; двойной щелчок по точке — убрать её. Delete — убрать забор.';
const NOTICE_MS = 3200;

/**
 * Редактор города, как в градостроителях: инструменты внизу экрана, у каждого — своя клавиша.
 * Правки хранятся в браузере отдельно для каждого населённого пункта.
 */
export function EditorToolbar() {
  const mode = useAppStore((s) => s.mode);
  const ready = useAppStore((s) => s.status === 'ready');
  const territoryId = useAppStore((s) => s.territoryId);
  const tool = useEditStore((s) => s.tool);
  const setTool = useEditStore((s) => s.setTool);
  const roadKind = useEditStore((s) => s.roadKind);
  const setRoadKind = useEditStore((s) => s.setRoadKind);
  const houseModel = useEditStore((s) => s.houseModel);
  const setHouseModel = useEditStore((s) => s.setHouseModel);
  const sculpt = useEditStore((s) => s.sculpt);
  const setSculpt = useEditStore((s) => s.setSculpt);
  const canUndo = useEditStore((s) => s.past.length > 0);
  const canRedo = useEditStore((s) => s.future.length > 0);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const edits = useEditStore((s) => s.edits);
  const notice = useEditStore((s) => s.notice);
  const drawing = useEditStore((s) => s.drawing);
  const selectionType = useEditStore((s) => s.selection?.type);
  const mapFenceIds = useEditStore((s) => s.mapFenceIds);
  const treeSettings = useEditStore((s) => s.tree);
  const setTree = useEditStore((s) => s.setTree);
  const [menu, setMenu] = useState(false);
  const [modelGroup, setModelGroup] = useState<HouseModelGroup>(() => (houseModel && findHouseModel(houseModel)?.group) || 'house');
  const [underlayOpen, setUnderlayOpen] = useState(false);
  const underlayMode = useUnderlayStore((s) => s.mode);
  const align = useUnderlayStore((s) => s.align);
  const hasUnderlay = useUnderlayStore((s) => !!s.image);
  const [visibleNotice, setVisibleNotice] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    setVisibleNotice(notice.text);
    const timer = window.setTimeout(() => setVisibleNotice(undefined), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (mode !== 'explore' || !ready) return null;
  const active = TOOLS.find((t) => t.tool === tool);
  const count =
    edits.buildings.length +
    edits.removedBuildings.length +
    edits.roads.length +
    edits.removedRoads.length +
    edits.fences.length +
    edits.removedYards.length +
    edits.terrain.length +
    (edits.trees?.length ?? 0) +
    (edits.clearedTrees?.length ?? 0);

  const exportEdits = () => {
    const blob = new Blob([JSON.stringify(edits, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `citia-${territoryId}-pravki.json`;
    link.click();
    URL.revokeObjectURL(url);
    setMenu(false);
  };
  const importEdits = async (file: File | undefined) => {
    setMenu(false);
    if (!file) return;
    try {
      const parsed = parseEdits(JSON.parse(await file.text()));
      if (!parsed) throw new Error('bad');
      useEditStore.getState().replace(parsed);
      useEditStore.getState().notify('Правки загружены');
    } catch {
      useEditStore.getState().notify('Это не файл правок Citia');
    }
  };
  const resetEdits = () => {
    setMenu(false);
    if (window.confirm('Убрать все правки этого места? Их можно будет вернуть кнопкой «Отменить».')) {
      useEditStore.getState().replace(EMPTY_EDITS);
    }
  };

  return (
    <div className="editor">
      {visibleNotice && <div className="editor-notice">{visibleNotice}</div>}
      {underlayMode ? (
        <div className="editor-hint editor-hint-accent">{underlayMode === 'move' ? MOVE_HINT : alignHint(underlayMode, align)}</div>
      ) : drawing && (tool === 'road' || tool === 'fence') ? (
        <div className="editor-hint editor-hint-drawing">
          <span className="editor-measure">
            <b>{formatMetres(drawing.segment)}</b> отрезок · {formatMetres(drawing.total)} всего · точек {drawing.points}
            {drawing.snap && <em className={`editor-snap editor-snap-${drawing.snap}`}>{SNAP_TEXT[drawing.snap]}</em>}
          </span>
          <span className="editor-keys">
            {drawing.kind === 'fence' && drawing.points >= 3 && 'Щелчок по первой точке — замкнуть · '}
            <kbd>Enter</kbd> готово · <kbd>Backspace</kbd> убрать точку · <kbd>Esc</kbd> бросить
          </span>
        </div>
      ) : (
        active && (
          <div className="editor-hint">
            {active.tool === 'select' && selectionType === 'fence'
              ? FENCE_SELECTED_HINT
              : active.tool === 'tree'
                ? treeSettings.mode === 'erase'
                  ? 'Ластик: ведите по деревьям с зажатой кнопкой — свои деревья и деревья с карты в круге 3 м убираются. Вернуть — «Отменить».'
                  : `${TREE_KINDS[treeSettings.kind].hint}. Щелчок — одно дерево, протяжка — аллея с шагом около ${Math.round(TREE_KINDS[treeSettings.kind].spacing)} м (зелёные точки — где встанут).`
              : active.tool === 'house' && houseModel
              ? `Клик по земле — поставить «${findHouseModel(houseModel)?.name}» фасадом к ближайшей улице; растяните — дом встанет по размеру.`
              : active.tool === 'terrain'
                ? `${SCULPT_MODES[sculpt.mode].hint} [ и ] — размер кисти.`
                : active.hint}
          </div>
        )
      )}
      {tool === 'house' && (
        <div className="editor-models">
          <div className="segmented editor-kinds" role="group" aria-label="Раздел каталога">
            <button type="button" className={!houseModel ? 'active' : ''} onClick={() => setHouseModel(undefined)} title="Простой объём растяжкой">
              Объём
            </button>
            {MODEL_GROUPS.map(({ group, label }) => (
              <button
                key={group}
                type="button"
                className={houseModel && findHouseModel(houseModel)?.group === group ? 'active' : ''}
                onClick={() => {
                  setModelGroup(group);
                  // Раздел — сразу его первая модель (или та, что уже выбрана в нём).
                  if (!houseModel || findHouseModel(houseModel)?.group !== group) setHouseModel(HOUSE_MODELS.find((m) => m.group === group)?.id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {houseModel && (
            <div className="segmented editor-kinds" role="group" aria-label="Модель">
              {HOUSE_MODELS.filter((m) => m.group === (findHouseModel(houseModel)?.group ?? modelGroup)).map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={houseModel === model.id ? 'active' : ''}
                  onClick={() => setHouseModel(model.id)}
                  title={model.description}
                >
                  {model.short}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {tool === 'terrain' && (
        <div className="editor-models">
          <div className="segmented editor-kinds" role="group" aria-label="Кисть рельефа">
            {SCULPT_ORDER.map((m) => (
              <button key={m} type="button" className={sculpt.mode === m ? 'active' : ''} onClick={() => setSculpt({ mode: m })}>
                {SCULPT_MODES[m].label}
              </button>
            ))}
          </div>
          <div className="panel editor-sliders">
            <label>
              <span>Размер</span>
              <input
                type="range"
                min={SCULPT_RADIUS.min}
                max={SCULPT_RADIUS.max}
                step={1}
                value={sculpt.radius}
                onChange={(e) => setSculpt({ radius: Number(e.target.value) })}
              />
              <output>{sculpt.radius} м</output>
            </label>
            <label>
              <span>Сила</span>
              <input
                type="range"
                min={SCULPT_STRENGTH.min}
                max={SCULPT_STRENGTH.max}
                step={0.05}
                value={sculpt.strength}
                onChange={(e) => setSculpt({ strength: Number(e.target.value) })}
              />
              <output>{Math.round(sculpt.strength * 100)}%</output>
            </label>
          </div>
        </div>
      )}
      {tool === 'fence' && mapFenceIds.length > 0 && (
        <div className="segmented editor-kinds" role="group" aria-label="Заборы с карты">
          <button
            type="button"
            title="Убрать все заборы, найденные на карте, чтобы обвести участки самому (вернуть — «Отменить»)"
            disabled={mapFenceIds.every((id) => edits.removedFences?.includes(id))}
            onClick={() => {
              const store = useEditStore.getState();
              const removed = new Set([...(store.edits.removedFences ?? []), ...mapFenceIds]);
              store.commit({ ...store.edits, removedFences: [...removed] });
              store.notify('Заборы с карты убраны — обводите участки по «Карте». Вернуть — «Отменить» (Ctrl+Z)');
            }}
          >
            Убрать заборы с карты
          </button>
        </div>
      )}
      {tool === 'tree' && (
        <div className="editor-models">
          <div className="segmented editor-kinds" role="group" aria-label="Что делает инструмент">
            <button type="button" className={treeSettings.mode === 'plant' ? 'active' : ''} onClick={() => setTree({ mode: 'plant' })}>
              Сажать
            </button>
            <button type="button" className={treeSettings.mode === 'erase' ? 'active' : ''} onClick={() => setTree({ mode: 'erase' })}>
              Ластик
            </button>
          </div>
          {treeSettings.mode === 'plant' && (
            <>
              <div className="segmented editor-kinds" role="group" aria-label="Порода">
                {TREE_ORDER.map((kind) => (
                  <button key={kind} type="button" title={TREE_KINDS[kind].hint} className={treeSettings.kind === kind ? 'active' : ''} onClick={() => setTree({ kind })}>
                    {TREE_KINDS[kind].label}
                  </button>
                ))}
              </div>
              <div className="segmented editor-kinds" role="group" aria-label="Возраст">
                {TREE_SIZES.map((size) => (
                  <button key={size.id} type="button" className={treeSettings.size === size.id ? 'active' : ''} onClick={() => setTree({ size: size.id })}>
                    {size.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {tool === 'road' && (
        <div className="segmented editor-kinds" role="group" aria-label="Тип дороги">
          {ROAD_ORDER.map((kind) => (
            <button key={kind} type="button" className={roadKind === kind ? 'active' : ''} onClick={() => setRoadKind(kind)}>
              {ROAD_KINDS[kind].label}
            </button>
          ))}
        </div>
      )}
      <div className="panel editor-toolbar" role="toolbar" aria-label="Редактор">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            className={`editor-tool ${tool === t.tool ? 'active' : ''}`}
            title={`${t.label} (${t.key})`}
            onClick={() => setTool(tool === t.tool ? undefined : t.tool)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {t.icon}
            </svg>
            <span>{t.label}</span>
            <kbd>{t.key}</kbd>
          </button>
        ))}
        <div className="editor-menu-wrap">
          <button
            type="button"
            className={`editor-tool ${underlayOpen || underlayMode ? 'active' : ''}`}
            title="Подложка: свой снимок сверху, чтобы обводить по нему"
            onClick={() => {
              setUnderlayOpen(!underlayOpen);
              setMenu(false);
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
              <path d="M2.5 13l4.5-4.5 4 4 2.5-2.5 4 4" />
              <circle cx="13.5" cy="7.5" r="1.4" />
            </svg>
            <span>Подложка</span>
            {hasUnderlay && <i className="editor-dot" />}
          </button>
          {underlayOpen && <UnderlayPanel onClose={() => setUnderlayOpen(false)} />}
        </div>
        <span className="editor-divider" />
        <button type="button" className="editor-icon" title="Отменить (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button type="button" className="editor-icon" title="Повторить (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
        <div className="editor-menu-wrap">
          <button
            type="button"
            className="editor-icon"
            title="Правки: сохранить, загрузить, сбросить"
            onClick={() => {
              setMenu(!menu);
              setUnderlayOpen(false);
            }}
          >
            ⋯{count > 0 && <i className="editor-count">{count}</i>}
          </button>
          {menu && (
            <div className="panel editor-menu">
              <p className="muted">
                Правок: {count}. Хранятся в этом браузере, отдельно для каждого места; данные OSM не меняются.
              </p>
              <button type="button" className="button" disabled={isEmpty(edits)} onClick={exportEdits}>
                Сохранить в файл
              </button>
              <button type="button" className="button" onClick={() => fileInput.current?.click()}>
                Загрузить из файла
              </button>
              <button type="button" className="button" disabled={isEmpty(edits)} onClick={resetEdits}>
                Убрать все правки
              </button>
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            void importEdits(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
