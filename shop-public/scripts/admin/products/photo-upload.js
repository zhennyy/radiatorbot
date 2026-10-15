// Фото товара с телефона: уменьшаем до 1600 px в браузере, сжимаем в JPEG и отправляем на сервер.
import { authHeaders } from '../../api.js';
import { vibrate } from '../../telegram.js';
import { getElement } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { reloadProducts } from './product-list.js';
import { openProductEditor } from './product-editor.js';

const MAX_PHOTO_SIDE = 1600;
const JPEG_QUALITY = 0.85;
let photoProductId = null; // для какого товара выбирается файл

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

async function resizeToJpeg(file) {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

async function uploadSelectedPhoto(event) {
  const file = event.target.files[0];
  if (!file || !photoProductId) return;
  const productId = photoProductId;
  photoProductId = null;
  try {
    showToast('Загружаю фото…');
    const jpeg = await resizeToJpeg(file);
    const response = await fetch(`/shop-api/admin/products/${productId}/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', ...authHeaders() },
      body: jpeg,
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Не получилось загрузить');
    showToast('Фото обновлено ✓');
    vibrate('medium');
    await reloadProducts();
    openProductEditor(productId);
  } catch (error) {
    showToast(error.message || 'Не получилось загрузить');
  }
}

/** Скрытое поле выбора файла (#photoFile) общее для всех товаров */
export function listenToPhotoFileInput() {
  getElement('photoFile').addEventListener('change', uploadSelectedPhoto);
}

export const photoUploadActions = {
  'upload-photo': (element) => {
    photoProductId = Number(element.dataset.productId);
    getElement('photoFile').value = '';
    getElement('photoFile').click();
  },
};
