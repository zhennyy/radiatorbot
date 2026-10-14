// Фото товара или заглушка ♨️, если фото нет или оно не загрузилось.
import { escapeHtml } from '../utils/dom.js';

const NO_PHOTO_HTML = '<div class="noimg">♨️</div>';

export function productPhotoHtml(product) {
  if (product && product.photo) return `<img src="${escapeHtml(product.photo)}" alt="" loading="lazy" data-photo-fallback>`;
  return NO_PHOTO_HTML;
}

/** Битое фото товара заменяем заглушкой. Событие error не всплывает — ловим на этапе погружения. */
export function replaceBrokenPhotos() {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (image instanceof HTMLImageElement && image.hasAttribute('data-photo-fallback')) image.outerHTML = NO_PHOTO_HTML;
  }, true);
}
