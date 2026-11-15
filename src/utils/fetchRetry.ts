// Загрузка файла данных с повторами: на мобильном интернете запрос иногда обрывается — без повтора деревня
// открылась бы без рельефа (а места, выровненные кистью, встали бы столбами).

/** Паузы перед повторами, мс. */
const RETRY_DELAYS = [400, 1200, 2500];

export async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const response = await fetch(url, init);
      // Ошибка сервера — повторим; 404 и прочие ответы — как есть (файла просто нет).
      if (response.status < 500 || attempt === RETRY_DELAYS.length) return response;
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS.length) break;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
  }
  throw lastError instanceof Error ? lastError : new Error(`Не удалось загрузить ${url}`);
}
