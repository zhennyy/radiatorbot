// Оформление заказа: открыть форму со значениями по умолчанию, применить промокод, проверить адрес
// и создать заказ — после этого открывается ссылка на оплату ЮKassa.
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { callApi } from '../api.js';
import { telegram, vibrate, openPaymentLink, openExternalPage } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { showToast } from '../utils/toast.js';
import { cartTotals } from '../cart/cart-model.js';
import { renderCart } from '../cart/cart-view.js';
import { renderProductGrid } from '../catalog/catalog-view.js';
import { switchTab } from '../navigation.js';
import { checkoutForm, checkout, OTHER_CITY } from './checkout-state.js';
import { renderCheckout } from './checkout-view.js';

const MIN_CITY_LENGTH = 2;
const MIN_ADDRESS_LENGTH = 5;

/** Значения по умолчанию: Петербург (или первый город из списка) */
function prefillForm(info) {
  if (!checkoutForm.city && info.cities.length)
    checkoutForm.city = (info.cities.find((city) => /петербург/i.test(city.city)) || info.cities[0]).city;
  if (!checkoutForm.city) checkoutForm.city = OTHER_CITY;
  if (!info.pickup) checkoutForm.delivery = 'city';
}

export async function openCheckout() {
  if (!cartTotals().itemCount) {
    showToast(texts().cartEmpty);
    return;
  }
  switchTab('checkout');
  if (!checkout.info) {
    const view = getElement('v-checkout');
    view.innerHTML = '<h1>Оформление</h1><div class="skel" style="aspect-ratio:3/1"></div>';
    try {
      checkout.info = await callApi('/checkout-info');
    } catch (error) {
      view.innerHTML = `<h1>Оформление</h1><div class="empty">${escapeHtml(error.message)}</div>`;
      return;
    }
    prefillForm(checkout.info);
  }
  renderCheckout();
}

async function applyPromo() {
  checkoutForm.promo = (getElement('coPromo')?.value || '').trim();
  if (!checkoutForm.promo) {
    checkoutForm.promoPercent = 0;
    checkoutForm.promoMessage = '';
    renderCheckout();
    return;
  }
  try {
    const promo = await callApi('/promo', { code: checkoutForm.promo }, 1);
    checkoutForm.promoPercent = promo.percent;
    checkoutForm.promoMessage = `Скидка ${promo.percent}%`;
    vibrate('medium');
  } catch (error) {
    checkoutForm.promoPercent = 0;
    checkoutForm.promoMessage = '';
    showToast(error.message);
  }
  renderCheckout();
}

/** Город и адрес обязательны для доставки: подсказываем и ставим курсор в пустое поле. true — всё заполнено. */
function checkDeliveryAddress() {
  if (checkoutForm.delivery !== 'city') return true;
  if (checkoutForm.city === OTHER_CITY && checkoutForm.other.trim().length < MIN_CITY_LENGTH) {
    showToast('Укажите город');
    getElement('coOther')?.focus();
    return false;
  }
  if (checkoutForm.address.trim().length < MIN_ADDRESS_LENGTH) {
    showToast('Укажите адрес доставки');
    getElement('coAddr')?.focus();
    return false;
  }
  return true;
}

/** Без согласия на обработку персональных данных (152-ФЗ) заказ не оформляем: подсказка и подсветка галочки */
function checkConsent() {
  if (checkoutForm.consent) return true;
  showToast(texts().consentRequired);
  vibrate('light');
  const consentBlock = document.querySelector('#v-checkout .consent');
  consentBlock?.classList.remove('attention');
  void consentBlock?.offsetWidth; // перезапуск анимации подсветки при повторном нажатии
  consentBlock?.classList.add('attention');
  consentBlock?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return false;
}

/** Кнопка «Оплатить»: проверить форму и согласие, создать заказ и открыть оплату */
export async function payForOrder() {
  if (checkout.isPaying) return;
  if (!checkDeliveryAddress()) return;
  if (!checkConsent()) return;
  if (checkoutForm.promo && !checkoutForm.promoPercent) {
    await applyPromo();
    if (!checkoutForm.promoPercent) return;
  }
  checkout.isPaying = true;
  telegram?.MainButton?.showProgress?.();
  try {
    const order = await callApi(
      '/order',
      {
        delivery: checkoutForm.delivery === 'pickup' ? 'pickup' : 'city',
        city: checkoutForm.city === OTHER_CITY ? checkoutForm.other.trim() : checkoutForm.city,
        address: checkoutForm.address,
        phone: checkoutForm.phone,
        promo: checkoutForm.promoPercent ? checkoutForm.promo : '',
        consent: checkoutForm.consent,
      },
      1,
    );
    vibrate('heavy');
    state.cart = {};
    renderCart();
    renderProductGrid();
    Object.assign(checkoutForm, { promo: '', promoPercent: 0, promoMessage: '', consent: false });
    openPaymentLink(order.pay_url);
    switchTab('orders');
    showToast(`Заказ ${order.code} создан — осталось оплатить 💳`);
  } catch (error) {
    showToast(error.message);
  } finally {
    checkout.isPaying = false;
    telegram?.MainButton?.hideProgress?.();
  }
}

export const checkoutActions = {
  'open-checkout': () => openCheckout(),
  'choose-delivery': (element) => {
    checkoutForm.delivery = element.dataset.delivery;
    renderCheckout();
  },
  'apply-promo': () => applyPromo(),
  'pay-order': () => payForOrder(),
  // ссылки на оферту, политику и согласие: в Telegram — через openLink, иначе в новой вкладке
  'open-legal': (element, event) => {
    event.preventDefault();
    openExternalPage(element.href);
  },
};
