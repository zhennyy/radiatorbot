// Состояние админки владелицы: открытый раздел, загруженные данные, фильтры, открытый чат.

export const adminState = {
  section: 'orders', // orders | stats | products | chats | settings
  products: [],
  orders: [],
  settings: null,
  orderFilter: 'active',
  statsDays: 30,
  unreadCount: 0, // непрочитанные сообщения покупателей
  openChatId: null,
  editingProductId: null, // id товара в редакторе или 'new'
};

export const ADMIN_SECTIONS = [
  ['orders', '📦 Заказы'],
  ['stats', '📊 Статистика'],
  ['products', '🛍 Товары'],
  ['chats', '💬 Чаты'],
  ['settings', '⚙️ Настройки'],
];

const STATUS_LABELS = {
  awaiting_payment: '⏳ Ждёт оплату',
  pending: '⏳ Ждёт оплату',
  paid: '🆕 Новый',
  assembling: '📦 Собираем',
  shipped: '🚚 Отправлен',
  delivered: '✅ Доставлен',
  cancelled: '❌ Отменён',
};

/** Подпись статуса для владелицы; «Отправлен» у самовывоза — «Готов к выдаче» */
export const orderStatusLabel = (order) =>
  order.status === 'shipped' && order.pickup ? '🏠 Готов к выдаче' : STATUS_LABELS[order.status] || order.status;
export const statusLabel = (status) => STATUS_LABELS[status] || status;
