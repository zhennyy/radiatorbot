// Экран оформления: доставка или самовывоз, город и адрес, телефон, промокод, итог, согласие на обработку данных.
import { texts, isEnglish } from '../i18n.js';
import { isInsideTelegram } from '../telegram.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatRubles } from '../utils/format.js';
import { cartTotals } from '../cart/cart-model.js';
import { updateMainButton } from '../navigation.js';
import {
  checkoutForm,
  checkout,
  OTHER_CITY,
  deliveryCost,
  isDeliveryFree,
  goodsTotal,
  discountAmount,
} from './checkout-state.js';

function deliverySwitchHtml() {
  if (!checkout.info.pickup) return '';
  const button = (method, label) =>
    `<button data-action="choose-delivery" data-delivery="${method}" class="${checkoutForm.delivery === method ? 'on' : ''}">${label}</button>`;
  return `<div class="seg">${button('city', '🚚 Доставка')}${button('pickup', '🏠 Самовывоз')}</div>`;
}

function freeDeliveryNoteHtml() {
  const info = checkout.info;
  if (checkoutForm.delivery !== 'city' || !(info.freeFrom > 0)) return '';
  const text = isDeliveryFree()
    ? '🎉 Доставка бесплатно!'
    : `Бесплатная доставка от ${formatRubles(info.freeFrom)} — осталось ${formatRubles(info.freeFrom - goodsTotal())}`;
  return `<div class="note" style="text-align:left;margin:0 0 6px">${text}</div>`;
}

/** Город и адрес для доставки или адрес самовывоза */
function deliveryFieldsHtml() {
  const info = checkout.info;
  if (checkoutForm.delivery !== 'city') {
    return `<div class="note" style="text-align:left;margin-top:10px">${info.pickupAddress ? '📍 ' + escapeHtml(info.pickupAddress) + '<br>' : ''}Напишем в чат, когда заказ будет готов к выдаче.</div>`;
  }
  const cityName = (city) => (isEnglish() && city.city_en) || city.city;
  const cityOptions = info.cities
    .map(
      (city) =>
        `<option value="${escapeHtml(city.city)}" ${checkoutForm.city === city.city ? 'selected' : ''}>${escapeHtml(cityName(city))} — ${formatRubles(city.price)}</option>`,
    )
    .join('');
  return `
        <div class="fld"><select id="coCity">${cityOptions}
          <option value="${OTHER_CITY}" ${checkoutForm.city === OTHER_CITY ? 'selected' : ''}>Другой город — ${formatRubles(info.otherPrice)}</option></select></div>
        ${checkoutForm.city === OTHER_CITY ? `<div class="fld"><input id="coOther" placeholder="Город" value="${escapeHtml(checkoutForm.other)}"></div>` : ''}
        <div class="fld"><textarea id="coAddr" placeholder="Улица, дом, квартира, подъезд">${escapeHtml(checkoutForm.address)}</textarea></div>`;
}

function summaryHtml(total) {
  const discount = discountAmount();
  const deliveryText =
    checkoutForm.delivery === 'pickup' || isDeliveryFree() ? 'бесплатно' : formatRubles(deliveryCost());
  return `<div class="box">
      <div class="sumrow"><span>Товары</span><span>${formatRubles(cartTotals().sum)}</span></div>
      ${discount ? `<div class="sumrow"><span>Скидка ${checkoutForm.promoPercent}%</span><span>−${formatRubles(discount)}</span></div>` : ''}
      <div class="sumrow"><span>Доставка</span><span>${deliveryText}</span></div>
      <div class="sumrow big"><span>Итого</span><span>${formatRubles(total)}</span></div>
    </div>`;
}

/** Ссылка на юридическую страницу (shop-public/legal/) — открывается действием open-legal */
const legalLink = (fileName) => (linkText) =>
  `<a href="legal/${fileName}" target="_blank" rel="noopener" data-action="open-legal">${linkText}</a>`;

/** Галочка согласия на обработку персональных данных (152-ФЗ) и строка про оферту — прямо перед оплатой */
function consentHtml() {
  return `<div class="consent">
      <label class="consent-check">
        <input id="coConsent" type="checkbox" ${checkoutForm.consent ? 'checked' : ''}>
        <span>${texts().consentLabel(legalLink('consent.html'))}</span>
      </label>
      <div class="consent-note">${texts().consentNote(legalLink('offer.html'), legalLink('privacy.html'))}</div>
    </div>`;
}

export function renderCheckout() {
  const total = cartTotals().sum - discountAmount() + deliveryCost();
  getElement('v-checkout').innerHTML = `<h1>Оформление</h1>
    <div class="box"><h3>Получение</h3>
      ${deliverySwitchHtml()}
      ${freeDeliveryNoteHtml()}
      ${deliveryFieldsHtml()}
      <div class="fld"><input id="coPhone" type="tel" inputmode="tel" placeholder="Телефон для связи" value="${escapeHtml(checkoutForm.phone)}"></div>
    </div>
    <div class="box"><h3>Промокод</h3>
      <div class="promo"><input id="coPromo" placeholder="Если есть" value="${escapeHtml(checkoutForm.promo)}" autocapitalize="characters"><button class="btn ghost" data-action="apply-promo">Применить</button></div>
      ${checkoutForm.promoMessage ? `<div class="fld ok">✓ ${escapeHtml(checkoutForm.promoMessage)}</div>` : ''}
    </div>
    ${summaryHtml(total)}
    ${consentHtml()}
    ${isInsideTelegram ? '' : `<button class="btn" data-action="pay-order" aria-disabled="${!checkoutForm.consent}">Оплатить · ${formatRubles(total)}</button>`}
    <div class="note">${texts().checkoutNote}</div>`;
  listenToCheckoutFields();
  updateMainButton();
}

/** Связать поле с checkoutForm[formKey]; rerender — перерисовать экран (меняется цена) */
function bindField(id, formKey, rerender = false) {
  const field = getElement(id);
  if (!field) return;
  field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', (event) => {
    checkoutForm[formKey] = event.target.value;
    if (rerender) renderCheckout();
    else updateMainButton();
  });
}

function listenToCheckoutFields() {
  bindField('coCity', 'city', true);
  bindField('coOther', 'other');
  bindField('coAddr', 'address');
  bindField('coPhone', 'phone');
  bindField('coPromo', 'promo');
  // цена зависит от города — пересчитываем, когда покупатель закончил ввод
  getElement('coOther')?.addEventListener('change', () => renderCheckout());
  getElement('coConsent')?.addEventListener('change', (event) => {
    checkoutForm.consent = event.target.checked;
    document
      .querySelector('#v-checkout [data-action="pay-order"]')
      ?.setAttribute('aria-disabled', String(!checkoutForm.consent));
    updateMainButton();
  });
}
