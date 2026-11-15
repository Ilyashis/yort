// Компьютер: тот же стеклянный каркас, что на телефоне, но под мышь и клавиатуру. Сверху — место, компас и 2D,
// справа — кнопки с подсказками при наведении, внизу по центру — режимы с клавишами 1/2/3, слева внизу — шпаргалка
// клавиш, которая бледнеет. Все настройки — одна панель справа (Esc или ⚙). H — спрятать интерфейс.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Volumes } from '../audio/AudioEngine';
import { CAN_EDIT } from '../config/mode';
import { findTerritory, territories } from '../config/territory';
import { isOnStreet, useAppStore } from '../store/useAppStore';
import { formatTime } from '../three/dayNight';
import { isTypingTarget } from '../three/OverviewControls';
import { CAR_COLORS } from '../world/drive/carModel';
import { Minimap } from './Minimap';
import {
  AtmosphereControls,
  AtmosphereIcon,
  BackIcon,
  CameraIcon,
  CarIcon,
  ChevronDown,
  Compass,
  Icon,
  OverviewIcon,
  SoundOffIcon,
  SoundOnIcon,
  WalkIcon,
} from './MobileUi';
import { useDismiss } from './useDismiss';

type Tab = 'atmosphere' | 'sound' | 'look' | 'keys';

const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </Icon>
);
const HideIcon = () => (
  <Icon>
    <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M4 20L20 4" />
  </Icon>
);
const MouseIcon = () => (
  <Icon size={16}>
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v3" />
  </Icon>
);
const CloseIcon = () => (
  <Icon size={20}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

const K = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

/** Круглая кнопка с подсказкой при наведении: название и клавиша. */
function HudButton({
  tip,
  hotkey,
  onClick,
  on,
  children,
  className = '',
}: {
  tip: string;
  hotkey?: string;
  onClick: () => void;
  on?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="d-tip-wrap">
      <button type="button" className={`m-glass m-round d-round ${on ? 'on' : ''} ${className}`} onClick={onClick} aria-label={tip} aria-pressed={on}>
        {children}
      </button>
      <span className="m-glass d-tip" role="tooltip">
        {tip}
        {hotkey && <K>{hotkey}</K>}
      </span>
    </div>
  );
}

// --- панель настроек -----------------------------------------------------------------------------

const VOLUME_ROWS: { key: keyof Volumes; label: string }[] = [
  { key: 'master', label: 'Общая громкость' },
  { key: 'music', label: 'Музыка' },
  { key: 'ambience', label: 'Звуки: машины, птицы, вода' },
  { key: 'sfx', label: 'Шаги и щелчки' },
];

function OnOff({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <div className={`m-row ${disabled ? 'd-disabled' : ''}`}>
      <span>{label}</span>
      <div className="m-seg m-seg-small d-seg-small" role="group" aria-label={label}>
        <button type="button" className={on ? '' : 'on'} onClick={() => onChange(false)} disabled={disabled}>
          Выкл
        </button>
        <button type="button" className={on ? 'on' : ''} onClick={() => onChange(true)} disabled={disabled}>
          Вкл
        </button>
      </div>
    </div>
  );
}

function SoundTab() {
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const volumes = useAppStore((s) => s.volumes);
  const setVolumes = useAppStore((s) => s.setVolumes);
  return (
    <>
      <OnOff label="Звук" on={soundOn} onChange={setSoundOn} />
      {VOLUME_ROWS.map(({ key, label }) => (
        <label key={key} className={`m-volume ${soundOn ? '' : 'd-disabled'}`}>
          <span>
            {label} <b>{Math.round(volumes[key] * 100)}%</b>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volumes[key] * 100)}
            disabled={!soundOn}
            onChange={(e) => setVolumes({ [key]: Number(e.target.value) / 100 })}
          />
        </label>
      ))}
      <p className="m-note">Браузер включит звук после первого клика по странице.</p>
    </>
  );
}

function LookTab() {
  const quality = useAppStore((s) => s.graphicsQuality);
  const setQuality = useAppStore((s) => s.setGraphicsQuality);
  const haze = useAppStore((s) => s.haze);
  const setHaze = useAppStore((s) => s.setHaze);
  const blur = useAppStore((s) => s.blur);
  const setBlur = useAppStore((s) => s.setBlur);
  const outlines = useAppStore((s) => s.outlines);
  const setOutlines = useAppStore((s) => s.setOutlines);
  const carColor = useAppStore((s) => s.carColor);
  const setCarColor = useAppStore((s) => s.setCarColor);
  const high = quality === 'high';
  return (
    <>
      <OnOff label="Мягкие тени в углах" on={high} onChange={(on) => setQuality(on ? 'high' : 'normal')} />
      <OnOff label="Дымка вдали" on={haze} onChange={setHaze} />
      <OnOff label="Размытие вдали" on={blur} onChange={setBlur} disabled={!high} />
      <OnOff label="Контуры, как на рисунке" on={outlines} onChange={setOutlines} disabled={!high} />
      <div className="m-row">
        <span>Цвет машины</span>
        <div className="car-colors m-car-colors" role="radiogroup" aria-label="Цвет машины">
          {CAR_COLORS.map(({ color, name }) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={carColor === color}
              className={`car-color ${carColor === color ? 'on' : ''}`}
              style={{ background: color }}
              title={name}
              aria-label={name}
              onClick={() => setCarColor(color)}
            />
          ))}
        </div>
      </div>
      <p className="m-note">Мягкие тени нагружают видеокарту — на слабом компьютере выключите. Размытие и контуры работают вместе с ними.</p>
    </>
  );
}

const KEY_ROWS: { title: string; rows: [ReactNode, string][] }[] = [
  {
    title: 'Везде',
    rows: [
      [
        <>
          <K>1</K> <K>2</K> <K>3</K>
        </>,
        'обзор, пешком, на машине',
      ],
      [<K key="t">T</K>, 'время суток и время года'],
      [<K key="h">H</K>, 'спрятать интерфейс'],
      [<K key="esc">Esc</K>, 'настройки; на улице — назад к обзору'],
    ],
  },
  {
    title: 'Обзор',
    rows: [
      ['левая кнопка мыши', 'двигать карту'],
      ['правая кнопка, колесо', 'вращать; ближе и дальше'],
      [
        <>
          <K>W</K>
          <K>A</K>
          <K>S</K>
          <K>D</K> <K>Q</K>
          <K>E</K> <K>R</K>
          <K>F</K>
        </>,
        'двигать, вращать, ближе и дальше',
      ],
      ['двойной клик', 'подлететь к точке'],
    ],
  },
  {
    title: 'Пешком',
    rows: [
      [
        <>
          <K>W</K>
          <K>A</K>
          <K>S</K>
          <K>D</K>, <K>Shift</K>
        </>,
        'идти, бегом',
      ],
      ['клик по сцене, мышь', 'смотреть (Esc — отпустить курсор)'],
      [<K key="f">F</K>, 'сесть в машину (на улице)'],
    ],
  },
  {
    title: 'На машине',
    rows: [
      [
        <>
          <K>W</K>
          <K>S</K> <K>A</K>
          <K>D</K>
        </>,
        'газ и тормоз, руль',
      ],
      [<K key="sp">Пробел</K>, 'ручник'],
      [
        <>
          <K>C</K> <K>R</K>
        </>,
        'камера; вернуть на дорогу',
      ],
      [<K key="f2">F</K>, 'выйти пешком'],
    ],
  },
];

function KeysTab() {
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);
  return (
    <>
      {KEY_ROWS.map((group) => (
        <div key={group.title} className="d-keys">
          <h4>{group.title}</h4>
          <dl>
            {/* У редактора T — инструмент «Дорога», атмосфера — только кнопкой. */}
            {group.rows
              .filter(([, what]) => !(CAN_EDIT && what.startsWith('время суток')))
              .map(([keys, what], i) => (
                <div key={i}>
                  <dt>{keys}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
      {CAN_EDIT && (
        <button type="button" className="m-list-button" onClick={() => setHelpOpen(true)}>
          Справка редактора
        </button>
      )}
    </>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'atmosphere', label: 'Атмосфера' },
  { id: 'sound', label: 'Звук' },
  { id: 'look', label: 'Вид' },
  { id: 'keys', label: 'Клавиши' },
];

function SettingsPanel({ tab, setTab, onClose }: { tab: Tab; setTab: (tab: Tab) => void; onClose: () => void }) {
  const ref = useDismiss(onClose, '.d-settings-opener');
  const hours = useAppStore((s) => s.timeOfDay);
  return (
    <aside ref={ref} className="m-glass d-settings" role="dialog" aria-label="Настройки">
      <header className="d-settings-head">
        <span>Настройки</span>
        <button type="button" className="d-close" onClick={onClose} aria-label="Закрыть">
          {!CAN_EDIT && <K>Esc</K>}
          <CloseIcon />
        </button>
      </header>
      <div className="d-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="d-settings-body">
        {tab === 'atmosphere' && (
          <>
            <div className="d-time-head">
              <span>Время суток</span>
              <b>{formatTime(hours)}</b>
            </div>
            <AtmosphereControls />
          </>
        )}
        {tab === 'sound' && <SoundTab />}
        {tab === 'look' && <LookTab />}
        {tab === 'keys' && <KeysTab />}
      </div>
    </aside>
  );
}

// --- части HUD -----------------------------------------------------------------------------------

function ModeSwitch({ top }: { top: boolean }) {
  const mode = useAppStore((s) => s.mode);
  const ready = useAppStore((s) => s.status === 'ready');
  const active = mode === 'walk' || mode === 'pick-walk-start' ? 'walk' : mode === 'drive' || mode === 'pick-drive-start' ? 'drive' : 'overview';
  const items: { id: 'overview' | 'walk' | 'drive'; label: string; key: string; icon: ReactNode }[] = [
    { id: 'overview', label: 'Обзор', key: '1', icon: <OverviewIcon /> },
    { id: 'walk', label: 'Пешком', key: '2', icon: <WalkIcon /> },
    { id: 'drive', label: 'Машина', key: '3', icon: <CarIcon /> },
  ];
  return (
    <nav className={`m-glass m-seg d-modes ${top ? 'd-modes-top' : ''}`} aria-label="Режим">
      {items.map((item) => (
        <button key={item.id} type="button" className={active === item.id ? 'on' : ''} onClick={() => chooseMode(item.id)} disabled={!ready}>
          {item.icon}
          {item.label}
          <K>{item.key}</K>
        </button>
      ))}
    </nav>
  );
}

/** Режим по кнопке или клавише 1/2/3: из обзора — выбрать точку старта, на улице — пересесть или вернуться. */
function chooseMode(kind: 'overview' | 'walk' | 'drive') {
  const { mode, walkControls: controls, status } = useAppStore.getState();
  if (!controls || status !== 'ready') return;
  if (kind === 'overview') {
    if (isOnStreet(mode)) controls.exit();
    else controls.cancelPick();
  } else if (isOnStreet(mode)) {
    if (mode !== kind) controls.switchTo(kind);
  } else if (mode === (kind === 'walk' ? 'pick-walk-start' : 'pick-drive-start')) {
    controls.cancelPick();
  } else {
    controls.pickStart(kind);
  }
}

/** Шпаргалка клавиш в углу: при входе в режим — ярко, через 10 с бледнеет (наведите — снова ярко). */
function KeyHints({ children, mode }: { children: ReactNode; mode: string }) {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    setFaded(false);
    const timer = window.setTimeout(() => setFaded(true), 10000);
    return () => window.clearTimeout(timer);
  }, [mode]);
  return <div className={`m-glass d-hints ${faded ? 'faded' : ''}`}>{children}</div>;
}

function Speedometer() {
  const hud = useAppStore((s) => s.driveHud);
  const share = Math.min(1, Math.abs(hud.speed) / 100);
  const arc = 264;
  return (
    <div className="m-glass d-speedo" aria-live="off">
      <svg viewBox="0 0 132 132" aria-hidden="true">
        <circle
          cx="66"
          cy="66"
          r="56"
          fill="none"
          stroke="rgba(255,255,255,.15)"
          strokeWidth="6"
          strokeDasharray={`${arc} 352`}
          transform="rotate(135 66 66)"
          strokeLinecap="round"
        />
        <circle
          cx="66"
          cy="66"
          r="56"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="6"
          strokeDasharray={`${Math.max(0.01, share * arc)} 352`}
          transform="rotate(135 66 66)"
          strokeLinecap="round"
        />
      </svg>
      <b>{hud.speed}</b>
      <span>км/ч</span>
      <span className="d-gear">{hud.gear}</span>
    </div>
  );
}

function StreetName() {
  const street = useAppStore((s) => s.walkStreet);
  return street ? <div className="m-glass m-pill d-street">{street}</div> : null;
}

// --- всё вместе ----------------------------------------------------------------------------------

export function DesktopUi() {
  const mode = useAppStore((s) => s.mode);
  const territoryId = useAppStore((s) => s.territoryId);
  const setTerritory = useAppStore((s) => s.setTerritory);
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const viewMode = useAppStore((s) => s.viewMode);
  const changeView = useAppStore((s) => s.changeView);
  const controls = useAppStore((s) => s.walkControls);
  const drive = useAppStore((s) => s.driveControls);
  const street = useAppStore((s) => s.walkStreet);
  const locked = useAppStore((s) => s.walkMouseLocked);
  const hidden = useAppStore((s) => s.hudHidden);
  const setHidden = useAppStore((s) => s.setHudHidden);
  const [settings, setSettings] = useState<Tab | undefined>();
  const [lastTab, setLastTab] = useState<Tab>('atmosphere');
  const closeSettings = useCallback(() => setSettings(undefined), []);
  const openSettings = useCallback(
    (tab?: Tab) => {
      setSettings((open) => {
        const next = tab ?? lastTab;
        return open === next ? undefined : next;
      });
    },
    [lastTab],
  );
  const setTab = (tab: Tab) => {
    setLastTab(tab);
    setSettings(tab);
  };
  const territory = findTerritory(territoryId);
  const onStreet = isOnStreet(mode);
  const picking = mode === 'pick-walk-start' || mode === 'pick-drive-start';

  // Клавиши: 1/2/3 — режимы, T — атмосфера, H — спрятать интерфейс, F — сесть в машину / выйти, Esc — настройки.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const state = useAppStore.getState();
      const street = isOnStreet(state.mode);
      if (event.code === 'Escape') {
        // Открыты настройки — Esc закрывает их (useDismiss), дальше не идёт. В обзоре сайта — открывает.
        if (!settings && !street && !CAN_EDIT && state.mode === 'explore' && !state.selectedBuilding) setSettings(lastTab);
        return;
      }
      if (event.code === 'KeyH') {
        state.setHudHidden(!state.hudHidden);
        return;
      }
      if (state.hudHidden) return;
      if (event.code === 'Digit1') chooseMode('overview');
      else if (event.code === 'Digit2') chooseMode('walk');
      else if (event.code === 'Digit3') chooseMode('drive');
      else if (event.code === 'KeyT' && !CAN_EDIT) {
        // У редактора T — инструмент «Дорога».
        setLastTab('atmosphere');
        setSettings((open) => (open === 'atmosphere' ? undefined : 'atmosphere'));
      } else if (event.code === 'KeyF' && street) {
        if (state.mode === 'drive') state.walkControls?.switchTo('walk');
        else if (state.walkStreet) state.walkControls?.switchTo('drive');
      }
    };
    // В фазе захвата: видим режим до того, как Esc отменит выбор точки старта.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [settings, lastTab]);

  if (hidden) {
    return (
      <div className="m-ui d-ui">
        <div className="m-glass d-hidden-note">
          <K>H</K> — вернуть интерфейс
        </div>
      </div>
    );
  }

  const rightButtons = (
    <>
      <HudButton
        tip="Атмосфера"
        hotkey={CAN_EDIT ? undefined : 'T'}
        className="d-settings-opener"
        on={settings === 'atmosphere'}
        onClick={() => openSettings('atmosphere')}
      >
        <AtmosphereIcon />
      </HudButton>
      <HudButton tip={soundOn ? 'Выключить звук' : 'Включить звук'} on={soundOn} onClick={() => setSoundOn(!soundOn)}>
        {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
      </HudButton>
      <HudButton tip="Спрятать интерфейс" hotkey="H" onClick={() => setHidden(true)}>
        <HideIcon />
      </HudButton>
      <HudButton
        tip="Настройки"
        hotkey={CAN_EDIT ? undefined : 'Esc'}
        className="d-settings-opener"
        on={!!settings && settings !== 'atmosphere'}
        onClick={() => openSettings(lastTab === 'atmosphere' ? 'sound' : lastTab)}
      >
        <GearIcon />
      </HudButton>
    </>
  );

  return (
    <div className={`m-ui d-ui d-ui-${mode} ${settings ? 'd-ui-settings' : ''}`}>
      {!onStreet && (
        <>
          {/* У редактора место выбирают в его панели слева. */}
          {!CAN_EDIT && (
            <div className="d-top-left">
              {territories.length < 2 ? (
                <button type="button" className="m-glass m-pill" onClick={() => useAppStore.getState().flyHome?.()} title="Показать всю деревню">
                  {territory?.shortName}
                </button>
              ) : (
                <label className="m-glass m-pill d-place">
                  <select value={territoryId} onChange={(e) => setTerritory(e.target.value)} aria-label="Населённый пункт">
                    {territories.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <span>{territory?.shortName}</span>
                  <ChevronDown />
                </label>
              )}
              <span className="d-brand">AI UFA</span>
            </div>
          )}
          <div className="d-top-right">
            <Compass />
            <button
              type="button"
              className="m-glass m-round m-small m-text"
              onClick={() => changeView?.(viewMode === 'top' ? 'tilt' : 'top')}
              title={viewMode === 'top' ? 'Вид под углом' : 'Вид сверху'}
            >
              {viewMode === 'top' ? '3D' : '2D'}
            </button>
          </div>
          <div className="d-side">{rightButtons}</div>
        </>
      )}

      {onStreet && (
        <>
          <div className="d-top-left">
            <button type="button" className="m-glass m-pill" onClick={() => controls?.exit()}>
              <BackIcon />
              Обзор <K>Esc</K>
            </button>
            {mode === 'drive' && (
              <button type="button" className="m-glass m-pill" onClick={() => controls?.switchTo('walk')}>
                <WalkIcon />
                Выйти <K>F</K>
              </button>
            )}
          </div>
          <StreetName />
          <div className="d-street-right">
            <Minimap />
            <div className="d-row-buttons">
              {mode === 'drive' && (
                <HudButton tip="Камера: сзади или из кабины" hotkey="C" onClick={() => drive?.toggleView()}>
                  <CameraIcon />
                </HudButton>
              )}
              {rightButtons}
            </div>
          </div>
          {locked && <div className="crosshair" aria-hidden="true" />}
        </>
      )}

      {picking && (
        <div className="m-glass m-banner d-banner" role="status">
          <span>
            {mode === 'pick-drive-start'
              ? 'Кликните по улице — машина встанет на ближайшую дорогу'
              : 'Кликните по улице или площади — окажетесь там на уровне глаз'}
          </span>
          <button type="button" className="m-banner-button" onClick={() => controls?.cancelPick()}>
            Отмена <K>Esc</K>
          </button>
        </div>
      )}

      {mode === 'walk' && street && (
        <button type="button" className="m-glass d-prompt" onClick={() => controls?.switchTo('drive')}>
          <K>F</K>
          Сесть в машину
        </button>
      )}

      {mode === 'drive' && <Speedometer />}

      {mode === 'explore' && !CAN_EDIT && (
        <KeyHints mode={mode}>
          <span>
            <MouseIcon /> левой — двигать
          </span>
          <span>правой — вращать, колесо — ближе</span>
          <span>
            <K>W</K>
            <K>A</K>
            <K>S</K>
            <K>D</K> <K>Q</K>
            <K>E</K> тоже
          </span>
        </KeyHints>
      )}
      {mode === 'walk' && (
        <KeyHints mode={mode}>
          <span>
            <K>W</K>
            <K>A</K>
            <K>S</K>
            <K>D</K> идти, <K>Shift</K> бегом
          </span>
          <span>
            <MouseIcon /> {locked ? 'смотреть; Esc — отпустить курсор' : 'клик по сцене — смотреть мышью'}
          </span>
          <span>
            <K>Q</K>
            <K>E</K> повернуться
          </span>
        </KeyHints>
      )}
      {mode === 'drive' && (
        <KeyHints mode={mode}>
          <span>
            <K>W</K>
            <K>S</K> газ, тормоз
          </span>
          <span>
            <K>A</K>
            <K>D</K> руль, <K>Пробел</K> ручник
          </span>
          <span>
            <K>Shift</K> быстрее
          </span>
          <span>
            <K>C</K> камера, <K>R</K> на дорогу
          </span>
        </KeyHints>
      )}

      <ModeSwitch top={CAN_EDIT && !onStreet} />

      {settings && <SettingsPanel tab={settings} setTab={setTab} onClose={closeSettings} />}
    </div>
  );
}
