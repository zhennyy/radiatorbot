// Вкладка «Корзина» и значок количества на вкладке.
import { texts } from '../i18n.js';
import { isInsideTelegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatRubles } from '../utils/format.js';
import { productPhotoHtml } from '../catalog/product-photo.js';
import { quantityStepperHtml } from '../catalog/product-card.js';
import { productName } from '../catalog/product-helpers.js';
import { updateMainButton } from '../navigation.js';
import { cartTotals, cartLines, changeQuantity } from './cart-model.js';

const cartLineHtml = ({ product, quantity }) => `
      <div class="line">
        <div class="thumb" data-action="open-product" data-product-id="${product.id}">${productPhotoHtml(product)}</div>
        <div class="mid"><div class="name">${escapeHtml(productName(product))}</div><div class="price">${formatRubles(product.price * quantity)}</div></div>
        ${quantityStepperHtml(product, quantity)}
      </div>`;

const emptyCartHtml = () => `<div class="empty"><b>🛒</b>${texts().cartEmpty}<br><br><button class="btn ghost" data-action="switch-tab" data-tab="catalog">${texts().toCatalog}</button></div>`;

export function renderCart() {
  const { itemCount, sum } = cartTotals();
  getElement('cartCount').textContent = itemCount || '';
  const lines = cartLines();
  // в Telegram вместо кнопки «Оформить» — системная MainButton
  const content = lines.length ? lines.map(cartLineHtml).join('') + `
      <div class="total"><span>${texts().total}</span><b>${formatRubles(sum)}</b></div>
      ${isInsideTelegram ? '' : `<button class="btn" data-action="open-checkout">${texts().checkout(formatRubles(sum))}</button>`}
      <div class="note">${texts().checkoutNote}</div>` : emptyCartHtml();
  getElement('v-cart').innerHTML = `<h1>${texts().cartTitle}</h1>` + content;
  updateMainButton();
}

const productIdOf = (element) => Number(element.dataset.productId);

export const cartActions = {
  'cart-add': (element) => changeQuantity(productIdOf(element), 1),
  'cart-remove-one': (element) => changeQuantity(productIdOf(element), -1),
};
