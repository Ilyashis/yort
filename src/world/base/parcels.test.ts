import { describe, expect, it } from 'vitest';
import { addressLabel, ParcelIndex, parseAddress } from './parcels';

describe('адреса участков ЕГРН', () => {
  it('улица и номер из адреса с ориентиром', () => {
    const a =
      'Местоположение установлено относительно ориентира, расположенного в границах участка. Почтовый адрес ориентира: Российская Федерация, Республика Башкортостан, м.р-н Баймакский, с.п. 1-й Иткуловский сельсовет, с. 1-е Иткулово, ул. Победы, з/у 2.';
    expect(parseAddress(a)).toEqual({ street: 'ул. Победы', number: '2' });
  });

  it('разные записи улицы и номера', () => {
    expect(parseAddress('Респ Башкортостан, р-н Баймакский, с 1-е Иткулово, ул Ленина, д 85')).toEqual({ street: 'ул. Ленина', number: '85' });
    expect(parseAddress('с. 1-е Иткулово, улица Салавата Юлаева, дом 12 а')).toEqual({ street: 'ул. Салавата Юлаева', number: '12А' });
    expect(parseAddress('с. 1-е Иткулово, пер. Школьный, 3/1')).toEqual({ street: 'пер. Школьный', number: '3/1' });
    expect(parseAddress('село 1-е Иткулово, улица Ленина, земельный участок 85Б')).toEqual({ street: 'ул. Ленина', number: '85Б' });
  });

  it('без улицы или номера — нет адреса', () => {
    expect(parseAddress('Республика Башкортостан, р-н Баймакский, с/с 1-й Иткуловский')).toBeUndefined();
    expect(parseAddress('с. 1-е Иткулово, ул. Победы')).toBeUndefined();
    expect(parseAddress(undefined)).toBeUndefined();
  });

  it('участок по точке и подпись', () => {
    const index = new ParcelIndex([
      { cad: '1', ring: [[57.95, 52.63], [57.9502, 52.63], [57.9502, 52.6302], [57.95, 52.6302]], street: 'ул. Победы', number: '2' },
      { cad: '2', ring: [[57.9502, 52.63], [57.9504, 52.63], [57.9504, 52.6302], [57.9502, 52.6302]] },
    ]);
    expect(addressLabel(index.at([57.9501, 52.6301]))).toBe('ул. Победы, 2');
    expect(index.at([57.9503, 52.6301])?.cad).toBe('2');
    expect(addressLabel(index.at([57.9503, 52.6301]))).toBeUndefined();
    expect(index.at([57.96, 52.64])).toBeUndefined();
  });
});
