/**
 * Редактор или просмотр. Редактор — только при локальной разработке (`npm run dev` на своём компьютере):
 * там правки деревни рисуют и кнопкой «Опубликовать» записывают в файлы данных проекта. Сборка для сайта
 * (`npm run build`, Vercel) — только просмотр: деревня — из опубликованных файлов, одна для всех; ходьба,
 * поездка, общий вид, время суток, звук и картинка.
 */
export const CAN_EDIT: boolean = import.meta.env.DEV;

/** Опубликованные правки и деревья по карте — файлы в папке данных района. */
export const PUBLISHED_EDITS = 'edits.json';
export const PUBLISHED_MAP_TREES = 'map-trees.json';
/** Опубликованный вид деревни: перепады рельефа и слои — как у редактора в момент публикации. */
export const PUBLISHED_VIEW = 'view.json';
/** Готовое поле правок рельефа кистью (чтобы сайт не пересчитывал мазки при открытии). */
export const PUBLISHED_SCULPT = 'sculpt.json';
/** Адрес, по которому локальный сервер разработки записывает опубликованное (в сборке его нет). */
export const PUBLISH_URL = '/__citia/publish';

/** Служебный доступ к сцене из консоли (window.__city и др.): у редактора всегда, на сайте — по адресу с ?debug. */
export const DEBUG: boolean = import.meta.env.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'));
