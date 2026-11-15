import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { sameEdits, useEditStore, type EditTool } from '../store/useEditStore';
import { alignHint, useUnderlayStore } from '../store/useUnderlayStore';
import { MOVE_HINT, UnderlayPanel } from './UnderlayPanel';
import { useDismiss } from './useDismiss';
import { EMPTY_EDITS, ROAD_KINDS, ROAD_WIDTH, isEmpty, parseEdits, type EditRoadKind } from '../world/edit/edits';
import { HOUSE_MODELS, MODEL_GROUPS, findHouseModel, type HouseModelGroup } from '../world/village/houseModels';
import { AREA_MODES, SCULPT_LEVELS, SCULPT_MODES, SCULPT_RADIUS, SCULPT_STRENGTH, type SculptLevelBy, type SculptMode } from '../world/base/sculpt';

/** Клавиша-модификатор этой системы: на Mac — ⌘. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Меню правок: закрывается кликом мимо и Esc. */
function EditsMenu({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useDismiss(onClose, '.editor-menu-button');
  return (
    <div ref={ref} className="panel editor-menu">
      {children}
    </div>
  );
}

const TOOLS: { tool: EditTool; label: string; key: string; hint: string; icon: ReactNode }[] = [
  {
    tool: 'select',
    label: 'Выбор',
    key: 'V',
    hint: 'Клик — выбрать дом, дорогу или забор. Дом тяните мышью; белые точки — растянуть, оранжевая — повернуть. У забора точки тяните (магнит к соседям, Alt — без него), «+» — новая точка, синяя — ворота. Сараи, бани, поленницы, ульи, будки и площадки тоже тянут мышью. Delete — убрать.',
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
    hint: 'Клик — точка дороги, двойной клик или Enter — готово; повороты скруглятся. Backspace — убрать точку, Esc — отмена. Точки липнут к осям дорог (Alt — без магнита).',
    icon: <path d="M6 18L9 2M14 18L11 2M10 4v2M10 9v2M10 14v2" />,
  },
  {
    tool: 'fence',
    label: 'Забор',
    key: 'B',
    hint: 'Клик — точка забора, двойной клик или Enter — готово, клик в первую точку — замкнуть. Backspace — убрать точку, Esc — отмена. Точки липнут к соседним заборам (Alt — без магнита).',
    icon: <path d="M3 17V6l2-2 2 2v11M9 17V6l2-2 2 2v11M15 17V6l2-2 2 2v11M2 9h18M2 14h18" />,
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
  const fenceDraw = useEditStore((s) => s.fenceDraw);
  const roadDraw = useEditStore((s) => s.roadDraw);
  const setRoadDraw = useEditStore((s) => s.setRoadDraw);
  const roadWidthSetting = useEditStore((s) => s.roadWidth);
  const setRoadWidth = useEditStore((s) => s.setRoadWidth);
  const setFenceDraw = useEditStore((s) => s.setFenceDraw);
  const setSculpt = useEditStore((s) => s.setSculpt);
  const canUndo = useEditStore((s) => s.past.length > 0);
  const canRedo = useEditStore((s) => s.future.length > 0);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const edits = useEditStore((s) => s.edits);
  const published = useEditStore((s) => s.published);
  const publisher = useEditStore((s) => s.publisher);
  /** Есть неопубликованные правки (черновик отличается от того, что на сайте). */
  const draft = !sameEdits(edits, published);
  const [publishing, setPublishing] = useState(false);
  const notice = useEditStore((s) => s.notice);
  const [menu, setMenu] = useState(false);
  const [modelGroup, setModelGroup] = useState<HouseModelGroup>(() => (houseModel && findHouseModel(houseModel)?.group) || 'house');
  const [underlayOpen, setUnderlayOpen] = useState(false);
  const mapOverlay = useAppStore((s) => s.mapOverlay);
  const setMapOverlay = useAppStore((s) => s.setMapOverlay);
  const mapOpacity = useAppStore((s) => s.mapOpacity);
  const setMapOpacity = useAppStore((s) => s.setMapOpacity);
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
    edits.estateFences.length +
    edits.gates.length +
    edits.props.length;

  const exportEdits = () => {
    const blob = new Blob([JSON.stringify(edits, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `citia-${territoryId}-pravki.json`;
    link.click();
    // Сразу отзывать нельзя: Safari и Firefox не успевают начать скачивание.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const publish = async () => {
    if (!publisher || publishing) return;
    setPublishing(true);
    try {
      await publisher();
      useEditStore.getState().notify('Опубликовано: правки и деревья — в файлах данных. Закоммитьте и отправьте на сайт — их увидят все.');
    } catch (error) {
      useEditStore.getState().notify(`Не опубликовано: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPublishing(false);
    }
  };
  const revertToPublished = () => {
    setMenu(false);
    if (window.confirm('Вернуть деревню как опубликовано? Неопубликованные правки уйдут (отменить можно кнопкой «Отменить», пока страница открыта).')) {
      useEditStore.getState().replace(useEditStore.getState().published);
    }
  };
  const resetEdits = () => {
    setMenu(false);
    if (window.confirm('Убрать все правки этого места? Вернуть их можно кнопкой «Отменить», но только пока страница не перезагружена (или из сохранённого файла).')) {
      useEditStore.getState().replace(EMPTY_EDITS);
    }
  };

  return (
    <div className="editor">
      {visibleNotice && <div className="editor-notice">{visibleNotice}</div>}
      {underlayMode ? (
        <div className="editor-hint editor-hint-accent">{underlayMode === 'move' ? MOVE_HINT : alignHint(underlayMode, align)}</div>
      ) : (
        active && (
          <div className="editor-hint">
            {active.tool === 'house' && houseModel
              ? `Клик по земле — поставить «${findHouseModel(houseModel)?.name}» фасадом к ближайшей улице; растяните — дом встанет по размеру.`
              : active.tool === 'terrain'
                ? sculpt.shape === 'area' && AREA_MODES.includes(sculpt.mode)
                  ? sculpt.mode === 'flatten'
                    ? `Обведите область с зажатой кнопкой и отпустите — земля внутри выровняется ${SCULPT_LEVELS[sculpt.levelBy ?? 'median'].hint} (у края — плавный переход).`
                    : 'Обведите область с зажатой кнопкой и отпустите — бугры и ямки внутри сгладятся, общий уклон останется.'
                  : sculpt.mode === 'flatten' && (sculpt.levelBy === 'low' || sculpt.levelBy === 'high')
                    ? `Земля под кистью тянется ${SCULPT_LEVELS[sculpt.levelBy].hint.replace('внутри', 'под кистью в момент нажатия')}. [ и ] — размер кисти.`
                    : `${SCULPT_MODES[sculpt.mode].hint} [ и ] — размер кисти.`
                : active.tool === 'road' && roadDraw === 'line'
                  ? 'Ведите от любой дороги, как карандашом: линия спрямится, концы прилипнут к соседним улицам.'
                  : active.tool === 'road' && roadDraw === 'brush'
                    ? 'Кисть: водите с зажатой кнопкой — дорога ляжет ровно там, где провели, своей шириной. Так рисуют площадки, развороты и расширения любой формы.'
                    : active.tool === 'fence' && fenceDraw === 'pencil'
                  ? 'Ведите линию по земле — по ней встанет забор со столбами; концы липнут к соседним заборам.'
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
              <button
                key={m}
                type="button"
                className={sculpt.mode === m ? 'active' : ''}
                disabled={sculpt.shape === 'area' && !AREA_MODES.includes(m)}
                onClick={() => setSculpt({ mode: m })}
              >
                {SCULPT_MODES[m].label}
              </button>
            ))}
          </div>
          <div className="segmented editor-kinds" role="group" aria-label="Кистью или обвести область">
            <button type="button" className={sculpt.shape !== 'area' ? 'active' : ''} onClick={() => setSculpt({ shape: 'brush' })} title="Водить кистью по земле">
              Кистью
            </button>
            <button
              type="button"
              className={sculpt.shape === 'area' ? 'active' : ''}
              title="Обвести произвольную область — выровнять или сгладить её целиком"
              onClick={() => setSculpt({ shape: 'area', ...(AREA_MODES.includes(sculpt.mode) ? {} : { mode: 'flatten' }) })}
            >
              Обвести область
            </button>
          </div>
          {sculpt.mode === 'flatten' && (
            <div className="segmented editor-kinds" role="group" aria-label="Выровнять к высоте">
              {(Object.keys(SCULPT_LEVELS) as SculptLevelBy[]).map((by) => {
                // Кистью по умолчанию — к высоте точки, с которой начали мазок; обводкой — к средней.
                const brush = sculpt.shape !== 'area';
                const label = brush && by === 'median' ? 'От точки' : SCULPT_LEVELS[by].label;
                const hint = brush ? (by === 'median' ? 'к высоте точки, с которой начали' : SCULPT_LEVELS[by].hint.replace('внутри', 'под кистью')) : SCULPT_LEVELS[by].hint;
                return (
                  <button
                    key={by}
                    type="button"
                    className={(sculpt.levelBy ?? 'median') === by ? 'active' : ''}
                    title={`Выровнять ${hint}`}
                    onClick={() => setSculpt({ levelBy: by })}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="panel editor-sliders">
            {sculpt.shape !== 'area' && (
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
            )}
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
      {mapOverlay && (
        <div className="editor-models">
          <div className="panel editor-sliders">
            <label>
              <span>Карта</span>
              <input type="range" min={0.3} max={1} step={0.1} value={mapOpacity} onChange={(e) => setMapOpacity(Math.round(Number(e.target.value) * 10) / 10)} />
              <output>{Math.round(mapOpacity * 100)}%</output>
            </label>
          </div>
        </div>
      )}
      {tool === 'fence' && (
        <div className="segmented editor-kinds" role="group" aria-label="Как рисовать забор">
          <button type="button" className={fenceDraw === 'points' ? 'active' : ''} onClick={() => setFenceDraw('points')}>
            По точкам
          </button>
          <button type="button" className={fenceDraw === 'pencil' ? 'active' : ''} onClick={() => setFenceDraw('pencil')}>
            Карандашом
          </button>
        </div>
      )}
      {tool === 'road' && (
        <div className="editor-models">
          <div className="segmented editor-kinds" role="group" aria-label="Тип дороги">
            {ROAD_ORDER.map((kind) => (
              <button key={kind} type="button" className={roadKind === kind ? 'active' : ''} onClick={() => setRoadKind(kind)}>
                {ROAD_KINDS[kind].label}
              </button>
            ))}
          </div>
          <div className="segmented editor-kinds" role="group" aria-label="Как рисовать дорогу">
            {(
              [
                ['points', 'По точкам'],
                ['line', 'Линией'],
                ['brush', 'Кистью'],
              ] as const
            ).map(([mode, label]) => (
              <button key={mode} type="button" className={roadDraw === mode ? 'active' : ''} onClick={() => setRoadDraw(mode)}>
                {label}
              </button>
            ))}
          </div>
          <div className="panel editor-sliders">
            <label>
              <span>Ширина</span>
              <input
                type="range"
                min={ROAD_WIDTH[0]}
                max={ROAD_WIDTH[1]}
                step={0.5}
                value={roadWidthSetting ?? ROAD_KINDS[roadKind].width}
                onChange={(e) => setRoadWidth(Number(e.target.value))}
                onDoubleClick={() => setRoadWidth(undefined)}
                title="Двойной клик — ширина по типу дороги"
              />
              <output>{(roadWidthSetting ?? ROAD_KINDS[roadKind].width).toLocaleString('ru-RU')} м</output>
            </label>
          </div>
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
        <button
          type="button"
          className={`editor-tool ${mapOverlay ? 'active' : ''}`}
          title="Карта деревни (вид сверху) поверх земли — дорисовывать по ней дома, дороги, заборы. Ещё раз — убрать"
          onClick={() => setMapOverlay(!mapOverlay)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2.5 5l5-2 5 2 5-2v12l-5 2-5-2-5 2z" />
            <path d="M7.5 3v12M12.5 5v12" />
          </svg>
          <span>Карта</span>
        </button>
        <span className="editor-divider" />
        <button
          type="button"
          className={`editor-tool editor-publish ${draft ? 'pending' : ''}`}
          disabled={publishing || !publisher}
          onClick={() => void publish()}
          title={
            draft
              ? 'Записать правки, вид (перепады, слои, оформление) и деревья в файлы данных — после коммита их увидят все на сайте'
              : 'Правки уже опубликованы; ещё раз — чтобы записать текущий вид (перепады, слои, оформление)'
          }
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 14V3M6 7l4-4 4 4M4 13v4h12v-4" />
          </svg>
          <span>{publishing ? 'Публикую…' : draft ? 'Опубликовать' : 'Опубликовано'}</span>
        </button>
        <span className="editor-divider" />
        <button type="button" className="editor-icon" title={`Отменить (${MOD}+Z)`} aria-label="Отменить" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button type="button" className="editor-icon" title={`Повторить (${MOD}+Shift+Z)`} aria-label="Повторить" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
        <div className="editor-menu-wrap">
          <button
            type="button"
            className="editor-icon editor-menu-button"
            title="Правки: сохранить, загрузить, сбросить"
            aria-label="Правки: сохранить, загрузить, сбросить"
            onClick={() => {
              setMenu(!menu);
              setUnderlayOpen(false);
            }}
          >
            ⋯{count > 0 && <i className="editor-count">{count}</i>}
          </button>
          {menu && <EditsMenu onClose={() => setMenu(false)}>
              <p className="muted">
                Правок: {count}. Черновик хранится в этом браузере; «Опубликовать» записывает правки в файлы проекта — после коммита их увидят все на сайте. Данные OSM не меняются.
              </p>
              <button type="button" className="button" disabled={isEmpty(edits)} onClick={exportEdits}>
                Сохранить в файл
              </button>
              <button type="button" className="button" onClick={() => fileInput.current?.click()}>
                Загрузить из файла
              </button>
              <button type="button" className="button" disabled={!draft} onClick={revertToPublished}>
                Вернуть как опубликовано
              </button>
              <button type="button" className="button" disabled={isEmpty(edits)} onClick={resetEdits}>
                Убрать все правки
              </button>
          </EditsMenu>}
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
