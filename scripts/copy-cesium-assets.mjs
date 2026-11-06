// Копирует статические ресурсы CesiumJS (воркеры, шейдеры, иконки виджетов)
// в public/cesium, откуда их грузит браузер по CESIUM_BASE_URL.
// Запускается автоматически после npm install и перед dev/build.
// Повторно копирует только при смене версии пакета cesium.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cesiumDir = join(root, 'node_modules', 'cesium');
const sourceDir = join(cesiumDir, 'Build', 'Cesium');
const targetDir = join(root, 'public', 'cesium');
const versionMarker = join(targetDir, '.version');
const folders = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

if (!existsSync(sourceDir)) {
  console.warn('[cesium] пакет cesium не установлен — пропускаю копирование ресурсов');
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(join(cesiumDir, 'package.json'), 'utf8'));

if (existsSync(versionMarker) && readFileSync(versionMarker, 'utf8').trim() === version) {
  process.exit(0);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
for (const folder of folders) {
  cpSync(join(sourceDir, folder), join(targetDir, folder), { recursive: true });
}
writeFileSync(versionMarker, `${version}\n`);
console.log(`[cesium] ресурсы Cesium ${version} скопированы в public/cesium`);
