// Статусы заказа: порядок, подписи RU/EN, «оплачен ли». Чистые функции без базы и Telegram.

// Порядок статусов. «Деньги получены» — это всё, что начиная с paid (кроме отмены).
const ORDER_FLOW = ['paid', 'assembling', 'shipped', 'delivered'];
const PAID_STATUSES = new Set(ORDER_FLOW);
const MANUAL_STATUSES = new Set([...ORDER_FLOW, 'cancelled']); // вручную в «ждёт оплату» не возвращаем

const STATUS_LABELS = {
  ru: { awaiting_payment: '⏳ Ждёт оплату', pending: '⏳ Ждёт оплату', paid: '🆕 Оплачен', assembling: '📦 Собираем',
        shipped: '🚚 Отправлен', delivered: '✅ Доставлен', cancelled: '❌ Отменён' },
  en: { awaiting_payment: '⏳ Awaiting payment', pending: '⏳ Awaiting payment', paid: '🆕 Paid', assembling: '📦 Packing',
        shipped: '🚚 Shipped', delivered: '✅ Delivered', cancelled: '❌ Cancelled' },
};
const PICKUP_READY_LABEL = { ru: '🏠 Готов к выдаче', en: '🏠 Ready for pickup' };

// «awaiting_payment:2f1c…» → «awaiting_payment»
const baseStatus = (status) => String(status || '').split(':')[0];
const isPickup = (order) => !order.delivery_city;

function statusLabel(order, language = 'ru') {
  if (order.base === 'shipped' && isPickup(order)) return PICKUP_READY_LABEL[language] || PICKUP_READY_LABEL.ru;
  return (STATUS_LABELS[language] || STATUS_LABELS.ru)[order.base] || order.base;
}

module.exports = { ORDER_FLOW, PAID_STATUSES, MANUAL_STATUSES, STATUS_LABELS, baseStatus, isPickup, statusLabel };
