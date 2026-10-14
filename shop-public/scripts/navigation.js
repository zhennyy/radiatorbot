// Переключение вкладок и системные кнопки Telegram: MainButton (оформить/оплатить) и BackButton (назад).
import { state } from './state.js';
import { texts } from './i18n.js';
import { telegram, isInsideTelegram } from './telegram.js';
import { formatRubles } from './utils/format.js';
import { cartTotals } from './cart/cart-model.js';
import { renderCart } from './cart/cart-view.js';
import { closeSheet, isSheetOpen } from './catalog/product-sheet.js';
import { loadOrders } from './orders/orders-view.js';
import { amountToPay } from './checkout/checkout-state.js';
import { openCheckout, payForOrder } from './checkout/checkout-actions.js';
import { loadAdmin, goBackInAdmin } from './admin/admin-page.js';

const MAIN_BUTTON_COLORS = { color: '#e8590c', text_color: '#ffffff' };

export function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('section.view').forEach((section) => section.classList.toggle('on', section.id === 'v-' + tabName));
  // оформление — продолжение корзины: подсвечиваем вкладку «Корзина»
  const highlightedTab = tabName === 'checkout' ? 'cart' : tabName;
  document.querySelectorAll('#tabs button').forEach((button) => button.classList.toggle('on', button.dataset.tab === highlightedTab));
  if (tabName === 'orders') loadOrders();
  if (tabName === 'admin') loadAdmin();
  if (tabName === 'cart') renderCart();
  if (tabName === 'catalog') telegram?.BackButton?.hide(); else telegram?.BackButton?.show();
  updateMainButton();
  window.scrollTo(0, 0);
}

/** В корзине — «Оформить», в оформлении — «Оплатить», на других вкладках при непустой корзине — «Корзина · сумма» */
export function updateMainButton() {
  if (!isInsideTelegram || !telegram.MainButton) return;
  const { itemCount, sum } = cartTotals();
  if (itemCount === 0 || state.activeTab === 'orders' || state.activeTab === 'admin') {
    telegram.MainButton.hide();
    return;
  }
  let text;
  if (state.activeTab === 'checkout') text = `Оплатить · ${formatRubles(amountToPay())}`;
  else if (state.activeTab === 'cart') text = texts().checkout(formatRubles(sum));
  else text = `🛒 ${texts().tabCart} · ${formatRubles(sum)}`;
  telegram.MainButton.setParams({ text, ...MAIN_BUTTON_COLORS });
  telegram.MainButton.show();
}

function onMainButtonClick() {
  if (state.activeTab === 'checkout') payForOrder();
  else if (state.activeTab === 'cart') openCheckout();
  else switchTab('cart');
}

function onBackButtonClick() {
  if (isSheetOpen()) closeSheet();
  else if (state.activeTab === 'checkout') switchTab('cart');
  else if (state.activeTab === 'admin' && goBackInAdmin()) return; // из открытого чата — к списку чатов
  else switchTab('catalog');
}

export function listenToTelegramButtons() {
  telegram?.MainButton?.onClick(onMainButtonClick);
  telegram?.BackButton?.onClick(onBackButtonClick);
}

export const navigationActions = {
  'switch-tab': (element) => switchTab(element.dataset.tab),
};
