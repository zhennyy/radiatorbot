// Админка → «Заказы»: фильтры по статусу, смена статуса (с уведомлением покупателю), трек-номер.
import { callApi } from '../../api.js';
import { confirmAction, vibrate } from '../../telegram.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { closeSheet, showSheet } from '../../catalog/product-sheet.js';
import { adminState } from '../admin-state.js';
import { adminOrderCardHtml } from './order-card.js';

const IN_WORK_STATUSES = ['paid', 'assembling', 'shipped'];
const ORDER_FILTERS = [
  ['active', 'В работе', (order) => IN_WORK_STATUSES.includes(order.status)],
  ['unpaid', 'Ждут оплату', (order) => order.status === 'awaiting_payment' || order.status === 'pending'],
  ['delivered', 'Доставлены', (order) => order.status === 'delivered'],
  ['cancelled', 'Отменены', (order) => order.status === 'cancelled'],
  ['all', 'Все', () => true],
];
const TRACK_FOCUS_DELAY_MS = 250; // после анимации шторки

const findFilter = (filterName) => ORDER_FILTERS.find(([name]) => name === filterName);
const findOrder = (orderId) => adminState.orders.find((order) => order.id === Number(orderId));

export function renderAdminOrders() {
  const countFor = (filterName) => adminState.orders.filter(findFilter(filterName)[2]).length;
  const matchesFilter = (findFilter(adminState.orderFilter) || ORDER_FILTERS[0])[2];
  const orders = adminState.orders.filter(matchesFilter);
  const filterChips = ORDER_FILTERS.map(
    ([name, label]) =>
      `<button class="chip ${adminState.orderFilter === name ? 'on' : ''}" data-action="filter-orders" data-filter="${name}">${label}${name !== 'all' && countFor(name) ? ` · ${countFor(name)}` : ''}</button>`,
  ).join('');
  const emptyText = adminState.orderFilter === 'active' ? 'Сейчас нет заказов в работе' : 'Здесь пока пусто';
  getElement('admBody').innerHTML =
    `<div class="chips small">${filterChips}</div>` +
    (orders.length ? orders.map(adminOrderCardHtml).join('') : `<div class="empty"><b>📦</b>${emptyText}</div>`);
}

/** Шторка трек-номера. purpose: 'ship' — отправка заказа, 'track' — только поправить трек */
function openTrackSheet(orderId, purpose) {
  const order = findOrder(orderId);
  getElement('sheet').innerHTML = `<button class="x" data-action="close-sheet">✕</button>
    <div class="body form" style="padding-top:24px"><h2>Заказ № ${escapeHtml(order?.code || orderId)} отправлен 🚚</h2>
      <p>Если есть трек-номер — впишите, покупатель получит его в сообщении. Можно оставить пустым.</p>
      <input id="trackIn" placeholder="Трек-номер (необязательно)" value="${escapeHtml(order?.track || '')}" autocapitalize="characters">
      <div class="actions"><button class="btn" id="trackGo">${purpose === 'ship' ? 'Отправить уведомление' : 'Сохранить трек'}</button></div></div>`;
  showSheet();
  setTimeout(() => getElement('trackIn')?.focus(), TRACK_FOCUS_DELAY_MS);
  getElement('trackGo').addEventListener('click', async () => {
    closeSheet();
    await changeOrderStatus(orderId, 'shipped', getElement('trackIn').value.trim(), true);
  });
}

/** Сменить статус. Курьерский заказ при отправке сначала спрашивает трек-номер (trackEntered — уже спросили). */
async function changeOrderStatus(orderId, status, track, trackEntered) {
  const order = findOrder(orderId);
  if (status === 'shipped' && order && !order.pickup && !trackEntered) {
    openTrackSheet(orderId, 'ship');
    return;
  }
  if (status === 'cancelled') {
    const question = IN_WORK_STATUSES.includes(order?.status)
      ? 'Отменить заказ? Товар вернётся на склад. Деньги покупателю верните в кабинете ЮKassa.'
      : 'Отменить заказ?';
    if (!(await confirmAction(question))) return;
  }
  try {
    const updated = await callApi(
      `/admin/orders/${orderId}/status`,
      track !== undefined ? { status, track } : { status },
      1,
    );
    if (order) {
      order.status = updated.status;
      order.track = updated.track;
    }
    renderAdminOrders();
    vibrate('medium');
    showToast(status === 'awaiting_payment' ? 'Статус обновлён ✓' : 'Готово — покупателю отправлено уведомление ✓');
  } catch (error) {
    showToast(error.message);
  }
}

export const adminOrderActions = {
  'filter-orders': (element) => {
    adminState.orderFilter = element.dataset.filter;
    renderAdminOrders();
  },
  'change-order-status': (element) => changeOrderStatus(Number(element.dataset.orderId), element.dataset.status),
  'edit-track': (element) => openTrackSheet(Number(element.dataset.orderId), 'track'),
};
