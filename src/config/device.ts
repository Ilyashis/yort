/**
 * Облегчённая графика — на телефонах и планшетах (палец вместо мыши) или по адресу с ?lite: меньше пикселей,
 * два каскада теней вместо четырёх, без мягких теней в углах, дальние деревья не рисуются, меньше снежинок.
 */
export const LITE: boolean =
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || new URLSearchParams(window.location.search).has('lite'));
