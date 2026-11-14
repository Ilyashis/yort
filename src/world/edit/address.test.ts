import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, isEmpty, parseEdits, parseOsmAddress, plateText, setAddress } from './edits';

describe('адреса домов', () => {
  it('адрес из OSM — улица и номер', () => {
    expect(parseOsmAddress('улица Ленина, 85')).toEqual({ street: 'улица Ленина', number: '85' });
    expect(parseOsmAddress('12а')).toEqual({ street: '', number: '12а' });
    expect(parseOsmAddress(undefined)).toBeUndefined();
  });

  it('надпись таблички — улица сокращённо и номер', () => {
    expect(plateText({ street: 'улица Ленина', number: '38' })).toBe('ул. Ленина\n38');
    expect(plateText({ street: 'Урман юлы', number: '3' })).toBe('Урман юлы\n3');
    expect(plateText({ street: 'Садовый переулок', number: '7' })).toBe('Садовый пер.\n7');
  });

  it('пустой адрес убирается, правки сохраняются и читаются', () => {
    const one = setAddress(EMPTY_EDITS, 'way/1', { street: ' улица Ленина ', number: '5' });
    expect(one.addresses).toEqual({ 'way/1': { street: 'улица Ленина', number: '5' } });
    expect(isEmpty(one)).toBe(false);
    expect(parseEdits(JSON.parse(JSON.stringify(one)))?.addresses).toEqual(one.addresses);
    expect(setAddress(one, 'way/1', { street: '', number: ' ' }).addresses).toEqual({});
  });
});
