// Админка: статистика, чаты с покупателями, настройки доставки, города, промокоды
const express = require('express');
const axios = require('axios');
const { database, toSqliteTimestamp } = require('../../../database');
const orders = require('../../../orders');
const customers = require('../../../customers');
const messages = require('../../../chat/messages');
const { sendToBuyer } = require('../../../chat');
const { getDeliverySettings, setSetting } = require('../../../settings');
const { asyncHandler } = require('../../async-handler');
const { idParamValidator } = require('../../validation');
const {
  statsValidator, chatIdValidator, chatMessageValidator, deliverySettingsValidator, cityValidator, promoCodeValidator, promoToggleValidator,
} = require('./validation');

const DAY_MS = 864e5;
const MOSCOW_OFFSET_MS = 3 * 3600e3;
const TOP_LIST_SIZE = 6;
const CHAT_ORDERS_LIMIT = 10;
const LOW_STOCK_PIECES = 3;
const ACTIVE_STATUSES = ['paid', 'assembling', 'shipped'];

// «2026-10-08 21:30:00» (UTC) → дата по Москве «2026-10-09»
const moscowDay = (sqliteTimestamp) => new Date(new Date(String(sqliteTimestamp).replace(' ', 'T') + 'Z').getTime() + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);

async function buildStats(days) {
  const todayInMoscow = new Date(Date.now() + MOSCOW_OFFSET_MS);
  const firstDay = new Date(todayInMoscow - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  // created_at — UTC; дни считаем по Москве (+3 ч)
  const periodStartUtc = toSqliteTimestamp(new Date(firstDay + 'T00:00:00Z').getTime() - MOSCOW_OFFSET_MS);
  const periodOrders = (await database.order.findMany({ where: { created_at: { gte: periodStartUtc } } }))
    .filter((order) => order.created_at)
    .map((order) => ({ ...order, day: moscowDay(order.created_at) }))
    .filter((order) => order.day >= firstDay);
  const paidOrders = periodOrders.filter((order) => orders.PAID_STATUSES.has(orders.baseStatus(order.status)));
  const revenue = paidOrders.reduce((sum, order) => sum + order.total, 0);
  const deliveryRevenue = paidOrders.reduce((sum, order) => sum + (order.delivery_cost || 0), 0);

  const byDay = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    const date = new Date(todayInMoscow - daysAgo * DAY_MS).toISOString().slice(0, 10);
    const dayOrders = paidOrders.filter((order) => order.day === date);
    byDay.push({ date, revenue: dayOrders.reduce((sum, order) => sum + order.total, 0), orders: dayOrders.length });
  }

  const topProducts = new Map();
  for (const orderItem of await orders.getOrderItems(paidOrders.map((order) => order.id))) {
    const productTotals = topProducts.get(orderItem.product_id) || { id: orderItem.product_id, name: orderItem.name || '—', qty: 0, revenue: 0 };
    productTotals.qty += orderItem.quantity;
    productTotals.revenue += orderItem.quantity * orderItem.price;
    topProducts.set(orderItem.product_id, productTotals);
  }
  const cities = new Map();
  for (const order of paidOrders) {
    const cityName = order.delivery_city || 'Самовывоз';
    const cityTotals = cities.get(cityName) || { city: cityName, orders: 0, revenue: 0 };
    cityTotals.orders++;
    cityTotals.revenue += order.total;
    cities.set(cityName, cityTotals);
  }
  const ordersPerCustomer = new Map();
  for (const order of paidOrders) ordersPerCustomer.set(order.chat_id, (ordersPerCustomer.get(order.chat_id) || 0) + 1);
  const ratedOrders = paidOrders.filter((order) => order.rating);
  const countByStatus = {};
  for (const order of periodOrders) {
    const status = orders.baseStatus(order.status);
    countByStatus[status] = (countByStatus[status] || 0) + 1;
  }

  return {
    days, revenue, delivery: deliveryRevenue, goods: revenue - deliveryRevenue,
    orders: paidOrders.length,
    avg: paidOrders.length ? Math.round(revenue / paidOrders.length) : 0,
    customers: ordersPerCustomer.size,
    repeat: [...ordersPerCustomer.values()].filter((orderCount) => orderCount > 1).length,
    unpaid: (countByStatus.awaiting_payment || 0) + (countByStatus.pending || 0),
    cancelled: countByStatus.cancelled || 0,
    promoUsed: paidOrders.filter((order) => order.promo_code).length,
    rating: ratedOrders.length ? Math.round((ratedOrders.reduce((sum, order) => sum + order.rating, 0) / ratedOrders.length) * 10) / 10 : null,
    rated: ratedOrders.length,
    active: await database.order.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    byDay,
    top: [...topProducts.values()].sort((first, second) => second.revenue - first.revenue).slice(0, TOP_LIST_SIZE),
    cities: [...cities.values()].sort((first, second) => second.revenue - first.revenue).slice(0, TOP_LIST_SIZE),
    lowStock: await database.product.findMany({ where: { stock: { lte: LOW_STOCK_PIECES } }, select: { id: true, name: true, stock: true }, orderBy: [{ stock: 'asc' }, { name: 'asc' }] }),
  };
}

// Всё, что показывает вкладка «Настройки»
async function buildSettings() {
  return {
    delivery: await getDeliverySettings(),
    cities: await database.deliveryRate.findMany({ select: { id: true, city: true, city_en: true, price: true, active: true }, orderBy: [{ active: 'desc' }, { city: 'asc' }] }),
    promos: await database.promoCode.findMany({
      select: { id: true, code: true, discount_percent: true, max_uses: true, used_count: true, active: true }, orderBy: [{ active: 'desc' }, { id: 'desc' }],
    }),
  };
}

function createAdminSettingsRouter({ bot, ownerAuth }) {
  const router = express.Router();
  // Ответ JSON или {error} со статусом 400
  const jsonRoute = (handler) => asyncHandler(async (request, response) => {
    try {
      response.json(await handler(request));
    } catch (routeError) {
      response.status(400).json({ error: routeError.message });
    }
  });

  // ───────── 📊 Статистика ─────────
  router.get('/stats', ...ownerAuth, statsValidator, jsonRoute((request) => buildStats(request.validated.days)));

  // ───────── 💬 Чаты ─────────
  router.get('/chats', ...ownerAuth, jsonRoute(async () => ({ chats: await messages.listChats(), unread: await messages.countUnread() })));
  router.get('/chats/:chatId', ...ownerAuth, chatIdValidator, jsonRoute(async (request) => {
    const { chatId } = request.validated;
    await messages.markChatRead(chatId);
    const buyerOrders = await database.order.findMany({
      where: { chat_id: chatId }, orderBy: { id: 'desc' }, take: CHAT_ORDERS_LIMIT, select: { id: true, order_code: true, status: true, total: true },
    });
    return {
      name: (await customers.getName(chatId)) || '',
      messages: await messages.getChatHistory(chatId),
      orders: buyerOrders.map((order) => ({ id: order.id, code: order.order_code || String(order.id), status: orders.baseStatus(order.status), total: order.total })),
      unread: await messages.countUnread(),
    };
  }));
  router.post('/chats/:chatId', ...ownerAuth, chatMessageValidator, jsonRoute(async (request) => {
    const { chatId, text } = request.validated;
    const hasWrittenBefore = (await database.message.count({ where: { chat_id: chatId } })) > 0 || (await database.order.count({ where: { chat_id: chatId } })) > 0;
    if (!hasWrittenBefore) throw new Error('Этот покупатель ещё не писал магазину');
    try {
      await sendToBuyer(bot, chatId, { text });
    } catch (sendError) {
      throw new Error('Telegram не доставил сообщение: ' + sendError.message);
    }
    return { messages: await messages.getChatHistory(chatId) };
  }));
  // Фото из переписки хранит Telegram — отдаём через сервер, только владелице
  router.get('/photo/:fileId', ...ownerAuth, asyncHandler(async (request, response) => {
    try {
      if (!(await messages.isKnownPhoto(request.params.fileId))) return response.sendStatus(404);
      const fileLink = await bot.telegram.getFileLink(request.params.fileId);
      const photoResponse = await axios.get(String(fileLink), { responseType: 'arraybuffer', timeout: 15000 });
      return response.set({ 'Content-Type': photoResponse.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        .send(Buffer.from(photoResponse.data));
    } catch {
      return response.sendStatus(404);
    }
  }));

  // ───────── ⚙️ Настройки доставки ─────────
  router.get('/settings', ...ownerAuth, jsonRoute(buildSettings));

  router.post('/delivery', ...ownerAuth, deliverySettingsValidator, jsonRoute(async (request) => {
    await setSetting('delivery', request.validated.deliverySettings);
    return buildSettings();
  }));

  router.post('/cities', ...ownerAuth, cityValidator, jsonRoute(async (request) => {
    const { rateId, city, price, isActive } = request.validated;
    if (rateId) {
      // city в базе с COLLATE NOCASE — «Moscow» и «moscow» считаются одним городом
      const sameNameRate = await database.deliveryRate.findFirst({ where: { city, id: { not: rateId } }, select: { id: true } });
      if (sameNameRate) throw new Error('Такой город уже есть');
      await database.deliveryRate.updateMany({ where: { id: rateId }, data: { city, price, active: isActive ? 1 : 0 } });
    } else {
      await database.deliveryRate.upsert({ where: { city }, create: { city, price }, update: { price, active: 1 } });
    }
    return buildSettings();
  }));
  router.post('/cities/:id/delete', ...ownerAuth, idParamValidator('rateId'), jsonRoute(async (request) => {
    await database.deliveryRate.deleteMany({ where: { id: request.validated.rateId } });
    return buildSettings();
  }));

  // ───────── 🎟 Промокоды ─────────
  router.post('/promos', ...ownerAuth, promoCodeValidator, jsonRoute(async (request) => {
    const { code, discountPercent, maxUses } = request.validated;
    try {
      await database.promoCode.create({ data: { code, discount_percent: discountPercent, max_uses: maxUses } });
    } catch (createError) {
      if (createError.code === 'P2002' || String(createError.message).includes('UNIQUE')) throw new Error(`Промокод ${code} уже есть`);
      throw createError;
    }
    return buildSettings();
  }));
  router.post('/promos/:id', ...ownerAuth, promoToggleValidator, jsonRoute(async (request) => {
    await database.promoCode.updateMany({ where: { id: request.validated.promoId }, data: { active: request.validated.isActive ? 1 : 0 } });
    return buildSettings();
  }));
  router.post('/promos/:id/delete', ...ownerAuth, idParamValidator('promoId'), jsonRoute(async (request) => {
    await database.promoCode.deleteMany({ where: { id: request.validated.promoId } });
    return buildSettings();
  }));

  return router;
}

module.exports = { createAdminSettingsRouter };
