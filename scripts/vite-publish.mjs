// «Опубликовать» в редакторе: локальный сервер разработки (`npm run dev`) записывает правки деревни, вид
// (перепады рельефа и слои, view.json) и деревья по карте в файлы данных района (public/data/territories/<id>/edits.json и map-trees.json).
// В сборке для сайта этого нет. Дальше файлы коммитятся и уходят на сайт вместе с проектом.
// Отдельным JS-модулем: проверка типов проекта (tsc) идёт без типов Node.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Куда пишет «Опубликовать» (то же, что PUBLISH_URL в src/config/mode.ts). */
const PUBLISH_URL = '/__citia/publish';
const MAX_BODY = 20 * 1024 * 1024;

/** @returns {import('vite').Plugin} */
export function publishEdits() {
  return {
    name: 'citia-publish',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PUBLISH_URL, (req, res) => {
        const reply = (status, body) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return reply(405, { ok: false, error: 'только POST' });
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const territory = typeof body.territory === 'string' && /^[a-z0-9-]{1,64}$/.test(body.territory) ? body.territory : undefined;
            const folder = territory && resolve(server.config.root, 'public', 'data', 'territories', territory);
            if (!folder || !existsSync(folder)) return reply(400, { ok: false, error: 'нет такого населённого пункта' });
            if (!body.edits || typeof body.edits !== 'object') return reply(400, { ok: false, error: 'нет правок' });
            const files = ['edits.json'];
            await writeFile(join(folder, 'edits.json'), JSON.stringify(body.edits) + '\n');
            if (body.view && typeof body.view === 'object') {
              await writeFile(join(folder, 'view.json'), JSON.stringify(body.view) + '\n');
              files.push('view.json');
            }
            if (body.sculpt && typeof body.sculpt === 'object') {
              await writeFile(join(folder, 'sculpt.json'), JSON.stringify(body.sculpt) + '\n');
              files.push('sculpt.json');
            }
            if (body.mapTrees && typeof body.mapTrees === 'object') {
              await writeFile(join(folder, 'map-trees.json'), JSON.stringify(body.mapTrees) + '\n');
              files.push('map-trees.json');
            }
            reply(200, { ok: true, files: files.map((f) => `public/data/territories/${territory}/${f}`) });
          } catch (error) {
            reply(400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        });
      });
    },
  };
}
