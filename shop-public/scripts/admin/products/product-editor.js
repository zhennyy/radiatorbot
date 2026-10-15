// Редактор товара в шторке: фото, название, цена, остаток, категория, описание и перевод на английский.
import { callApi } from '../../api.js';
import { confirmAction, vibrate } from '../../telegram.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { productPhotoHtml } from '../../catalog/product-photo.js';
import { closeSheet, showSheet } from '../../catalog/product-sheet.js';
import { adminState } from '../admin-state.js';
import { reloadProducts } from './product-list.js';

const NEW_PRODUCT = { name: '', price: '', stock: 1, category: '', description: '' };

/** Значение поля формы: цена хранится в копейках, в форме — целые рубли */
function formValue(product, fieldName) {
  if (fieldName === 'price' && product.price) return Math.round(product.price / 100);
  return product[fieldName] ?? '';
}

function editorFormHtml(product, isNew) {
  const input = (fieldName, label, type = 'text', attributes = '') =>
    `<label>${label}</label><input name="${fieldName}" type="${type}" value="${escapeHtml(formValue(product, fieldName))}" ${attributes}>`;
  const categories = [...new Set(adminState.products.map((item) => item.category).filter(Boolean))];
  return `<form class="body form" id="pform">
      <h2>${isNew ? 'Новый товар' : 'Редактирование'}</h2>
      ${isNew ? '' : `<details><summary>Фото по ссылке</summary><div style="display:flex;gap:8px;margin-top:8px"><input id="photoUrl" placeholder="https://…" inputmode="url"><button class="btn" type="button" style="width:auto;padding:0 16px" data-action="set-photo-url" data-product-id="${product.id}">OK</button></div></details>`}
      ${input('name', 'Название')}
      <div class="two"><div>${input('price', 'Цена, ₽', 'number', 'inputmode="numeric" min="1"')}</div><div>${input('stock', 'Остаток, шт.', 'number', 'inputmode="numeric" min="0"')}</div></div>
      ${input('category', 'Категория', 'text', 'list="cats"')}
      <datalist id="cats">${categories.map((category) => `<option value="${escapeHtml(category)}">`).join('')}</datalist>
      <label>Описание</label><textarea name="description">${escapeHtml(product.description || '')}</textarea>
      <details><summary>English (необязательно)</summary>
        ${input('name_en', 'Name')}${input('category_en', 'Category')}<label>Description</label><textarea name="description_en">${escapeHtml(product.description_en || '')}</textarea>
      </details>
      <div class="actions">${isNew ? '' : `<button class="btn danger" type="button" data-action="delete-product" data-product-id="${product.id}" style="flex:1">Удалить</button>`}<button class="btn" data-action="save-product" style="flex:2">${isNew ? 'Создать' : 'Сохранить'}</button></div>
      ${isNew ? '<div class="note">Фото можно добавить сразу после создания</div>' : ''}
    </form>`;
}

export function openProductEditor(productId) {
  adminState.editingProductId = productId;
  const isNew = productId === 'new';
  const product = isNew ? NEW_PRODUCT : adminState.products.find((item) => item.id === Number(productId));
  if (!product) return;
  const photoHtml = isNew
    ? ''
    : `<div class="big photoEdit">${productPhotoHtml(product)}<button class="up" data-action="upload-photo" data-product-id="${product.id}">📷 ${product.has_photo ? 'Заменить фото' : 'Добавить фото'}</button></div>`;
  getElement('sheet').innerHTML = `<button class="x" data-action="close-sheet">✕</button>
    ${photoHtml}
    ${editorFormHtml(product, isNew)}`;
  // форма отправляется только кнопками: саму отправку браузером отменяем
  getElement('pform').addEventListener('submit', (event) => event.preventDefault());
  showSheet();
}

async function saveProduct() {
  const productData = Object.fromEntries(new FormData(getElement('pform')).entries());
  try {
    if (adminState.editingProductId === 'new') {
      const created = await callApi('/admin/products', productData, 1);
      showToast('Товар создан ✓');
      await reloadProducts();
      openProductEditor(created.id);
    } else {
      await callApi('/admin/products/' + adminState.editingProductId, productData, 1);
      showToast('Сохранено ✓');
      closeSheet();
      await reloadProducts();
    }
    vibrate('medium');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteProduct(productId) {
  if (!(await confirmAction('Удалить товар? Его уберут из каталога и корзин покупателей.'))) return;
  try {
    await callApi(`/admin/products/${productId}/delete`, {}, 1);
    showToast('Удалено');
    closeSheet();
    await reloadProducts();
  } catch (error) {
    showToast(error.message);
  }
}

function setPhotoFromUrl(productId) {
  const url = getElement('photoUrl').value.trim();
  callApi(`/admin/products/${productId}/photo-url`, { url }, 1)
    .then(async () => {
      showToast('Фото обновлено ✓');
      await reloadProducts();
      openProductEditor(productId);
    })
    .catch((error) => showToast(error.message));
}

export const productEditorActions = {
  'edit-product': (element) =>
    openProductEditor(element.dataset.productId === 'new' ? 'new' : Number(element.dataset.productId)),
  'save-product': () => saveProduct(),
  'delete-product': (element) => deleteProduct(Number(element.dataset.productId)),
  'set-photo-url': (element) => setPhotoFromUrl(Number(element.dataset.productId)),
};
