// Тексты и кнопки заказа: сообщение покупателю (с полоской прогресса) и карточка заказа для владелицы.
const customers = require('../customers');
const { getDeliverySettings } = require('../settings');
const { escapeHtml, formatRubles } = require('./format');
const { ORDER_FLOW, PAID_STATUSES, isPickup, statusLabel } = require('./status');

function shopUrl(queryParameters = {}) {
  const configuredUrl =
    process.env.SHOP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/shop/` : '');
  if (!configuredUrl) return null;
  const url = new URL(configuredUrl);
  for (const [parameterName, parameterValue] of Object.entries(queryParameters))
    url.searchParams.set(parameterName, parameterValue);
  return url.toString();
}

// Полоска прогресса: ✅ Оплачен → 📦 Собираем → ▫️ Отправлен → ▫️ Доставлен
function progressLine(order, language) {
  const stepNames =
    language === 'en'
      ? ['Paid', 'Packing', isPickup(order) ? 'Ready' : 'Shipped', isPickup(order) ? 'Picked up' : 'Delivered']
      : ['Оплачен', 'Собираем', isPickup(order) ? 'Готов' : 'Отправлен', isPickup(order) ? 'Получен' : 'Доставлен'];
  const currentStep = ORDER_FLOW.indexOf(order.base);
  return stepNames
    .map((stepName, stepIndex) => {
      if (stepIndex < currentStep) return '✅ ' + stepName;
      if (stepIndex === currentStep) return `🔸 <b>${stepName}</b>`;
      return '▫️ ' + stepName;
    })
    .join('  →  ');
}

function itemsText(order, language) {
  const isEnglish = language === 'en';
  const lines = order.items.map((orderItem) => {
    const itemName = escapeHtml((isEnglish && orderItem.name_en) || orderItem.name || '—');
    return `${itemName} × ${orderItem.quantity} — ${formatRubles(orderItem.price * orderItem.quantity)}`;
  });
  if (order.discount_percent)
    lines.push(`${isEnglish ? 'Promo' : 'Промокод'} ${escapeHtml(order.promo_code || '')} −${order.discount_percent}%`);
  if (!isPickup(order)) {
    const deliveryPrice = order.delivery_cost ? formatRubles(order.delivery_cost) : isEnglish ? 'free' : 'бесплатно';
    lines.push(`${isEnglish ? 'Delivery' : 'Доставка'} — ${deliveryPrice}`);
  }
  lines.push(`<b>${isEnglish ? 'Total' : 'Итого'} ${formatRubles(order.total)}</b>`);
  return lines.join('\n');
}

// Текст для покупателя — что происходит с заказом сейчас
async function buyerText(order, language = 'ru') {
  const buyerName = await customers.getName(order.chat_id);
  const greeting = buyerName ? `${escapeHtml(buyerName)}, ` : '';
  const deliverySettings = await getDeliverySettings();
  const isEnglish = language === 'en';
  const code = order.code;
  const headlines = {
    paid: isEnglish
      ? `${greeting}payment received — order <b>№ ${code}</b> is in the works ✅`
      : `${greeting}оплата получена — заказ <b>№ ${code}</b> принят в работу ✅`,
    assembling: isEnglish
      ? `Packing your order <b>№ ${code}</b> 📦\nChecking everything and wrapping it carefully.`
      : `Собираем ваш заказ <b>№ ${code}</b> 📦\nПроверяем комплектность и бережно упаковываем.`,
    shipped: isPickup(order)
      ? isEnglish
        ? `Order <b>№ ${code}</b> is ready for pickup 🏠`
        : `Заказ <b>№ ${code}</b> готов — можно забирать 🏠`
      : isEnglish
        ? `Order <b>№ ${code}</b> is on its way 🚚`
        : `Заказ <b>№ ${code}</b> отправлен 🚚`,
    delivered: isEnglish
      ? `Order <b>№ ${code}</b> delivered ✅\nThank you for choosing RadiatorPro! How did we do?`
      : `Заказ <b>№ ${code}</b> доставлен ✅\nСпасибо, что выбрали RadiatorPro! Оцените, пожалуйста, как всё прошло:`,
    cancelled: isEnglish
      ? `Order <b>№ ${code}</b> was cancelled.\nIf you already paid, the money will be returned to your card within a few days. Questions? Just write here 💬`
      : `Заказ <b>№ ${code}</b> отменён.\nЕсли оплата уже прошла — деньги вернутся на карту в течение нескольких дней. Вопросы — просто напишите сюда 💬`,
  };
  const messageParts = [
    headlines[order.base] || `${isEnglish ? 'Order' : 'Заказ'} № ${code}: ${statusLabel(order, language)}`,
  ];
  if (PAID_STATUSES.has(order.base)) messageParts.push(progressLine(order, language));
  if (order.base !== 'cancelled') messageParts.push(itemsText(order, language));
  if (order.base === 'shipped' && order.track)
    messageParts.push(`${isEnglish ? 'Tracking number' : 'Трек-номер'}: <code>${escapeHtml(order.track)}</code>`);
  if (isPickup(order) && deliverySettings.pickupAddress && ['paid', 'assembling', 'shipped'].includes(order.base)) {
    messageParts.push(`📍 ${isEnglish ? 'Pickup' : 'Самовывоз'}: ${escapeHtml(deliverySettings.pickupAddress)}`);
  } else if (!isPickup(order) && order.base !== 'cancelled' && order.base !== 'delivered') {
    messageParts.push(`📍 ${escapeHtml(order.address || '')}`);
  }
  return messageParts.join('\n\n');
}

function buyerKeyboard(order, language = 'ru') {
  const keyboardRows = [];
  if (order.base === 'delivered' && !order.rating) {
    keyboardRows.push(
      [1, 2, 3, 4, 5].map((stars) => ({ text: `${stars} ⭐`, callback_data: `rate:${order.id}:${stars}` })),
    );
  }
  const ordersTabUrl = shopUrl({ tab: 'orders' });
  if (ordersTabUrl)
    keyboardRows.push([{ text: language === 'en' ? '📦 My orders' : '📦 Мои заказы', web_app: { url: ordersTabUrl } }]);
  return keyboardRows.length ? { inline_keyboard: keyboardRows } : undefined;
}

function phoneOf(order) {
  const phoneMatch = String(order.address || '').match(/тел\.\s*([+\d][\d\s()-]{8,})/);
  return phoneMatch ? phoneMatch[1].trim() : '';
}

// Карточка заказа для владелицы в Telegram. Telegram — зарубежный сервис, поэтому здесь нет персональных данных
// покупателя (152-ФЗ): ни телефона, ни адреса, ни имени — только город. Контакты и адрес — в админке на нашем сервере.
// Ссылка tg://user — это данные самого Telegram, по ней владелица может написать покупателю.
async function ownerText(order) {
  const lines = [
    `${order.base === 'paid' ? '🆕 <b>Новый заказ</b>' : '<b>Заказ</b>'} № ${order.code} · ${formatRubles(order.total)}`,
    `👤 <a href="tg://user?id=${order.chat_id}">Покупатель в Telegram</a>`,
    '',
    itemsText(order, 'ru'),
    '',
    isPickup(order) ? '🏠 Самовывоз' : `🚚 Доставка: ${escapeHtml(order.delivery_city)}`,
  ];
  if (order.track) lines.push(`🚚 Трек: <code>${escapeHtml(order.track)}</code>`);
  if (order.rating) lines.push(`⭐ Оценка: ${order.rating}/5`);
  lines.push('', `Статус: <b>${statusLabel(order, 'ru')}</b>`, '📇 Контакты и адрес — в админке');
  return lines.join('\n');
}

function ownerKeyboard(order) {
  const statusButton = (status, text) => ({
    text: (order.base === status ? '• ' : '') + text,
    callback_data: `ost:${order.id}:${status}`,
  });
  const keyboardRows = [];
  if (order.base === 'cancelled') {
    keyboardRows.push([statusButton('paid', order.paid_at ? '↩️ Вернуть в работу' : '✅ Оплачен (вручную)')]);
  } else {
    keyboardRows.push([
      statusButton('assembling', '📦 Собираем'),
      statusButton('shipped', isPickup(order) ? '🏠 Готов к выдаче' : '🚚 Отправлен'),
    ]);
    keyboardRows.push([statusButton('delivered', '✅ Доставлен'), statusButton('cancelled', '❌ Отменить')]);
  }
  keyboardRows.push([{ text: '💬 Написать покупателю', callback_data: `reply:${order.chat_id}` }]);
  const adminTabUrl = shopUrl({ tab: 'admin' });
  if (adminTabUrl) keyboardRows.push([{ text: '⚙️ Открыть админку', web_app: { url: adminTabUrl } }]);
  return { inline_keyboard: keyboardRows };
}

module.exports = { shopUrl, buyerText, buyerKeyboard, phoneOf, ownerText, ownerKeyboard };
