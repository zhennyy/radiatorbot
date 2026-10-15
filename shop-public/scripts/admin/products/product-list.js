// Админка → «Товары»: кнопки (новый товар, резервная копия) и список товаров с остатками.
import { state } from '../../state.js';
import { callApi } from '../../api.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { formatRubles } from '../../utils/format.js';
import { productPhotoHtml } from '../../catalog/product-photo.js';
import { renderCategoryChips, renderProductGrid } from '../../catalog/catalog-view.js';
import { renderCart } from '../../cart/cart-view.js';
import { adminState } from '../admin-state.js';

const LOW_STOCK_PIECES = 3;

const TOOLBAR_HTML = `<div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn" data-action="edit-product" data-product-id="new" style="flex:2">＋ Новый товар</button><button class="btn ghost" data-action="request-backup" style="flex:1">📦 Копия</button></div>`;

function stockSummary(product) {
  if (product.stock <= 0) return '<span class="warn">нет в наличии</span>';
  if (product.stock <= LOW_STOCK_PIECES) return `<span class="warn">осталось ${product.stock}</span>`;
  return `${product.stock} шт.`;
}

const productRowHtml = (product) => `
    <div class="aline" data-action="edit-product" data-product-id="${product.id}">
      <div class="thumb">${productPhotoHtml(product)}</div>
      <div class="mid"><div class="t">${escapeHtml(product.name)}</div>
        <div class="s">${formatRubles(product.price)} · ${stockSummary(product)}${product.category ? ' · ' + escapeHtml(product.category) : ''}${product.has_photo ? '' : ' · <span class="warn">без фото</span>'}</div></div>
      <span style="color:var(--muted)">›</span>
    </div>`;

export function renderAdminProducts() {
  const withoutPhoto = adminState.products.filter((product) => !product.has_photo).length;
  getElement('admBody').innerHTML =
    TOOLBAR_HTML +
    (withoutPhoto
      ? `<div class="note" style="margin:0 0 10px">Без фото: ${withoutPhoto} — нажмите на товар и «📷 Фото»</div>`
      : '') +
    adminState.products.map(productRowHtml).join('');
}

/** После изменений товаров: обновить список в админке и каталог покупателя (вместе с корзиной) */
export async function reloadProducts() {
  try {
    adminState.products = (await callApi('/admin/products')).products;
  } catch {
    /* покажем старый список */
  }
  try {
    const catalog = await callApi('/catalog');
    state.products = catalog.products;
    state.cart = catalog.cart || {};
    renderCategoryChips();
    renderProductGrid();
    renderCart();
  } catch {
    /* каталог обновится при следующем открытии */
  }
  if (state.activeTab === 'admin' && adminState.section === 'products') renderAdminProducts();
}
