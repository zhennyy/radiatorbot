// Вкладка «Мои заказы»: карточки заказов со статусом, этапами, трек-номером и кнопкой оплаты.
import { state } from '../state.js';
import { texts, isEnglish, inLanguage } from '../i18n.js';
import { callApi } from '../api.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { formatRubles, formatDateTime, formatStars } from '../utils/format.js';

/** Этапы «Оплачен → Собираем → Отправлен → Доставлен»; order.step — текущий этап (−1 — не показывать) */
function progressStepsHtml(order) {
  if (order.step < 0) return '';
  const names = isEnglish()
    ? ['Paid', 'Packing', order.pickup ? 'Ready' : 'Shipped', order.pickup ? 'Picked up' : 'Delivered']
    : ['Оплачен', 'Собираем', order.pickup ? 'Готов' : 'Отправлен', order.pickup ? 'Получен' : 'Доставлен'];
  const LAST_STEP = 3;
  return `<div class="steps">${names.map((name, index) => {
    const stepClass = index < order.step || order.step === LAST_STEP ? 'done' : index === order.step ? 'now' : '';
    return `<div class="${stepClass}">${name}</div>`;
  }).join('')}</div>`;
}

/** «Название × 2» */
export const orderItemLabel = (item) => `${escapeHtml(item.name)} × ${item.qty}`;

const orderHtml = (order) => `
    <div class="order">
      <div class="top"><span class="code">№ ${escapeHtml(order.code)}</span><span class="pill ${escapeHtml(order.status)}">${escapeHtml(order.statusLabel)}</span></div>
      ${progressStepsHtml(order)}
      <ul>${order.items.map((item) => `<li><span>${orderItemLabel(item)}</span><span>${formatRubles(item.price * item.qty)}</span></li>`).join('')}
        ${order.delivery_cost ? `<li><span>${texts().delivery}</span><span>${formatRubles(order.delivery_cost)}</span></li>` : ''}</ul>
      <div class="sum"><span>${texts().total}</span><span>${formatRubles(order.total)}</span></div>
      <div class="meta">${escapeHtml(formatDateTime(order.created_at))}${order.address ? ' · ' + escapeHtml(order.address) : ''}</div>
      ${order.track ? `<div class="track">🚚 ${inLanguage('Трек-номер', 'Tracking')}: <b>${escapeHtml(order.track)}</b></div>` : ''}
      ${order.rating ? `<div class="stars">${formatStars(order.rating)}</div>` : ''}
      ${order.can_pay ? `<button class="btn pay" data-action="pay-existing-order" data-order-id="${order.id}">💳 Оплатить ${formatRubles(order.total)}</button>` : ''}
    </div>`;

export async function loadOrders() {
  const view = getElement('v-orders');
  view.innerHTML = `<h1>${texts().ordersTitle}</h1><div class="skel" style="aspect-ratio:3/1"></div>`;
  try {
    state.orders = (await callApi('/orders')).orders;
  } catch (error) {
    view.innerHTML = `<h1>${texts().ordersTitle}</h1><div class="empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  view.innerHTML = `<h1>${texts().ordersTitle}</h1>`
    + (state.orders.length ? state.orders.map(orderHtml).join('') : `<div class="empty"><b>📦</b>${texts().ordersEmpty}</div>`);
}
