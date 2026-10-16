// Жизнь заказа: создание, смена статуса, оплата, оценка и уведомления.
// Используется и сервером витрины, и ботом (кнопки под уведомлением владелице).
// Статусы — в status.js, тексты и кнопки — в messages.js, склад — в stock.js.
const { database, runInTransaction, toSqliteTimestamp } = require('../database');
const customers = require('../customers');
const { escapeHtml, formatRubles } = require('./format');
const {
  ORDER_FLOW,
  PAID_STATUSES,
  MANUAL_STATUSES,
  STATUS_LABELS,
  baseStatus,
  isPickup,
  statusLabel,
} = require('./status');
const { shopUrl, buyerText, buyerKeyboard, phoneOf, ownerText, ownerKeyboard } = require('./messages');
const { takeStockForOrder, returnStockForOrder } = require('./stock');

// Короткий код заказа для покупателя: 4 символа без похожих друг на друга (0/O, 1/I исключены)
const ORDER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_CODE_LENGTH = 4;
const ownerChatId = () => process.env.OWNER_CHAT_ID;

async function generateOrderCode() {
  for (;;) {
    const candidateCode = Array.from(
      { length: ORDER_CODE_LENGTH },
      () => ORDER_CODE_ALPHABET[Math.floor(Math.random() * ORDER_CODE_ALPHABET.length)],
    ).join('');
    if (!(await database.order.findFirst({ where: { order_code: candidateCode }, select: { id: true } })))
      return candidateCode;
  }
}

// Позиции заказов с названием и остатком товара (товар мог быть удалён — тогда name = null)
async function getOrderItems(orderIds) {
  const orderItems = await database.orderItem.findMany({
    where: { order_id: { in: orderIds } },
    orderBy: { id: 'asc' },
  });
  const products = await database.product.findMany({
    where: { id: { in: [...new Set(orderItems.map((orderItem) => orderItem.product_id))] } },
    select: { id: true, name: true, name_en: true, stock: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  return orderItems.map((orderItem) => {
    const product = productById.get(orderItem.product_id);
    return {
      ...orderItem,
      name: product?.name ?? null,
      name_en: product?.name_en ?? null,
      stock: product?.stock ?? null,
    };
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

// Заказ со статусом pending; total уже с учётом скидки и доставки. items — [{product_id, quantity, price}].
// consentAt — когда покупатель согласился на обработку персональных данных (152-ФЗ)
async function createPendingOrder({
  chatId,
  address,
  total,
  items,
  promoCode = null,
  discountPercent = 0,
  deliveryCity = null,
  deliveryCost = 0,
  consentAt,
}) {
  // заказы создаются только из того, что ввёл покупатель, — значит, без его согласия нельзя
  if (!consentAt) throw new Error('Нет согласия покупателя на обработку персональных данных');
  return runInTransaction(async () => {
    const createdOrder = await database.order.create({
      data: {
        chat_id: Number(chatId),
        status: 'pending',
        total,
        address,
        payment_provider: 'yookassa',
        promo_code: promoCode,
        discount_percent: discountPercent,
        delivery_city: deliveryCity,
        delivery_cost: deliveryCost,
        order_code: await generateOrderCode(),
        consent_at: consentAt,
      },
    });
    await database.orderItem.createMany({
      data: items.map((orderLine) => ({
        order_id: createdOrder.id,
        product_id: orderLine.product_id,
        quantity: orderLine.quantity,
        price: orderLine.price,
      })),
    });
    return createdOrder.id;
  });
}

// Оплата не создалась — заказ не должен висеть в «ждёт оплату»
async function cancelIfNotPaid(orderId) {
  await database.order.updateMany({ where: { id: orderId, payment_id: null }, data: { status: 'cancelled' } });
}

// Сообщение покупателю о статусе. Прошлое такое сообщение удаляем — в чате остаётся только актуальное.
async function notifyBuyer(bot, order) {
  const language = await customers.getLanguage(order.chat_id);
  if (order.status_msg_id) await bot.telegram.deleteMessage(order.chat_id, order.status_msg_id).catch(() => {});
  const sentMessage = await bot.telegram
    .sendMessage(order.chat_id, await buyerText(order, language), {
      parse_mode: 'HTML',
      reply_markup: buyerKeyboard(order, language),
    })
    .catch((sendError) => console.error(`Не получилось написать покупателю (заказ ${order.code}):`, sendError.message));
  if (sentMessage)
    await database.order.update({ where: { id: order.id }, data: { status_msg_id: sentMessage.message_id } });
}

async function notifyOwnerAboutNewOrder(bot, order) {
  if (!ownerChatId()) return;
  await bot.telegram
    .sendMessage(ownerChatId(), await ownerText(order), {
      parse_mode: 'HTML',
      reply_markup: ownerKeyboard(order),
      disable_web_page_preview: true,
    })
    .catch((sendError) => console.error('Не получилось уведомить владелицу:', sendError.message));
}

async function warnOwnerAboutShortage(bot, order, shortages) {
  if (!shortages.length || !ownerChatId()) return;
  await bot.telegram
    .sendMessage(
      ownerChatId(),
      `⚠️ Заказ № ${order.code} оплачен, но на складе не хватило:\n${shortages.join('\n')}\n\nСвяжитесь с покупателем: дозаказать товар или вернуть часть денег.`,
    )
    .catch(() => {});
}

// Сменить статус заказа (из админки или кнопкой в Telegram)
async function changeStatus(bot, orderId, newStatus, { track } = {}) {
  if (!MANUAL_STATUSES.has(newStatus)) throw new Error('Неизвестный статус');
  const order = await getOrder(orderId);
  if (!order) throw new Error('Заказ не найден');
  const wasPaid = PAID_STATUSES.has(order.base);
  const becomesPaid = PAID_STATUSES.has(newStatus);
  const newTrack =
    track === undefined
      ? order.track
      : String(track || '')
          .trim()
          .slice(0, 60) || null;
  if (order.base === newStatus && newTrack === order.track) return order;

  let shortages = [];
  await runInTransaction(async () => {
    if (wasPaid && newStatus === 'cancelled') await returnStockForOrder(order); // товар вернулся на склад
    if (!wasPaid && becomesPaid) shortages = await takeStockForOrder(order); // вернули в работу / оплачен вручную
    const now = toSqliteTimestamp();
    await database.order.update({
      where: { id: orderId },
      data: {
        status: newStatus,
        track: newTrack,
        status_at: now,
        ...(becomesPaid && !order.paid_at ? { paid_at: now } : {}),
      },
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
  return String(order.status).startsWith('awaiting_payment:')
    ? String(order.status).slice('awaiting_payment:'.length)
    : null;
}

// Оплата пришла (вебхук ЮKassa). Засчитываем платёж только один раз и только «свой»:
// повтор уведомления после возврата денег или чужой платёж заказ не «оживят».
async function markPaid(bot, orderId, paymentId) {
  const order = await getOrder(orderId);
  if (!order || order.paid_at || PAID_STATUSES.has(order.base)) return false; // деньги по заказу уже засчитаны
  if (!paymentId || expectedPaymentId(order) !== paymentId) return false; // это не платёж этого заказа
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
      await database.promoCode.updateMany({
        where: { code: freshOrder.promo_code },
        data: { used_count: { increment: 1 } },
      });
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
    await bot.telegram
      .sendMessage(
        ownerChatId(),
        `⚠️ Промокод ${exceededPromoCode} превысил лимит использований — заказ № ${paidOrder.code} оплачен со скидкой.`,
      )
      .catch(() => {});
  }
  if (wasCancelled && ownerChatId()) {
    await bot.telegram
      .sendMessage(
        ownerChatId(),
        `⚠️ Заказ № ${paidOrder.code} был отменён, но покупатель всё-таки оплатил — вернула его в работу.`,
      )
      .catch(() => {});
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
    // без имени покупателя: сообщения владелице идут через Telegram (152-ФЗ)
    await bot.telegram
      .sendMessage(ownerChatId(), `${'⭐'.repeat(stars)} Покупатель оценил заказ № ${order.code} на ${stars}/5`)
      .catch(() => {});
  }
  return getOrder(orderId);
}

module.exports = {
  ORDER_FLOW,
  PAID_STATUSES,
  MANUAL_STATUSES,
  STATUS_LABELS,
  baseStatus,
  generateOrderCode,
  getOrder,
  getOrderItems,
  getItemsByOrderId,
  createPendingOrder,
  cancelIfNotPaid,
  statusLabel,
  buyerText,
  buyerKeyboard,
  notifyBuyer,
  ownerText,
  ownerKeyboard,
  notifyOwnerAboutNewOrder,
  changeStatus,
  markPaid,
  rateOrder,
  shopUrl,
  phoneOf,
  isPickup,
  escapeHtml,
  formatRubles,
};
