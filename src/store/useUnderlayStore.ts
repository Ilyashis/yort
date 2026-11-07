import { create } from 'zustand';
import { deleteUnderlay, loadUnderlay, saveUnderlay } from '../utils/underlayStorage';
import { useEditStore } from './useEditStore';
import type { LonLat } from '../world/user/plot';
import type { Vec2 } from '../world/walk/localFrame';
import {
  fitPerspective,
  fitTwoPoints,
  imageCorners,
  imageToLocal,
  initialPlacement,
  isProjective,
  type ImageSize,
  type UnderlayPlacement,
} from '../world/edit/underlay';

/**
 * Что делает клик по сцене, пока открыта подложка: двигать её мышью или совмещать по точкам —
 * по двум (масштаб и поворот) или по четырём (ещё и перспектива кадра).
 */
export type UnderlayMode = 'move' | 'align2' | 'align4';

export interface UnderlayImage {
  blob: Blob;
  bitmap: ImageBitmap;
  name: string;
  size: ImageSize;
  /** Ортофото GeoTIFF: в какой системе координат был файл (для подписи в панели). */
  georef?: string;
}

/** Клики совмещения идут парами: точка на снимке (пиксели), та же точка на карте (метры). */
export interface AlignState {
  images: Vec2[];
  maps: Vec2[];
}

/** Что сцена даёт подложке: центр вида, пересчёт координат, перелёт к снимку. */
export interface UnderlayScene {
  viewCenter: () => Vec2 | undefined;
  toLocal: (point: LonLat) => Vec2;
  focus: (corners: Vec2[]) => void;
}

/** Итог загрузки файла: ошибка для пользователя или пояснение. */
export interface FileResult {
  error?: string;
  note?: string;
  georeferenced?: boolean;
}

interface UnderlayState {
  territoryId?: string;
  image?: UnderlayImage;
  placement?: UnderlayPlacement;
  opacity: number;
  visible: boolean;
  /** Спрятать дома и деревья OSM, чтобы снимок под ними было видно при обводке. */
  hideCity: boolean;
  mode?: UnderlayMode;
  align: AlignState;
  /** Идёт чтение большого файла. */
  busy: boolean;
  scene?: UnderlayScene;

  load: (territoryId: string) => Promise<void>;
  setFile: (file: File) => Promise<FileResult>;
  setPlacement: (placement: UnderlayPlacement) => void;
  /** Убрать перспективу: снимок снова ровный прямоугольник (масштаб и поворот — как были в среднем). */
  flatten: () => void;
  setOpacity: (opacity: number) => void;
  setVisible: (visible: boolean) => void;
  setHideCity: (hide: boolean) => void;
  setMode: (mode: UnderlayMode | undefined) => void;
  /** Очередной клик совмещения: точка на снимке (пиксели) или на карте (метры). */
  alignPoint: (point: Vec2) => void;
  /** Отменить последний клик совмещения. */
  alignBack: () => void;
  remove: () => void;
  setScene: (scene: UnderlayScene | undefined) => void;
}

const DEFAULTS = { opacity: 0.7, visible: true };
/** Дальше этого от центра места ортофото считаем «не отсюда» и предупреждаем. */
const FAR_M = 30_000;

export const alignTarget = (mode: UnderlayMode | undefined) => (mode === 'align4' ? 4 : 2);

/** Подсказка для текущего шага совмещения. */
export function alignHint(mode: UnderlayMode | undefined, align: AlignState): string {
  const target = alignTarget(mode);
  const index = align.maps.length + 1;
  const onImage = align.images.length === align.maps.length;
  const where = target === 4 ? ['', 'левом верхнем', 'правом верхнем', 'правом нижнем', 'левом нижнем'][index] : '';
  const prefix = `Точка ${index} из ${target}`;
  const tail = align.images.length > 0 ? ' Backspace — шаг назад, Esc — отменить.' : ' Esc — отменить.';
  if (onImage) {
    const hint =
      target === 4
        ? `кликните на снимке приметную точку в ${where} углу участка — угол дома, забора, столб.`
        : index === 1
          ? 'кликните на снимке приметную точку — угол дома или забора.'
          : 'кликните на снимке вторую точку — подальше от первой.';
    return `${prefix}: ${hint}${tail}`;
  }
  return `${prefix}: кликните, где эта точка на карте (на доме — по углу крыши).${tail}`;
}

const isTiff = (file: File) => /\.tiff?$/i.test(file.name) || file.type === 'image/tiff';

export const useUnderlayStore = create<UnderlayState>()((set, get) => {
  const persist = () => {
    const { territoryId, image, placement, opacity, visible } = get();
    if (territoryId && image && placement) {
      void saveUnderlay(territoryId, { blob: image.blob, name: image.name, size: image.size, georef: image.georef, placement, opacity, visible });
    }
  };

  /** Ортофото: читаем пиксели и привязку, снимок ложится по координатам файла. */
  const openGeoTiff = async (file: File, scene: UnderlayScene): Promise<FileResult & { image?: UnderlayImage; placement?: UnderlayPlacement }> => {
    const { readGeoTiff } = await import('../utils/geotiffImage');
    const tiff = await readGeoTiff(file);
    if ('error' in tiff) return { error: tiff.error };
    const placement = fitPerspective(
      tiff.points.map((p) => p.pixel),
      tiff.points.map((p) => scene.toLocal(p.lonLat)),
      'geotiff',
    );
    if (!placement) {
      tiff.bitmap.close();
      return { error: 'Привязка в файле вырожденная — снимок не положить на карту.' };
    }
    const [cx, cy] = imageToLocal([tiff.size[0] / 2, tiff.size[1] / 2], tiff.size, placement);
    const far = Math.hypot(cx, cy);
    const reduced = tiff.reducedFrom ? ` Снимок уменьшен с ${tiff.reducedFrom[0]}×${tiff.reducedFrom[1]} до ${tiff.size[0]}×${tiff.size[1]}.` : '';
    return {
      georeferenced: true,
      image: { blob: tiff.blob, bitmap: tiff.bitmap, name: file.name, size: tiff.size, georef: tiff.crs },
      placement,
      note:
        far > FAR_M
          ? `Ортофото лежит в ${Math.round(far / 1000)} км от этого места — проверьте, то ли место выбрано.${reduced}`
          : `Ортофото положено по координатам файла (${tiff.crs}).${reduced}`,
    };
  };

  return {
    ...DEFAULTS,
    hideCity: false,
    align: { images: [], maps: [] },
    busy: false,

    load: async (territoryId) => {
      get().image?.bitmap.close();
      set({ territoryId, image: undefined, placement: undefined, mode: undefined, align: { images: [], maps: [] }, hideCity: false, ...DEFAULTS });
      const stored = await loadUnderlay(territoryId);
      if (!stored || get().territoryId !== territoryId) return;
      try {
        const bitmap = await createImageBitmap(stored.blob);
        set({
          image: { blob: stored.blob, bitmap, name: stored.name, size: stored.size, georef: stored.georef },
          placement: stored.placement,
          opacity: stored.opacity,
          visible: stored.visible,
        });
      } catch {
        // Снимок повреждён — просто без подложки.
      }
    },

    setFile: async (file) => {
      const scene = get().scene;
      set({ busy: true });
      try {
        let image: UnderlayImage;
        let placement: UnderlayPlacement;
        let result: FileResult = {};
        if (isTiff(file)) {
          if (!scene) return { error: 'Сцена ещё не готова.' };
          const opened = await openGeoTiff(file, scene);
          if (!opened.image || !opened.placement) return { error: opened.error };
          ({ image, placement } = opened);
          result = { note: opened.note, georeferenced: true };
        } else {
          const bitmap = await createImageBitmap(file);
          const size: ImageSize = [bitmap.width, bitmap.height];
          image = { blob: file, bitmap, name: file.name, size };
          placement = initialPlacement(scene?.viewCenter() ?? [0, 0], size);
        }
        get().image?.bitmap.close();
        set({ image, placement, visible: true, mode: undefined, align: { images: [], maps: [] } });
        persist();
        if (result.georeferenced) scene?.focus(imageCorners(image.size, placement));
        return result;
      } catch {
        return { error: 'Не получилось открыть файл. Подойдут JPG, PNG, WebP и ортофото GeoTIFF.' };
      } finally {
        set({ busy: false });
      }
    },

    setPlacement: (placement) => {
      set({ placement });
      persist();
    },
    flatten: () => {
      const { image, placement } = get();
      if (!image || !placement || !isProjective(placement)) return;
      const [w, h] = image.size;
      const left: Vec2 = [0, h / 2];
      const right: Vec2 = [w, h / 2];
      const flat = fitTwoPoints(left, right, imageToLocal(left, image.size, placement), imageToLocal(right, image.size, placement), image.size);
      if (flat) get().setPlacement(flat);
    },
    setOpacity: (opacity) => {
      set({ opacity });
      persist();
    },
    setVisible: (visible) => {
      set({ visible });
      persist();
    },
    setHideCity: (hideCity) => set({ hideCity }),
    setMode: (mode) => set({ mode, align: { images: [], maps: [] } }),

    alignPoint: (point) => {
      const { align, image, placement, mode } = get();
      if (!image || !placement || (mode !== 'align2' && mode !== 'align4')) return;
      if (align.images.length === align.maps.length) return set({ align: { ...align, images: [...align.images, point] } });
      const maps = [...align.maps, point];
      if (maps.length < alignTarget(mode)) return set({ align: { ...align, maps } });
      const fit: UnderlayPlacement | undefined =
        mode === 'align4'
          ? fitPerspective(align.images, maps)
          : fitTwoPoints(align.images[0]!, align.images[1]!, maps[0]!, maps[1]!, image.size);
      set({ mode: undefined, align: { images: [], maps: [] } });
      if (fit) get().setPlacement(fit);
      else useEditStore.getState().notify('Точки не подошли: возьмите их подальше друг от друга и не на одной прямой');
    },
    alignBack: () => {
      const { align } = get();
      if (align.images.length > align.maps.length) set({ align: { ...align, images: align.images.slice(0, -1) } });
      else if (align.maps.length > 0) set({ align: { ...align, maps: align.maps.slice(0, -1) } });
    },

    remove: () => {
      const { territoryId, image } = get();
      image?.bitmap.close();
      set({ image: undefined, placement: undefined, mode: undefined, align: { images: [], maps: [] }, hideCity: false, ...DEFAULTS });
      if (territoryId) void deleteUnderlay(territoryId);
    },

    setScene: (scene) => set({ scene }),
  };
});

