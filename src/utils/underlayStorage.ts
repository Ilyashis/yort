// Подложка хранится в браузере (IndexedDB): снимок бывает в мегабайты — localStorage для него мал.
// Хранилище может быть недоступно (приватный режим) — тогда подложка живёт до перезагрузки.

import type { ImageSize, UnderlayPlacement } from '../world/edit/underlay';

export interface StoredUnderlay {
  blob: Blob;
  name: string;
  size: ImageSize;
  /** Ортофото GeoTIFF: система координат файла. */
  georef?: string;
  placement: UnderlayPlacement;
  opacity: number;
  visible: boolean;
}

const DB_NAME = 'citia';
const STORE = 'underlays';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

export const loadUnderlay = (territoryId: string) =>
  run<StoredUnderlay | undefined>('readonly', (s) => s.get(territoryId) as IDBRequest<StoredUnderlay | undefined>);

export const saveUnderlay = (territoryId: string, record: StoredUnderlay) => run('readwrite', (s) => s.put(record, territoryId));

export const deleteUnderlay = (territoryId: string) => run('readwrite', (s) => s.delete(territoryId));
