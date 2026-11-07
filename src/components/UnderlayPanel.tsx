import { useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore, type UnderlayMode } from '../store/useUnderlayStore';
import { isProjective } from '../world/edit/underlay';

/** Ширина снимка на местности, м: ползунок логарифмический (10 м … 3 км). */
const WIDTH_MIN = 10;
const WIDTH_MAX = 3000;
const toSlider = (width: number) => Math.round((Math.log(width / WIDTH_MIN) / Math.log(WIDTH_MAX / WIDTH_MIN)) * 1000);
const fromSlider = (value: number) => WIDTH_MIN * Math.pow(WIDTH_MAX / WIDTH_MIN, value / 1000);

export const MOVE_HINT = 'Тяните снимок мышью. Esc или «Готово» — закончить.';

/**
 * Подложка — свой снимок сверху (с дрона, план участка) или ортофото GeoTIFF: положить на карту,
 * совместить по точкам и обводить по нему дома и заборы инструментами редактора.
 */
export function UnderlayPanel({ onClose }: { onClose: () => void }) {
  const image = useUnderlayStore((s) => s.image);
  const placement = useUnderlayStore((s) => s.placement);
  const opacity = useUnderlayStore((s) => s.opacity);
  const visible = useUnderlayStore((s) => s.visible);
  const hideCity = useUnderlayStore((s) => s.hideCity);
  const mode = useUnderlayStore((s) => s.mode);
  const busy = useUnderlayStore((s) => s.busy);
  const store = useUnderlayStore.getState();
  const changeView = useAppStore((s) => s.changeView);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    const result = await store.setFile(file);
    if (result.error) return setError(result.error);
    if (result.note) useEditStore.getState().notify(result.note);
    // Сверху снимок лежит без искажений — так его удобнее подгонять (ортофото камера найдёт сама).
    if (!result.georeferenced) changeView?.('top');
  };
  const align = (target: UnderlayMode) => {
    store.setMode(mode === target ? undefined : target);
    if (mode !== target) changeView?.('top');
  };
  const projective = placement && isProjective(placement);
  const width = image && placement && !isProjective(placement) ? placement.metresPerPixel * image.size[0] : 0;
  const degrees = placement && !isProjective(placement) ? Math.round(((placement.rotation * 180) / Math.PI + 540) % 360) - 180 : 0;

  return (
    <div className="panel editor-menu underlay-panel" role="dialog" aria-label="Подложка">
      <button type="button" className="close" aria-label="Закрыть" onClick={onClose}>
        ×
      </button>
      <h2>Подложка</h2>
      {busy && <p className="underlay-busy">Читаю снимок…</p>}
      {error && <p className="underlay-error">{error}</p>}
      {!image ? (
        <>
          <p className="muted">
            Свой снимок сверху — с дрона или план участка. Ортофото GeoTIFF ляжет на место само, по координатам файла.
            Чужие снимки (Google, Яндекс) брать нельзя. Снимок хранится только в этом браузере.
          </p>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
            Выбрать фото или GeoTIFF
          </button>
        </>
      ) : (
        <>
          <p className="muted underlay-name" title={image.name}>
            {image.name} · {image.size[0]}×{image.size[1]}
            {image.georef && placement && isProjective(placement) && placement.source === 'geotiff' && <> · по координатам {image.georef}</>}
          </p>
          <label className="toggle">
            <input type="checkbox" checked={visible} onChange={(e) => store.setVisible(e.target.checked)} />
            Показывать
          </label>
          <label className="field">
            <span>
              Прозрачность <b>{Math.round((1 - opacity) * 100)}%</b>
            </span>
            <input type="range" min={0} max={95} value={Math.round((1 - opacity) * 100)} onChange={(e) => store.setOpacity(1 - Number(e.target.value) / 100)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={hideCity} onChange={(e) => store.setHideCity(e.target.checked)} />
            Спрятать дома и деревья OSM, чтобы видеть снимок
          </label>

          <div className="button-row">
            <button
              type="button"
              className={`button ${mode === 'align2' ? 'button-primary' : ''}`}
              title="Масштаб и поворот: для снимка строго сверху"
              onClick={() => align('align2')}
            >
              {mode === 'align2' ? 'Отменить' : 'По 2 точкам'}
            </button>
            <button
              type="button"
              className={`button ${mode === 'align4' ? 'button-primary' : ''}`}
              title="Ещё и перспектива: для кадра с дрона под углом. Точки — по углам участка"
              onClick={() => align('align4')}
            >
              {mode === 'align4' ? 'Отменить' : 'По 4 точкам'}
            </button>
            <button type="button" className={`button ${mode === 'move' ? 'button-primary' : ''}`} onClick={() => store.setMode(mode === 'move' ? undefined : 'move')}>
              {mode === 'move' ? 'Готово' : 'Двигать'}
            </button>
          </div>

          {placement && !isProjective(placement) && (
            <>
              <label className="field">
                <span>
                  Поворот <b>{degrees}°</b>
                </span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={0.5}
                  value={degrees}
                  onChange={(e) => store.setPlacement({ ...placement, rotation: (Number(e.target.value) * Math.PI) / 180 })}
                />
              </label>
              <label className="field">
                <span>
                  Ширина снимка на местности <b>{width >= 100 ? Math.round(width) : width.toFixed(1)} м</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1000}
                  value={toSlider(width)}
                  onChange={(e) => store.setPlacement({ ...placement, metresPerPixel: fromSlider(Number(e.target.value)) / image.size[0] })}
                />
              </label>
            </>
          )}
          {projective && (
            <p className="muted underlay-note">
              {placement.source === 'geotiff' ? 'Снимок лежит по координатам файла.' : 'Снимок выпрямлен по 4 точкам — перспектива кадра снята.'}{' '}
              <button type="button" className="link-button" onClick={() => store.flatten()}>
                Сделать ровным прямоугольником
              </button>
              , чтобы крутить и растягивать вручную.
            </p>
          )}

          <div className="button-row">
            <button type="button" className="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              Заменить
            </button>
            <button type="button" className="button" onClick={() => store.remove()}>
              Убрать подложку
            </button>
          </div>
        </>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/tiff,.tif,.tiff"
        hidden
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
