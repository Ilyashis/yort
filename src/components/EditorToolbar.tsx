import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useEditStore, type EditTool } from '../store/useEditStore';
import { alignHint, useUnderlayStore } from '../store/useUnderlayStore';
import { MOVE_HINT, UnderlayPanel } from './UnderlayPanel';
import { EMPTY_EDITS, ROAD_KINDS, isEmpty, parseEdits, type EditRoadKind } from '../world/edit/edits';

const TOOLS: { tool: EditTool; label: string; key: string; hint: string; icon: ReactNode }[] = [
  {
    tool: 'select',
    label: 'Выбор',
    key: 'V',
    hint: 'Клик — выбрать дом, дорогу или забор. Дом тяните мышью; белые точки — растянуть, оранжевая — повернуть. Delete — убрать.',
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
    hint: 'Ведите от любой дороги, как карандашом: концы прилипнут к соседним улицам.',
    icon: <path d="M6 18L9 2M14 18L11 2M10 4v2M10 9v2M10 14v2" />,
  },
  {
    tool: 'fence',
    label: 'Забор',
    key: 'B',
    hint: 'Ведите линию по земле — по ней встанет забор со столбами.',
    icon: <path d="M3 17V6l2-2 2 2v11M9 17V6l2-2 2 2v11M15 17V6l2-2 2 2v11M2 9h18M2 14h18" />,
  },
];

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
  const canUndo = useEditStore((s) => s.past.length > 0);
  const canRedo = useEditStore((s) => s.future.length > 0);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const edits = useEditStore((s) => s.edits);
  const notice = useEditStore((s) => s.notice);
  const [menu, setMenu] = useState(false);
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
    edits.buildings.length + edits.removedBuildings.length + edits.roads.length + edits.removedRoads.length + edits.fences.length + edits.removedYards.length;

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
      ) : (
        active && <div className="editor-hint">{active.hint}</div>
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
