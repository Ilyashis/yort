const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

/** 850 → «850 м²», 12 345 → «1,23 га». */
export function formatArea(m2: number): string {
  return m2 >= 10_000 ? `${decimal.format(m2 / 10_000)} га` : `${integer.format(m2)} м²`;
}

/** 640 → «640 м», 1 250 → «1,25 км». */
export function formatLength(m: number): string {
  return m >= 1_000 ? `${decimal.format(m / 1_000)} км` : `${integer.format(m)} м`;
}
