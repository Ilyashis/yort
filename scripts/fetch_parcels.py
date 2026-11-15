"""Кадастровые участки ЕГРН под домами района — из НСПД (nspd.gov.ru, Росреестр).

Для каждого дома (контуры из buildings.geojson и постройки съёмки из survey.json) — один запрос
GetFeatureInfo к слою «Земельные участки ЕГРН» в точке посередине дома; участки, уже известные по
прошлым запросам, повторно не спрашиваются. Запросы — не чаще раза в секунду. Итог — parcels.json
района: граница, кадастровый номер, адрес ЕГРН, вид использования, площадь. Владельцев в файле нет.

НСПД работает на сертификате «Russian Trusted Root CA» Минцифры (gu-st.ru), которого нет в системе:
путь к нему (PEM, корневой и промежуточный) передаётся явно, системные настройки не меняются.

    python3 -I scripts/fetch_parcels.py itkulovo-1 --ca ~/citia-drone-work/certs/bundle.pem
"""

import argparse
import datetime
import json
import math
import os
import ssl
import time
import urllib.error
import urllib.request

LAYER = 36048  # Земельные участки ЕГРН
WMS = f'https://nspd.gov.ru/api/aeggis/v3/{LAYER}/wms'
HEADERS = {'User-Agent': 'citia-parcels/1.0', 'Referer': 'https://nspd.gov.ru/map'}
R = 20037508.34


def merc(lon, lat):
    return lon * R / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * R / math.pi


def unmerc(x, y):
    return x * 180 / R, math.degrees(2 * math.atan(math.exp(y * math.pi / R)) - math.pi / 2)


def inside(pt, ring):
    x, y = pt
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def area_m2(ring):
    k = 111320 * math.cos(math.radians(ring[0][1]))
    s = 0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        s += (x1 * k) * (y2 * 111320) - (x2 * k) * (y1 * 111320)
    return abs(s) / 2


def centroid(ring):
    return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)


def house_points(folder):
    points = []
    for f in json.load(open(os.path.join(folder, 'buildings.geojson')))['features']:
        g = f['geometry']
        ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
        if 15 <= area_m2(ring) <= 600:
            points.append((f['properties']['id'], centroid(ring)))
    survey = os.path.join(folder, 'survey.json')
    if os.path.exists(survey):
        for b in json.load(open(survey)).get('buildings', []):
            if 15 <= area_m2(b['footprint']) <= 600:
                points.append((b['id'], centroid(b['footprint'])))
    return points


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('territory')
    ap.add_argument('--ca', required=True, help='PEM с сертификатами Минцифры')
    ap.add_argument('--state', help='промежуточный файл (продолжить прерванную выгрузку)')
    args = ap.parse_args()
    folder = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'territories', args.territory)
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=os.path.expanduser(args.ca))
    state_path = args.state or os.path.join(folder, '.parcels-state.json')
    state = json.load(open(state_path)) if os.path.exists(state_path) else {'parcels': {}, 'byBuilding': {}}

    def ask(lon, lat):
        x, y = merc(lon, lat)
        d = 40
        q = (
            'REQUEST=GetFeatureInfo&SERVICE=WMS&VERSION=1.3.0&FORMAT=image/png&STYLES=&TRANSPARENT=true'
            f'&LAYERS={LAYER}&QUERY_LAYERS={LAYER}&INFO_FORMAT=application/json&FEATURE_COUNT=5'
            f'&I=50&J=50&WIDTH=101&HEIGHT=101&CRS=EPSG:3857&BBOX={x - d},{y - d},{x + d},{y + d}'
        )
        req = urllib.request.Request(f'{WMS}?{q}', headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx, timeout=40) as r:
            return json.loads(r.read()).get('features', [])

    asked = 0
    for bid, (lon, lat) in house_points(folder):
        if bid in state['byBuilding']:
            continue
        hit = next((cad for cad, p in state['parcels'].items() if inside((lon, lat), p['ring'])), None)
        if hit:
            state['byBuilding'][bid] = hit
            continue
        try:
            features = ask(lon, lat)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            print('ошибка', bid, e)
            time.sleep(5)
            continue
        asked += 1
        state['byBuilding'][bid] = None
        for f in features:
            o = f['properties'].get('options', {})
            g = f['geometry']
            ring = g['coordinates'][0] if g['type'] == 'Polygon' else g['coordinates'][0][0]
            ring = [list(unmerc(*p)) for p in ring]
            state['parcels'][o['cad_num']] = {
                'ring': ring,
                'address': o.get('readable_address'),
                'use': o.get('permitted_use_established_by_document'),
                'area': o.get('specified_area') or o.get('declared_area'),
            }
            if inside((lon, lat), ring):
                state['byBuilding'][bid] = o['cad_num']
        if asked % 20 == 0:
            json.dump(state, open(state_path, 'w'), ensure_ascii=False)
            print(asked, 'запросов,', len(state['parcels']), 'участков', flush=True)
        time.sleep(1.0)
    json.dump(state, open(state_path, 'w'), ensure_ascii=False)

    parcels = []
    for cad, p in sorted(state['parcels'].items()):
        ring = [[round(x, 7), round(y, 7)] for x, y in p['ring']]
        if len(ring) > 1 and ring[0] == ring[-1]:
            ring = ring[:-1]
        item = {'cad': cad, 'ring': ring}
        for k in ('address', 'use', 'area'):
            if p.get(k):
                item[k] = p[k]
        parcels.append(item)
    out = {
        'metadata': {
            'source': 'НСПД (nspd.gov.ru), слой «Земельные участки ЕГРН»',
            'credit': '© Росреестр, НСПД',
            'fetched': datetime.date.today().isoformat(),
        },
        'parcels': parcels,
    }
    json.dump(out, open(os.path.join(folder, 'parcels.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('запросов', asked, '· участков', len(parcels), '· с адресом', sum(1 for p in parcels if p.get('address')))


if __name__ == '__main__':
    main()
