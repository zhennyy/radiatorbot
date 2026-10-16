// Оформление в витрине: самовывоз, город из списка и «другой», бесплатная доставка, промокод, сбой оплаты, нехватка, защита промокодов
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5001;
let shop;
let actions;

const countCartRows = (chatId) => shop.database.cartItem.count({ where: { chat_id: chatId } });
// согласие на обработку данных по умолчанию отмечено — его отсутствие проверяет отдельный тест
const placeOrder = (orderForm) => shop.call(BUYER_ID, 'POST', '/shop-api/order', { consent: true, ...orderForm });

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
});

test('данные для оформления: города, доставка, самовывоз, онлайн-оплата', async () => {
  const response = await shop.call(BUYER_ID, 'GET', '/shop-api/checkout-info');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), [
    'cities',
    'freeFrom',
    'otherPrice',
    'payOnline',
    'pickup',
    'pickupAddress',
  ]);
  assert.equal(response.body.cities.length, 6);
  assert.deepEqual(
    response.body.cities.find((rate) => rate.city === 'Москва'),
    { city: 'Москва', city_en: 'Moscow', price: 70000 },
  );
  assert.equal(response.body.otherPrice, 150000);
  assert.equal(response.body.pickup, true);
  assert.equal(response.body.payOnline, true);
});

test('самовывоз: заказ создан, доставка 0, корзина очищена, ссылка на оплату в чат', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 2]]);
  shop.sent.length = 0;
  const response = await placeOrder({ delivery: 'pickup', phone: '+7 900 123-45-67' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body).sort(), ['code', 'id', 'ok', 'pay_url', 'total']);
  const order = await actions.findOrder(response.body.id);
  assert.equal(order.total, product.price * 2);
  assert.equal(order.delivery_cost, 0);
  assert.equal(order.delivery_city, null);
  assert.equal(order.address, 'Самовывоз · тел. +7 900 123-45-67');
  assert.equal(await countCartRows(BUYER_ID), 0);
  assert.equal(actions.lastPayment().body.description, `Заказ #${response.body.code} в RadiatorPro`);
  assert.ok(
    shop.sent.some(
      (message) =>
        message.chat === BUYER_ID &&
        message.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url === response.body.pay_url,
    ),
  );
  assert.equal((await placeOrder({ delivery: 'pickup' })).status, 400); // корзина пуста
});

test('город из списка (без учёта регистра и ё) и «другой» город по общему тарифу', async () => {
  const product = await shop.database.product.findFirst({ where: { price: { lt: 1000000 }, stock: { gt: 5 } } });
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const moscow = await placeOrder({ delivery: 'city', city: 'москва', address: 'ул. Ленина, 1' });
  assert.equal(moscow.status, 200, JSON.stringify(moscow.body));
  const moscowOrder = await actions.findOrder(moscow.body.id);
  assert.equal(moscowOrder.delivery_city, 'Москва');
  assert.equal(moscowOrder.delivery_cost, 70000);
  assert.equal(moscowOrder.total, product.price + 70000);
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const kazan = await placeOrder({ delivery: 'city', city: 'Казань', address: 'ул. Баумана, 1' });
  const kazanOrder = await actions.findOrder(kazan.body.id);
  assert.equal(kazanOrder.address, 'Казань, ул. Баумана, 1');
  assert.equal(kazanOrder.delivery_cost, 150000);
});

test('ошибки формы: город, адрес, телефон', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  assert.match((await placeOrder({ delivery: 'city', address: 'ул. Ленина, 1' })).body.error, /Выберите город/);
  assert.match((await placeOrder({ delivery: 'city', city: 'Москва', address: 'дом' })).body.error, /Укажите адрес/);
  assert.match((await placeOrder({ delivery: 'pickup', phone: '123' })).body.error, /номер телефона/);
  assert.equal(await countCartRows(BUYER_ID), 1, 'корзина не тронута');
  await actions.clearCart(BUYER_ID);
});

test('152-ФЗ: без согласия на обработку данных заказ не оформляется — 400 и корзина на месте', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const ordersBefore = await shop.database.order.count();
  for (const consent of [undefined, false, 'true', 1]) {
    const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', { delivery: 'pickup', consent });
    assert.equal(response.status, 400, `consent = ${JSON.stringify(consent)}`);
    assert.equal(response.body.error, 'Чтобы оформить заказ, отметьте согласие на обработку персональных данных');
  }
  assert.equal(await shop.database.order.count(), ordersBefore, 'заказ не создан');
  assert.equal(await countCartRows(BUYER_ID), 1, 'корзина не тронута');
  await actions.clearCart(BUYER_ID);
});

test('152-ФЗ: с согласием у заказа записано время согласия (consent_at)', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  const startedAt = new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19);
  const response = await placeOrder({ delivery: 'pickup' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await actions.findOrder(response.body.id);
  assert.match(order.consent_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/, 'формат как у других дат в базе');
  assert.ok(order.consent_at >= startedAt, `${order.consent_at} ≥ ${startedAt}`);
});

test('152-ФЗ: уведомление владелице о новом заказе — без телефона, адреса и имени, с городом и кнопкой админки', async () => {
  const previousShopUrl = process.env.SHOP_URL;
  process.env.SHOP_URL = 'https://radiator.test/shop/';
  await shop.database.userSettings.upsert({
    where: { chat_id: BUYER_ID },
    create: { chat_id: BUYER_ID, name: 'Анна Иванова' },
    update: { name: 'Анна Иванова' },
  });
  try {
    const [product] = await actions.productsInStock();
    await actions.setCart(BUYER_ID, [[product.id, 1]]);
    const response = await placeOrder({
      delivery: 'city',
      city: 'Москва',
      address: 'ул. Садовая, 15, кв. 8',
      phone: '+7 916 555-44-33',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    shop.sent.length = 0;
    await actions.payLastOrder();
    const ownerMessages = shop.sent.filter((message) => String(message.chat) === process.env.OWNER_CHAT_ID);
    const newOrderMessage = ownerMessages.find((message) => message.text.includes('Новый заказ'));
    assert.ok(newOrderMessage, 'владелице пришло уведомление о новом заказе');
    assert.match(newOrderMessage.text, new RegExp(`№ ${response.body.code}`));
    assert.match(newOrderMessage.text, /Доставка: Москва/);
    assert.match(newOrderMessage.text, /Контакты и адрес — в админке/);
    for (const message of ownerMessages) {
      assert.doesNotMatch(message.text, /Садовая|кв\. 8/, 'нет адреса');
      assert.doesNotMatch(message.text.replace(/\D/g, ''), /9165554433/, 'нет телефона');
      assert.doesNotMatch(message.text, /Иванова|Анна/, 'нет имени, которое покупатель ввёл в боте');
    }
    const buttons = newOrderMessage.extra.reply_markup.inline_keyboard.flat();
    assert.ok(
      buttons.some((button) => button.callback_data === `reply:${BUYER_ID}`),
      'кнопка «Написать покупателю»',
    );
    assert.ok(
      buttons.some((button) => button.web_app?.url?.startsWith('https://radiator.test/shop/')),
      'кнопка админки',
    );
    // покупателю в его же чат — его адрес можно
    const buyerMessage = shop.sent.find((message) => message.chat === BUYER_ID);
    assert.match(buyerMessage.text, /Садовая, 15/);
  } finally {
    if (previousShopUrl === undefined) delete process.env.SHOP_URL;
    else process.env.SHOP_URL = previousShopUrl;
  }
});

test('промокод даёт скидку на товары, бесплатная доставка от суммы, самовывоз можно выключить', async () => {
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'TEPLO10', percent: 10 });
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/delivery', {
    otherPrice: 1500,
    freeFrom: 10000,
    pickup: false,
    pickupAddress: '',
  });
  const product = await shop.database.product.findFirst({ where: { name: 'Радиатор Milano Bianco' } });
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  assert.match((await placeOrder({ delivery: 'pickup' })).body.error, /Самовывоза сейчас нет/);
  assert.equal(
    (await placeOrder({ delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', promo: 'НЕТ' })).status,
    400,
  );
  const response = await placeOrder({ delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', promo: ' teplo10 ' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await actions.findOrder(response.body.id);
  assert.equal(order.promo_code, 'TEPLO10');
  assert.equal(order.discount_percent, 10);
  assert.equal(order.delivery_cost, 0, '13 410 ₽ ≥ 10 000 ₽ — доставка бесплатно');
  assert.equal(order.total, Math.round(product.price * 0.9));
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/delivery', {
    otherPrice: 1500,
    freeFrom: '',
    pickup: true,
    pickupAddress: '',
  });
});

test('сбой создания оплаты: заказ отменён, корзина сохранена', async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  axios.post = async () => {
    throw new Error('boom');
  };
  const response = await placeOrder({ delivery: 'pickup', phone: '89001234567' });
  axios.post = originalPost;
  assert.equal(response.status, 502);
  assert.equal((await shop.database.order.findFirst({ orderBy: { id: 'desc' } })).status, 'cancelled');
  assert.equal(await countCartRows(BUYER_ID), 1);
  await actions.clearCart(BUYER_ID);
});

test('нехватка товара при оформлении', async () => {
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  await shop.database.product.update({ where: { id: product.id }, data: { stock: 0 } });
  const response = await placeOrder({ delivery: 'pickup', phone: '89001234567' });
  await shop.database.product.update({ where: { id: product.id }, data: { stock: product.stock } });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /^Недостаточно на складе: .+ \(осталось 0\)$/);
  await actions.clearCart(BUYER_ID);
});

test('промокоды нельзя подбирать: после 12 попыток — 429', async () => {
  let lastResponse;
  for (let attempt = 0; attempt < 14; attempt++)
    lastResponse = await shop.call(8001, 'POST', '/shop-api/promo', { code: 'NOPE' + attempt });
  assert.equal(lastResponse.status, 429);
});

test('без подписи Telegram оформить нельзя', async () => {
  assert.equal((await shop.call(null, 'GET', '/shop-api/checkout-info')).status, 401);
  assert.equal((await shop.call(null, 'POST', '/shop-api/order', {})).status, 401);
});
