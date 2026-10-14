// Бот в чате: прогоняем настоящие обработчики через подставной Telegram (без сети)
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

const OWNER_ID = 1001;
const BUYER_ID = 7392580260; // настоящие id Telegram бывают длиннее 32 бит
let shop;
let bot;
let telegramCalls = [];
let updateCounter = 0;
let messageCounter = 1000;

const sentTexts = () => telegramCalls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text);
const lastSentText = () => sentTexts().at(-1) || '';
const findCallbackButton = (textPattern) => {
  for (const call of [...telegramCalls].reverse()) {
    const keyboard = call.payload.reply_markup?.inline_keyboard || [];
    for (const button of keyboard.flat()) if (textPattern.test(button.text) && button.callback_data) return button.callback_data;
  }
  return null;
};

function sendText(chatId, text) {
  const commandMatch = text.match(/^\/\w+/);
  return bot.handleUpdate({
    update_id: ++updateCounter,
    message: {
      message_id: ++messageCounter, date: Math.floor(Date.now() / 1000), text,
      from: { id: chatId, is_bot: false, first_name: chatId === OWNER_ID ? 'Owner' : 'Анна' }, chat: { id: chatId, type: 'private' },
      ...(commandMatch ? { entities: [{ type: 'bot_command', offset: 0, length: commandMatch[0].length }] } : {}),
    },
  });
}

function pressButton(chatId, callbackData) {
  return bot.handleUpdate({
    update_id: ++updateCounter,
    callback_query: {
      id: String(updateCounter), data: callbackData, chat_instance: '1',
      from: { id: chatId, is_bot: false, first_name: 'Анна' },
      message: { message_id: ++messageCounter, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '…' },
    },
  });
}

before(async () => {
  shop = await testHelpers.start();
  ({ bot } = require('./index'));
  bot.botInfo = { id: 1, is_bot: true, first_name: 'RadiatorPro', username: 'radiatorpro_test_bot' };
  // каждый апдейт Telegraf обрабатывает со своим экземпляром Telegram — подменяем запросы у всех сразу
  require('telegraf').Telegram.prototype.callApi = async function fakeCallApi(method, payload) {
    telegramCalls.push({ method, payload });
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'copyMessage') return { message_id: ++messageCounter, chat: { id: payload.chat_id }, date: 0, text: payload.text };
    return true;
  };
});

test('знакомство: /start спрашивает имя и запоминает его', async () => {
  await sendText(BUYER_ID, '/start');
  assert.ok(sentTexts().some((text) => /RadiatorPro/.test(text)), 'приветствие RadiatorPro');
  assert.match(lastSentText(), /зовут/i);
  await sendText(BUYER_ID, 'Анна');
  assert.match(lastSentText(), /Анна/);
  assert.equal((await shop.database.userSettings.findUnique({ where: { chat_id: BUYER_ID } })).name, 'Анна');
});

test('каталог, корзина и оформление заказа в чате', async () => {
  telegramCalls = [];
  await sendText(BUYER_ID, '/catalog');
  const addToCartButton = findCallbackButton(/В корзину/);
  assert.ok(addToCartButton, 'есть кнопка «В корзину»');
  await pressButton(BUYER_ID, addToCartButton);
  assert.equal(await shop.database.cartItem.count({ where: { chat_id: BUYER_ID } }), 1);

  await sendText(BUYER_ID, '/cart');
  assert.match(lastSentText(), /Итого/);
  await pressButton(BUYER_ID, 'checkout_start');
  assert.ok(findCallbackButton(/Москва|Санкт-Петербург/), 'предложены города');
  await pressButton(BUYER_ID, findCallbackButton(/Москва/));
  await sendText(BUYER_ID, 'ул. Ленина, 1');
  assert.match(lastSentText(), /промокод/i);
  await sendText(BUYER_ID, '-');
  assert.match(lastSentText(), /Итого/);
  const ordersBefore = await shop.database.order.count();
  await pressButton(BUYER_ID, 'pay_yookassa');
  assert.equal(await shop.database.order.count(), ordersBefore + 1);
  const createdOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  assert.match(createdOrder.status, /^awaiting_payment:/);
  assert.equal(createdOrder.delivery_city, 'Москва');
  assert.equal(await shop.database.cartItem.count({ where: { chat_id: BUYER_ID } }), 0, 'корзина очищена');
  assert.match(lastSentText(), /оплат/i);
  assert.match(testHelpers.lastPayment().body.description, new RegExp(`^Заказ #${createdOrder.order_code} в RadiatorPro$`));
});

test('сбой ЮKassa при оплате в чате: заказ отменён, корзина на месте', async () => {
  const axios = require('axios');
  const product = await shop.database.product.findFirst({ where: { stock: { gt: 1 } }, orderBy: { id: 'asc' } });
  await shop.database.cartItem.create({ data: { chat_id: BUYER_ID, product_id: product.id, quantity: 1 } });
  await pressButton(BUYER_ID, 'checkout_start');
  await pressButton(BUYER_ID, 'deliv_pickup');
  await sendText(BUYER_ID, '-');
  const originalPost = axios.post;
  axios.post = async () => { throw new Error('ЮKassa недоступна'); };
  try {
    await pressButton(BUYER_ID, 'pay_yookassa');
  } finally {
    axios.post = originalPost;
  }
  const failedOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  assert.equal(failedOrder.status, 'cancelled');
  assert.equal(failedOrder.address, 'Самовывоз');
  assert.match(lastSentText(), /Не удалось создать платёж/);
  assert.equal(await shop.database.cartItem.count({ where: { chat_id: BUYER_ID } }), 1);
  await shop.database.cartItem.deleteMany({ where: { chat_id: BUYER_ID } });
});

test('команды владелицы: промокод, остаток, доставка, заказы; покупателю недоступны', async () => {
  await sendText(OWNER_ID, '/addpromo BOTTEST 15 3');
  assert.match(lastSentText(), /создан/);
  await sendText(OWNER_ID, '/addpromo bottest 15');
  assert.match(lastSentText(), /уже существует/);
  await sendText(OWNER_ID, '/promos');
  assert.match(lastSentText(), /BOTTEST — 15%/);
  await sendText(OWNER_ID, '/delpromo bottest');
  assert.match(lastSentText(), /выключен/);

  const product = await shop.database.product.findFirst({ orderBy: { id: 'asc' } });
  await sendText(OWNER_ID, `/stock ${product.id} 42`);
  assert.equal((await shop.database.product.findUnique({ where: { id: product.id } })).stock, 42);
  assert.match(lastSentText(), /обновлён: 42/);
  await sendText(OWNER_ID, `/stock ${product.id} много`); // раньше в базу уходил NULL и команда падала
  assert.match(lastSentText(), /Не получилось/);
  assert.equal((await shop.database.product.findUnique({ where: { id: product.id } })).stock, 42);

  await sendText(OWNER_ID, '/adddelivery Казань 900');
  assert.equal((await shop.database.deliveryRate.findUnique({ where: { city: 'Казань' } })).price, 90000);
  await sendText(OWNER_ID, '/deldelivery казань');
  assert.equal((await shop.database.deliveryRate.findUnique({ where: { city: 'Казань' } })).active, 0);

  await sendText(OWNER_ID, '/deliveries');
  assert.match(lastSentText(), /Казань — 900 ₽ \(выключен\)/);
  await sendText(OWNER_ID, '/orders');
  assert.match(sentTexts().join('\n'), /Заказ #\d+/);

  const callsBefore = telegramCalls.length;
  await sendText(BUYER_ID, '/addpromo HACK 50');
  assert.equal(await shop.database.promoCode.count({ where: { code: 'HACK' } }), 0);
  assert.equal(telegramCalls.slice(callsBefore).filter((call) => /HACK/.test(call.payload.text || '')).length, 0);
});

test('переписка: сообщение покупателя уходит владелице, ответ — покупателю', async () => {
  telegramCalls = [];
  await sendText(BUYER_ID, 'Здравствуйте, а есть белые трубчатые?');
  const toOwner = telegramCalls.find((call) => call.method === 'sendMessage' && String(call.payload.chat_id) === String(OWNER_ID));
  assert.ok(toOwner, 'владелица получила сообщение');
  assert.match(toOwner.payload.text, /трубчатые/);
  const savedMessage = await shop.database.message.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  assert.equal(savedMessage.from_owner, 0);

  await pressButton(OWNER_ID, `reply:${BUYER_ID}`);
  telegramCalls = [];
  await sendText(OWNER_ID, 'Да, есть Milano Bianco в белом');
  const toBuyer = telegramCalls.find((call) => call.method === 'sendMessage' && String(call.payload.chat_id) === String(BUYER_ID));
  assert.ok(toBuyer, 'покупатель получил ответ');
  assert.match(toBuyer.payload.text, /Milano Bianco/);
  const ownerReply = await shop.database.message.findFirst({ where: { chat_id: BUYER_ID, from_owner: 1 }, orderBy: { id: 'desc' } });
  assert.match(ownerReply.text, /Milano Bianco/);
});

test('статус заказа кнопкой владелицы и оценка покупателя', async () => {
  const order = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  await shop.database.order.update({ where: { id: order.id }, data: { status: 'paid', paid_at: '2026-01-01 00:00:00' } });
  await pressButton(OWNER_ID, `ost:${order.id}:delivered`);
  assert.equal((await shop.database.order.findUnique({ where: { id: order.id } })).status, 'delivered');
  await pressButton(BUYER_ID, `rate:${order.id}:5`);
  assert.equal((await shop.database.order.findUnique({ where: { id: order.id } })).rating, 5);
});
