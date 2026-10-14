// Карточка заказа у владелицы: состав, адрес, контакты и кнопка следующего шага.
import { escapeHtml } from '../../utils/dom.js';
import { formatRubles, formatDateTime, formatStars } from '../../utils/format.js';
import { orderItemLabel } from '../../orders/orders-view.js';
import { orderStatusLabel } from '../admin-state.js';

/** Следующий статус и подпись кнопки: [статус, текст] или null */
function nextStep(order) {
  switch (order.status) {
    case 'awaiting_payment':
    case 'pending': return ['paid', '✅ Оплачен (вручную)'];
    case 'paid': return ['assembling', '📦 Начать сборку'];
    case 'assembling': return ['shipped', order.pickup ? '🏠 Готов к выдаче' : '🚚 Отправить'];
    case 'shipped': return ['delivered', order.pickup ? '✅ Выдан' : '✅ Доставлен'];
    case 'cancelled': return ['paid', order.was_paid ? '↩️ Вернуть в работу' : '✅ Оплачен (вручную)'];
    default: return null;
  }
}

function detailsLine(order) {
  return [
    order.promo ? `🎟 ${escapeHtml(order.promo)} −${order.discount}%` : '',
    order.track ? `🚚 Трек: <b>${escapeHtml(order.track)}</b>` : '',
    order.rating ? formatStars(order.rating) : '',
  ].filter(Boolean).join(' · ');
}

const statusButton = (order, status, label, classes = 'btn') => `<button class="${classes}" data-action="change-order-status" data-order-id="${order.id}" data-status="${status}">${label}</button>`;

export function adminOrderCardHtml(order) {
  const next = nextStep(order);
  const details = detailsLine(order);
  const phoneLink = order.phone ? `<a class="mini" href="tel:${escapeHtml(order.phone.replace(/[^\d+]/g, ''))}">📞 ${escapeHtml(order.phone)}</a>` : '';
  return `
    <div class="order" id="ord-${order.id}">
      <div class="top"><span class="code">№ ${escapeHtml(order.code)}${order.buyer ? ' · ' + escapeHtml(order.buyer) : ''}</span><span class="pill ${escapeHtml(order.status)}">${escapeHtml(orderStatusLabel(order))}</span></div>
      <ul>${order.items.map((item) => `<li><span>${orderItemLabel(item)}</span><span>${formatRubles(item.price * item.qty)}</span></li>`).join('')}
        ${order.pickup ? '' : `<li><span>Доставка</span><span>${order.delivery_cost ? formatRubles(order.delivery_cost) : 'бесплатно'}</span></li>`}</ul>
      <div class="sum"><span>Итого</span><span>${formatRubles(order.total)}</span></div>
      <div class="meta">${escapeHtml(formatDateTime(order.created_at))} · ${order.pickup ? '🏠 Самовывоз' : '📍 ' + escapeHtml(order.address)}</div>
      ${details ? `<div class="meta">${details}</div>` : ''}
      <div class="contact">${phoneLink}<button class="mini" data-action="chat-with-buyer" data-chat-id="${order.chat_id}">💬 Написать</button></div>
      <div class="oact">${next ? statusButton(order, next[0], next[1]) : ''}
        ${!['cancelled', 'delivered'].includes(order.status) ? statusButton(order, 'cancelled', 'Отменить', 'btn ghost small') : ''}
        ${order.status === 'shipped' && !order.pickup ? `<button class="btn ghost small" data-action="edit-track" data-order-id="${order.id}">Трек</button>` : ''}</div>
    </div>`;
}
