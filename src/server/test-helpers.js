// Общая обвязка тестов (файлы test.js рядом с кодом): временная база, подставные ЮKassa и Telegram, подписанные запросы витрины.
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.BOT_TOKEN = '123456:TESTTOKEN';
process.env.OWNER_CHAT_ID = '1001';
process.env.YOOKASSA_SHOP_ID = 'shop';
process.env.YOOKASSA_SECRET_KEY = 'key';
process.env.BOT_USERNAME = 'radiatorpro_test_bot';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radiatorbot-')), 'test.db');
process.env.WEBHOOK_PORT = String(30000 + Math.floor(Math.random() * 20000));

// ---- подставная ЮKassa: запоминаем платежи, чтобы проверять суммы и описания ----
const axios = require('axios');
const payments = new Map();
let paymentCounter = 0;
axios.post = async (url, body) => {
  if (url.includes('/v3/payments')) {
    const paymentId = 'pay-' + ++paymentCounter;
    const confirmation = { type: 'redirect', confirmation_url: 'https://pay.test/' + paymentId };
    payments.set(paymentId, {
      id: paymentId,
      body,
      status: 'pending',
      metadata: body.metadata,
      amount: body.amount,
      confirmation,
    });
    return { data: { id: paymentId, confirmation } };
  }
  throw new Error('unexpected POST ' + url);
};
axios.get = async (url) => {
  const paymentMatch = url.match(/payments\/(pay-\d+)/);
  if (paymentMatch) return { data: payments.get(paymentMatch[1]) };
  throw new Error('unexpected GET ' + url);
};

const sentMessages = []; // сообщения «в Telegram»
const fakeBot = {
  telegram: {
    sendMessage: async (chatId, text, extra) => {
      sentMessages.push({ chat: chatId, text, extra });
      return { message_id: sentMessages.length };
    },
    editMessageText: async () => ({}),
    getFileLink: async () => 'https://x',
    sendDocument: async () => ({}),
    deleteMessage: async () => ({}),
  },
};

// Подписанные Telegram данные пользователя — как их присылает мини-приложение
function initData(userId, extraFields = {}) {
  const parameters = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'T' }),
    ...extraFields,
  });
  const dataCheckString = [...parameters.entries()]
    .map(([fieldName, fieldValue]) => `${fieldName}=${fieldValue}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  parameters.set('hash', crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return parameters.toString();
}

async function start() {
  const { initializeDatabase } = require('../database/initialize');
  await initializeDatabase();
  const { startWebhookServer } = require('./index');
  startWebhookServer(fakeBot, {
    aiPick: async () => ({ adviceText: 'Подойдёт Nova Grande', productIds: [2] }),
    showCartFor: async () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const baseUrl = `http://127.0.0.1:${process.env.WEBHOOK_PORT}`;
  const call = (userId, method, urlPath, body, headers = {}) =>
    fetch(baseUrl + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(userId ? { 'X-Init-Data': initData(userId) } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const { database } = require('../database');
  return { base: baseUrl, call, payments, sent: sentMessages, bot: fakeBot, database };
}

const OWNER_ID = 1001;
const lastPayment = () => [...payments.values()].pop();

// Частые действия в тестах: работают с уже запущенным магазином (результат start())
function createShopActions(shop) {
  const setCart = async (chatId, productQuantities) => {
    for (const [productId, quantity] of productQuantities) {
      const response = await shop.call(chatId, 'POST', '/shop-api/cart', { product_id: productId, qty: quantity });
      if (response.status !== 200) throw new Error(`корзина: ${response.status} ${JSON.stringify(response.body)}`);
    }
  };
  const clearCart = (chatId) => shop.database.cartItem.deleteMany({ where: { chat_id: chatId } });
  // Оформить самовывоз из указанных товаров (корзину перед этим очищаем)
  const buy = async (chatId, productQuantities) => {
    await clearCart(chatId);
    await setCart(chatId, productQuantities);
    return shop.call(chatId, 'POST', '/shop-api/order', { delivery: 'pickup', phone: '89001234567' });
  };
  const sendPaymentWebhook = (paymentId) =>
    fetch(shop.base + '/yookassa-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded', object: { id: paymentId } }),
    });
  // ЮKassa подтверждает последний созданный платёж
  const payLastOrder = async () => {
    const payment = lastPayment();
    payment.status = 'succeeded';
    await sendPaymentWebhook(payment.id);
    return payment;
  };
  const createProduct = async (productForm) => {
    const response = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', productForm);
    if (response.status !== 200) throw new Error(`товар не создан: ${JSON.stringify(response.body)}`);
    return response.body.id;
  };
  const productsInStock = () =>
    shop.database.product.findMany({
      where: { stock: { gt: 5 } },
      select: { id: true, price: true, stock: true },
      orderBy: { id: 'asc' },
    });
  const findProduct = (productId) => shop.database.product.findUnique({ where: { id: productId } });
  const findOrder = (orderId) => shop.database.order.findUnique({ where: { id: orderId } });
  return {
    setCart,
    clearCart,
    buy,
    sendPaymentWebhook,
    payLastOrder,
    createProduct,
    productsInStock,
    findProduct,
    findOrder,
    lastPayment,
  };
}

module.exports = {
  start,
  payments,
  sent: sentMessages,
  bot: fakeBot,
  initData,
  createShopActions,
  lastPayment,
  OWNER_ID,
};
