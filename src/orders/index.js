// Жизнь заказа: создание, статусы, уведомления покупателю и владелице, склад, оценки.
// Используется и сервером витрины, и ботом (кнопки под уведомлением владелице).
const { database, runInTransaction, toSqliteTimestamp } = require('../database');
const customers = require('../customers');
const { getDeliverySettings } = require('../settings');

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

// Короткий код заказа для покупателя: 4 символа без похожих друг на друга (0/O, 1/I исключены)
const ORDER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_CODE_LENGTH = 4;

// «awaiting_payment:2f1c…» → «awaiting_payment»
const baseStatus = (status) => String(status || '').split(':')[0];
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
const formatRubles = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
const isPickup = (order) => !order.delivery_city;
const ownerChatId = () => process.env.OWNER_CHAT_ID;

function shopUrl(queryParameters = {}) {
  const configuredUrl = process.env.SHOP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/shop/` : '');
  if (!configuredUrl) return null;
  const url = new URL(configuredUrl);
  for (const [parameterName, parameterValue] of Object.entries(queryParameters)) url.searchParams.set(parameterName, parameterValue);
  return url.toString();
}

async function generateOrderCode() {
  for (;;) {
    const candidateCode = Array.from({ length: ORDER_CODE_LENGTH }, () => ORDER_CODE_ALPHABET[Math.floor(Math.random() * ORDER_CODE_ALPHABET.length)]).join('');
    if (!(await database.order.findFirst({ where: { order_code: candidateCode }, select: { id: true } }))) return candidateCode;
  }
}

// Позиции заказов с названием и остатком товара (товар мог быть удалён — тогда name = null)
async function getOrderItems(orderIds) {
  const orderItems = await database.orderItem.findMany({ where: { order_id: { in: orderIds } }, orderBy: { id: 'asc' } });
  const products = await database.product.findMany({
    where: { id: { in: [...new Set(orderItems.map((orderItem) => orderItem.product_id))] } },
    select: { id: true, name: true, name_en: true, stock: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  return orderItems.map((orderItem) => {
    const product = productById.get(orderItem.product_id);
    return { ...orderItem, name: product?.name ?? null, name_en: product?.name_en ?? null, stock: product?.stock ?? null };
  });
}

// Позиции, сгруппированные по заказу: Map(id заказа → позиции)
async function getItemsByOrderId(orderIds) {
  const itemsByOrderId = new Map(orderIds.map((orderId) => [orderId, []]));
  for (const orderItem of await getOrderItems(orderIds)) itemsByOrderId.get(orderItem.order_id).push(orderItem);
  return itemsByOrderId;
}

async function getOrder(orderId) {
  const order = await database.order.findUnique({ where: { id: orderId } });
  if (!order) return null;
  order.base = baseStatus(order.status);
  order.code = order.order_code || String(order.id);
  order.items = await getOrderItems([orderId]);
  return order;
}

// Заказ со статусом pending; total уже с учётом скидки и доставки. items — [{product_id, quantity, price}]
async function createPendingOrder({ chatId, address, total, items, promoCode = null, discountPercent = 0, deliveryCity = null, deliveryCost = 0 }) {
  return runInTransaction(async () => {
    const createdOrder = await database.order.create({
      data: {
        chat_id: Number(chatId), status: 'pending', total, address, payment_provider: 'yookassa',
        promo_code: promoCode, discount_percent: discountPercent, delivery_city: deliveryCity, delivery_cost: deliveryCost,
        order_code: await generateOrderCode(),
      },
    });
    await database.orderItem.createMany({
      data: items.map((orderLine) => ({ order_id: createdOrder.id, product_id: orderLine.product_id, quantity: orderLine.quantity, price: orderLine.price })),
    });
    return createdOrder.id;
  });
}

// Оплата не создалась — заказ не должен висеть в «ждёт оплату»
async function cancelIfNotPaid(orderId) {
  await database.order.updateMany({ where: { id: orderId, payment_id: null }, data: { status: 'cancelled' } });
}

function statusLabel(order, language = 'ru') {
  if (order.base === 'shipped' && isPickup(order)) return PICKUP_READY_LABEL[language] || PICKUP_READY_LABEL.ru;
  return (STATUS_LABELS[language] || STATUS_LABELS.ru)[order.base] || order.base;
}

// Полоска прогресса: ✅ Оплачен → 📦 Собираем → ▫️ Отправлен → ▫️ Доставлен
function progressLine(order, language) {
  const stepNames = language === 'en'
    ? ['Paid', 'Packing', isPickup(order) ? 'Ready' : 'Shipped', isPickup(order) ? 'Picked up' : 'Delivered']
    : ['Оплачен', 'Собираем', isPickup(order) ? 'Готов' : 'Отправлен', isPickup(order) ? 'Получен' : 'Доставлен'];
  const currentStep = ORDER_FLOW.indexOf(order.base);
  return stepNames.map((stepName, stepIndex) => {
    if (stepIndex < currentStep) return '✅ ' + stepName;
    if (stepIndex === currentStep) return `🔸 <b>${stepName}</b>`;
    return '▫️ ' + stepName;
  }).join('  →  ');
}

function itemsText(order, language) {
  const isEnglish = language === 'en';
  const lines = order.items.map((orderItem) => {
    const itemName = escapeHtml((isEnglish && orderItem.name_en) || orderItem.name || '—');
    return `${itemName} × ${orderItem.quantity} — ${formatRubles(orderItem.price * orderItem.quantity)}`;
  });
  if (order.discount_percent) lines.push(`${isEnglish ? 'Promo' : 'Промокод'} ${escapeHtml(order.promo_code || '')} −${order.discount_percent}%`);
  if (!isPickup(order)) {
    const deliveryPrice = order.delivery_cost ? formatRubles(order.delivery_cost) : (isEnglish ? 'free' : 'бесплатно');
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
    paid: isEnglish ? `${greeting}payment received — order <b>№ ${code}</b> is in the works ✅` : `${greeting}оплата получена — заказ <b>№ ${code}</b> принят в работу ✅`,
    assembling: isEnglish ? `Packing your order <b>№ ${code}</b> 📦\nChecking everything and wrapping it carefully.` : `Собираем ваш заказ <b>№ ${code}</b> 📦\nПроверяем комплектность и бережно упаковываем.`,
    shipped: isPickup(order)
      ? (isEnglish ? `Order <b>№ ${code}</b> is ready for pickup 🏠` : `Заказ <b>№ ${code}</b> готов — можно забирать 🏠`)
      : (isEnglish ? `Order <b>№ ${code}</b> is on its way 🚚` : `Заказ <b>№ ${code}</b> отправлен 🚚`),
    delivered: isEnglish ? `Order <b>№ ${code}</b> delivered ✅\nThank you for choosing RadiatorPro! How did we do?` : `Заказ <b>№ ${code}</b> доставлен ✅\nСпасибо, что выбрали RadiatorPro! Оцените, пожалуйста, как всё прошло:`,
    cancelled: isEnglish ? `Order <b>№ ${code}</b> was cancelled.\nIf you already paid, the money will be returned to your card within a few days. Questions? Just write here 💬`
                         : `Заказ <b>№ ${code}</b> отменён.\nЕсли оплата уже прошла — деньги вернутся на карту в течение нескольких дней. Вопросы — просто напишите сюда 💬`,
  };
  const messageParts = [headlines[order.base] || `${isEnglish ? 'Order' : 'Заказ'} № ${code}: ${statusLabel(order, language)}`];
  if (PAID_STATUSES.has(order.base)) messageParts.push(progressLine(order, language));
  if (order.base !== 'cancelled') messageParts.push(itemsText(order, language));
  if (order.base === 'shipped' && order.track) messageParts.push(`${isEnglish ? 'Tracking number' : 'Трек-номер'}: <code>${escapeHtml(order.track)}</code>`);
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
    keyboardRows.push([1, 2, 3, 4, 5].map((stars) => ({ text: `${stars} ⭐`, callback_data: `rate:${order.id}:${stars}` })));
  }
  const ordersTabUrl = shopUrl({ tab: 'orders' });
  if (ordersTabUrl) keyboardRows.push([{ text: language === 'en' ? '📦 My orders' : '📦 Мои заказы', web_app: { url: ordersTabUrl } }]);
  return keyboardRows.length ? { inline_keyboard: keyboardRows } : undefined;
}

// Сообщение покупателю о статусе. Прошлое такое сообщение удаляем — в чате остаётся только актуальное.
async function notifyBuyer(bot, order) {
  const language = await customers.getLanguage(order.chat_id);
  if (order.status_msg_id) await bot.telegram.deleteMessage(order.chat_id, order.status_msg_id).catch(() => {});
  const sentMessage = await bot.telegram
    .sendMessage(order.chat_id, await buyerText(order, language), { parse_mode: 'HTML', reply_markup: buyerKeyboard(order, language) })
    .catch((sendError) => console.error(`Не получилось написать покупателю (заказ ${order.code}):`, sendError.message));
  if (sentMessage) await database.order.update({ where: { id: order.id }, data: { status_msg_id: sentMessage.message_id } });
}

// ===== Владелице =====
function phoneOf(order) {
  const phoneMatch = String(order.address || '').match(/тел\.\s*([+\d][\d\s()-]{8,})/);
  return phoneMatch ? phoneMatch[1].trim() : '';
}

async function ownerText(order) {
  const buyerName = (await customers.getName(order.chat_id)) || 'Покупатель';
  const buyerPhone = phoneOf(order);
  const lines = [
    `${order.base === 'paid' ? '🆕 <b>Новый заказ</b>' : '<b>Заказ</b>'} № ${order.code} · ${formatRubles(order.total)}`,
    `👤 <a href="tg://user?id=${order.chat_id}">${escapeHtml(buyerName)}</a>${buyerPhone ? ' · ' + escapeHtml(buyerPhone) : ''}`,
    '',
    itemsText(order, 'ru'),
    '',
    isPickup(order) ? '🏠 Самовывоз' : `📍 ${escapeHtml(String(order.address || '').replace(/ · тел\..*$/, ''))}`,
  ];
  if (order.track) lines.push(`🚚 Трек: <code>${escapeHtml(order.track)}</code>`);
  if (order.rating) lines.push(`⭐ Оценка: ${order.rating}/5`);
  lines.push('', `Статус: <b>${statusLabel(order, 'ru')}</b>`);
  return lines.join('\n');
}

function ownerKeyboard(order) {
  const statusButton = (status, text) => ({ text: (order.base === status ? '• ' : '') + text, callback_data: `ost:${order.id}:${status}` });
  const keyboardRows = [];
  if (order.base === 'cancelled') {
    keyboardRows.push([statusButton('paid', order.paid_at ? '↩️ Вернуть в работу' : '✅ Оплачен (вручную)')]);
  } else {
    keyboardRows.push([statusButton('assembling', '📦 Собираем'), statusButton('shipped', isPickup(order) ? '🏠 Готов к выдаче' : '🚚 Отправлен')]);
    keyboardRows.push([statusButton('delivered', '✅ Доставлен'), statusButton('cancelled', '❌ Отменить')]);
  }
  keyboardRows.push([{ text: '💬 Написать покупателю', callback_data: `reply:${order.chat_id}` }]);
  const adminTabUrl = shopUrl({ tab: 'admin' });
  if (adminTabUrl) keyboardRows.push([{ text: '⚙️ Открыть админку', web_app: { url: adminTabUrl } }]);
  return { inline_keyboard: keyboardRows };
}

async function notifyOwnerAboutNewOrder(bot, order) {
  if (!ownerChatId()) return;
  await bot.telegram.sendMessage(ownerChatId(), await ownerText(order), { parse_mode: 'HTML', reply_markup: ownerKeyboard(order), disable_web_page_preview: true })
    .catch((sendError) => console.error('Не получилось уведомить владелицу:', sendError.message));
}

// ===== Склад =====
// Списываем не больше, чем есть, и запоминаем, сколько взяли. Возвращает список нехватки.
// Вызывается внутри runInTransaction — остаток читаем и меняем в той же транзакции.
async function takeStockForOrder(order) {
  const shortages = [];
  for (const orderItem of order.items) {
    const neededQuantity = orderItem.quantity - (orderItem.stock_taken || 0);
    if (neededQuantity <= 0) continue;
    const product = await database.product.findUnique({ where: { id: orderItem.product_id }, select: { stock: true } });
    const takenQuantity = Math.max(0, Math.min(product?.stock ?? 0, neededQuantity));
    if (takenQuantity) await database.product.update({ where: { id: orderItem.product_id }, data: { stock: { decrement: takenQuantity } } });
    await database.orderItem.update({ where: { id: orderItem.id }, data: { stock_taken: { increment: takenQuantity } } });
    if (takenQuantity < neededQuantity) shortages.push(`${orderItem.name || 'товар'} — не хватило ${neededQuantity - takenQuantity} шт.`);
  }
  return shortages;
}

// Возвращаем на склад ровно то, что списали (товар могли удалить из каталога — тогда возвращать некуда)
async function returnStockForOrder(order) {
  for (const orderItem of order.items) {
    if (!orderItem.stock_taken) continue;
    await database.product.updateMany({ where: { id: orderItem.product_id }, data: { stock: { increment: orderItem.stock_taken } } });
    await database.orderItem.update({ where: { id: orderItem.id }, data: { stock_taken: 0 } });
  }
}

async function warnOwnerAboutShortage(bot, order, shortages) {
  if (!shortages.length || !ownerChatId()) return;
  await bot.telegram.sendMessage(ownerChatId(),
    `⚠️ Заказ № ${order.code} оплачен, но на складе не хватило:\n${shortages.join('\n')}\n\nСвяжитесь с покупателем: дозаказать товар или вернуть часть денег.`)
    .catch(() => {});
}

// Сменить статус заказа (из админки или кнопкой в Telegram)
async function changeStatus(bot, orderId, newStatus, { track } = {}) {
  if (!MANUAL_STATUSES.has(newStatus)) throw new Error('Неизвестный статус');
  const order = await getOrder(orderId);
  if (!order) throw new Error('Заказ не найден');
  const wasPaid = PAID_STATUSES.has(order.base);
  const becomesPaid = PAID_STATUSES.has(newStatus);
  const newTrack = track === undefined ? order.track : String(track || '').trim().slice(0, 60) || null;
  if (order.base === newStatus && newTrack === order.track) return order;

  let shortages = [];
  await runInTransaction(async () => {
    if (wasPaid && newStatus === 'cancelled') await returnStockForOrder(order); // товар вернулся на склад
    if (!wasPaid && becomesPaid) shortages = await takeStockForOrder(order);   // вернули в работу / оплачен вручную
    const now = toSqliteTimestamp();
    await database.order.update({
      where: { id: orderId },
      data: { status: newStatus, track: newTrack, status_at: now, ...(becomesPaid && !order.paid_at ? { paid_at: now } : {}) },
    });
  });
  const updatedOrder = await getOrder(orderId);
  await notifyBuyer(bot, updatedOrder);
  await warnOwnerAboutShortage(bot, updatedOrder, shortages);
  return updatedOrder;
}

// Id платежа, которым должен оплачиваться заказ (у старых заказов он лежит в статусе)
function expectedPaymentId(order) {
  if (order.payment_id) return order.payment_id;
  return String(order.status).startsWith('awaiting_payment:') ? String(order.status).slice('awaiting_payment:'.length) : null;
}

// Оплата пришла (вебхук ЮKassa). Засчитываем платёж только один раз и только «свой»:
// повтор уведомления после возврата денег или чужой платёж заказ не «оживят».
async function markPaid(bot, orderId, paymentId) {
  const order = await getOrder(orderId);
  if (!order || order.paid_at || PAID_STATUSES.has(order.base)) return false; // деньги по заказу уже засчитаны
  if (!paymentId || expectedPaymentId(order) !== paymentId) return false;      // это не платёж этого заказа
  const wasCancelled = order.base === 'cancelled';
  let shortages = [];
  let exceededPromoCode = null;

  const isMarked = await runInTransaction(async () => {
    const freshOrder = await getOrder(orderId); // перечитали внутри транзакции
    if (freshOrder.paid_at) return false;
    shortages = await takeStockForOrder(freshOrder);
    const now = toSqliteTimestamp();
    await database.order.update({ where: { id: orderId }, data: { status: 'paid', status_at: now, paid_at: now } });
    if (freshOrder.promo_code) {
      // промокод могли удалить, пока заказ ждал оплату, — тогда считать нечего
      await database.promoCode.updateMany({ where: { code: freshOrder.promo_code }, data: { used_count: { increment: 1 } } });
      const promoCode = await database.promoCode.findUnique({ where: { code: freshOrder.promo_code } });
      if (promoCode && promoCode.max_uses !== null && promoCode.used_count > promoCode.max_uses) {
        exceededPromoCode = `${promoCode.code} (${promoCode.used_count}/${promoCode.max_uses})`;
      }
    }
    return true;
  });
  if (!isMarked) return false;

  const paidOrder = await getOrder(orderId);
  await notifyBuyer(bot, paidOrder);
  await notifyOwnerAboutNewOrder(bot, paidOrder);
  await warnOwnerAboutShortage(bot, paidOrder, shortages);
  if (exceededPromoCode && ownerChatId()) {
    await bot.telegram.sendMessage(ownerChatId(), `⚠️ Промокод ${exceededPromoCode} превысил лимит использований — заказ № ${paidOrder.code} оплачен со скидкой.`).catch(() => {});
  }
  if (wasCancelled && ownerChatId()) {
    await bot.telegram.sendMessage(ownerChatId(), `⚠️ Заказ № ${paidOrder.code} был отменён, но покупатель всё-таки оплатил — вернула его в работу.`).catch(() => {});
  }
  return true;
}

// Оценка после доставки
async function rateOrder(bot, chatId, orderId, stars) {
  const order = await getOrder(orderId);
  if (!order || String(order.chat_id) !== String(chatId) || order.base !== 'delivered') return null;
  if (order.rating) return order;
  await database.order.update({ where: { id: orderId }, data: { rating: stars } });
  if (ownerChatId()) {
    const buyerName = (await customers.getName(chatId)) || 'Покупатель';
    await bot.telegram.sendMessage(ownerChatId(), `${'⭐'.repeat(stars)} ${escapeHtml(buyerName)} оценил(а) заказ № ${order.code} на ${stars}/5`, { parse_mode: 'HTML' }).catch(() => {});
  }
  return getOrder(orderId);
}

module.exports = {
  ORDER_FLOW, PAID_STATUSES, MANUAL_STATUSES, STATUS_LABELS, baseStatus, generateOrderCode, getOrder, getOrderItems, getItemsByOrderId,
  createPendingOrder, cancelIfNotPaid, statusLabel, buyerText, buyerKeyboard, notifyBuyer, ownerText, ownerKeyboard,
  notifyOwnerAboutNewOrder, changeStatus, markPaid, rateOrder, shopUrl, phoneOf, isPickup, escapeHtml, formatRubles,
};
