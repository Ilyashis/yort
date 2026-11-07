import type { LonLat } from '../world/user/plot';

/** Достопримечательность, для которой в OSM нет 3D-формы: пьедестал рисуем сами, статую — моделью. */
export interface Landmark {
  id: string;
  name: string;
  /** [долгота, широта] — точка памятника в OSM. */
  position: LonLat;
  /** Куда смотрит фигура, градусы от севера по часовой стрелке (приблизительно). */
  heading: number;
  kind: 'equestrian-statue';
  osm?: string;
  /** Модель статуи в public/ (GLB в метрах, основание в нуле), ставится на пьедестал. */
  model?: string;
}

export const LANDMARKS: Landmark[] = [
  {
    id: 'salavat-yulaev',
    name: 'Памятник Салавату Юлаеву',
    // historic=monument, height=14 (не путать с причалом «Салават Юлаев» у набережной).
    position: [55.9258453, 54.7184771],
    heading: 250,
    kind: 'equestrian-statue',
    osm: 'node/656228306',
    // Слеплена в коде: scripts/sculpt-statue.mjs (npm run models:statue).
    model: 'models/salavat-yulaev.glb',
  },
];
