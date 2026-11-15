// Кадастровые участки ЕГРН (НСПД, Росреестр): точные границы и почтовые адреса. Файл parcels.json района
// собирает scripts/fetch_parcels.py; его может не быть — тогда участков и адресов нет.

import { territoryDataUrl, type Territory } from '../../config/territory';

export interface Parcel {
  /** Кадастровый номер. */
  cad: string;
  /** Граница: долгота/широта, без повтора первой точки. */
  ring: [number, number][];
  /** Адрес из ЕГРН как есть. */
  address?: string;
  /** Улица (как пишут на табличке: «ул. Победы») и номер дома или участка («2», «12А») — из address при загрузке. */
  street?: string;
  number?: string;
  /** Вид разрешённого использования («Под жилую застройку Индивидуальную»). */
  use?: string;
  /** Площадь по ЕГРН, м². */
  area?: number;
}

export interface ParcelsFile {
  metadata: { source: string; credit: string; fetched: string };
  parcels: Parcel[];
}

const STREET_KINDS: [RegExp, string][] = [
  [/^(?:улица|ул\.?)\s*/i, 'ул. '],
  [/^(?:переулок|пер\.?)\s*/i, 'пер. '],
  [/^(?:проспект|пр-кт|просп\.?)\s*/i, 'пр-т '],
  [/^(?:проезд|пр-д)\s*/i, 'проезд '],
  [/^(?:территория|тер\.?)\s*/i, 'тер. '],
];

/**
 * Улица и номер из адреса ЕГРН: «…, с. 1-е Иткулово, ул. Победы, з/у 2.» → { street: 'ул. Победы', number: '2' }.
 * Нет улицы или номера — undefined.
 */
export function parseAddress(address: string | undefined): { street: string; number: string } | undefined {
  if (!address) return undefined;
  const parts = address
    .replace(/\.$/, '')
    .split(',')
    .map((p) => p.trim());
  for (let i = 0; i < parts.length - 1; i++) {
    const kind = STREET_KINDS.find(([re]) => re.test(parts[i]!));
    if (!kind) continue;
    const name = parts[i]!.replace(kind[0], '').trim();
    const m = /^(?:земельный участок|д\.?|дом|з\/у|зу|уч\.?|участок|влд\.?)?\s*([0-9]+(?:\s*[а-яА-Яa-zA-Z])?(?:\/[0-9а-яА-Я]+)?)$/i.exec(parts[i + 1]!);
    if (!name || !m) continue;
    return { street: `${kind[1]}${name}`, number: m[1]!.replace(/\s+/g, '').toUpperCase() };
  }
  return undefined;
}

export async function loadParcels(territory: Territory): Promise<ParcelsFile | undefined> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'parcels.json'));
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return undefined;
    const file = (await response.json()) as ParcelsFile;
    for (const parcel of file.parcels) Object.assign(parcel, parseAddress(parcel.address));
    return file;
  } catch {
    return undefined;
  }
}

function insideRing([x, y]: readonly [number, number], ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Быстрый поиск участка по точке (долгота/широта): сетка ячеек по рамкам участков. */
export class ParcelIndex {
  private readonly cells = new Map<string, Parcel[]>();
  private static readonly CELL = 0.0005;

  constructor(readonly parcels: readonly Parcel[]) {
    for (const parcel of parcels) {
      const xs = parcel.ring.map((p) => p[0]);
      const ys = parcel.ring.map((p) => p[1]);
      for (let i = Math.floor(Math.min(...xs) / ParcelIndex.CELL); i <= Math.floor(Math.max(...xs) / ParcelIndex.CELL); i++) {
        for (let j = Math.floor(Math.min(...ys) / ParcelIndex.CELL); j <= Math.floor(Math.max(...ys) / ParcelIndex.CELL); j++) {
          const key = `${i}:${j}`;
          this.cells.set(key, [...(this.cells.get(key) ?? []), parcel]);
        }
      }
    }
  }

  at(point: readonly [number, number]): Parcel | undefined {
    const key = `${Math.floor(point[0] / ParcelIndex.CELL)}:${Math.floor(point[1] / ParcelIndex.CELL)}`;
    return this.cells.get(key)?.find((p) => insideRing(point, p.ring));
  }
}

/** Адрес для подписи: «ул. Победы, 2». */
export function addressLabel(parcel: Parcel | undefined): string | undefined {
  return parcel?.street && parcel.number ? `${parcel.street}, ${parcel.number}` : undefined;
}
