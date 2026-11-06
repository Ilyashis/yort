/**
 * Личные настройки зрителя (звук, качество графики) в localStorage.
 * Хранилище может быть недоступно (приватный режим, запрет сайта) — тогда работаем со значениями по умолчанию.
 */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(`citia:${key}`);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(`citia:${key}`, value);
  } catch {
    // Настройка просто не запомнится — не критично.
  }
}
