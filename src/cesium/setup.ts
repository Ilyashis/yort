// Должен импортироваться до первого обращения к Cesium:
// отсюда Cesium грузит воркеры, шейдеры и иконки (см. scripts/copy-cesium-assets.mjs).
window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

export {};
