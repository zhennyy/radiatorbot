// Шторка товара снизу экрана: фото, описание, наличие, цена и кнопка «В корзину».
// Та же шторка (#sheet) используется админкой для редактора товара и ввода трек-номера.
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { telegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatRubles } from '../utils/format.js';
import { productPhotoHtml } from './product-photo.js';
import { quantityStepperHtml } from './product-card.js';
import { findProduct, productName, productCategory, productDescription } from './product-helpers.js';

function stockLineHtml(product) {
  if (product.stock <= 0) return `<div class="stock" style="color:var(--bad)">${texts().outOfStock}</div>`;
  return `<div class="stock" style="color:var(--ok)">✓ ${texts().inStock(product.stock)}</div>`;
}

function buyButtonHtml(product, quantity) {
  if (product.stock <= 0) return '';
  if (quantity) return quantityStepperHtml(product, quantity);
  return `<button class="add" data-action="cart-add" data-product-id="${product.id}">${texts().addToCart}</button>`;
}

export function renderProductSheet() {
  const product = findProduct(state.openProductId);
  if (!product) return;
  const quantity = state.cart[product.id] || 0;
  getElement('sheet').innerHTML = `<button class="x" data-action="close-sheet">✕</button>
    <div class="big">${productPhotoHtml(product)}</div>
    <div class="body">
      ${productCategory(product) ? `<div class="cat">${escapeHtml(productCategory(product))}</div>` : ''}
      <h2>${escapeHtml(productName(product))}</h2>
      ${productDescription(product) ? `<p>${escapeHtml(productDescription(product))}</p>` : ''}
      ${stockLineHtml(product)}
      <div class="act"><div class="price">${formatRubles(product.price)}</div>${buyButtonHtml(product, quantity)}</div>
    </div>`;
}

/** Показать шторку (её содержимое уже отрисовано) */
export function showSheet() {
  document.body.classList.add('open');
  telegram?.BackButton?.show();
}

export function openProductSheet(productId) {
  state.openProductId = productId;
  renderProductSheet();
  showSheet();
}

export function closeSheet() {
  state.openProductId = null;
  document.body.classList.remove('open');
  if (state.activeTab === 'catalog') telegram?.BackButton?.hide();
}

export const isSheetOpen = () => document.body.classList.contains('open');

export const productSheetActions = {
  'open-product': (element) => openProductSheet(Number(element.dataset.productId)),
  'close-sheet': () => closeSheet(),
};
