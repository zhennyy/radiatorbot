// Карточка товара в сетке каталога (и в результатах AI-подбора) и кнопки количества «− 2 +».
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { escapeHtml } from '../utils/dom.js';
import { formatRubles } from '../utils/format.js';
import { productPhotoHtml } from './product-photo.js';
import { productName, productCategory } from './product-helpers.js';

const LOW_STOCK_PIECES = 3;

function stockTagHtml(product) {
  if (product.stock <= 0) return `<span class="tag out">${texts().outOfStock}</span>`;
  if (product.stock <= LOW_STOCK_PIECES) return `<span class="tag low">${texts().lowStock(product.stock)}</span>`;
  return '';
}

/** Счётчик «− количество +» (карточка, шторка, корзина) */
export const quantityStepperHtml = (product, quantity) =>
  `<div class="step"><button data-action="cart-remove-one" data-product-id="${product.id}">−</button>` +
  `<span>${quantity}</span>` +
  `<button data-action="cart-add" data-product-id="${product.id}">+</button></div>`;

/** Кнопка «+» или счётчик «− количество +» для товара */
export function quantityControlHtml(product) {
  const quantity = state.cart[product.id] || 0;
  if (product.stock <= 0) return '<button class="add" disabled>+</button>';
  if (!quantity)
    return `<button class="add" data-action="cart-add" data-product-id="${product.id}" aria-label="${texts().addToCart}">+</button>`;
  return quantityStepperHtml(product, quantity);
}

export const productCardHtml = (product) => `
  <article class="card ${product.stock <= 0 ? 'out' : ''}" data-action="open-product" data-product-id="${product.id}">
    <div class="ph">${productPhotoHtml(product)}${stockTagHtml(product)}</div>
    <div class="info">
      ${productCategory(product) ? `<div class="cat">${escapeHtml(productCategory(product))}</div>` : ''}
      <div class="name">${escapeHtml(productName(product))}</div>
      <div class="row"><div class="price">${formatRubles(product.price)}</div><div data-quantity-control-for="${product.id}">${quantityControlHtml(product)}</div></div>
    </div>
  </article>`;
