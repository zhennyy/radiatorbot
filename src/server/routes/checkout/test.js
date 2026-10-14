// Оформление в витрине: самовывоз, город из списка и «другой», бесплатная доставка, промокод, сбой оплаты, нехватка, защита промокодов
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5001;
let shop;
let actions;

const countCartRows = (chatId) => shop.database.cartItem.count({ where: { chat_id: chatId } });
const placeOrder = (orderForm) => shop.call(BUYER_ID, 'POST', '/shop-api/order', orderForm);

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
});

test('данные для оформления: города, доставка, самовывоз, онлайн-оплата', async () => {
  const response = await shop.call(BUYER_ID, 'GET', '/shop-api/checkout-info');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['cities', 'freeFrom', 'otherPrice', 'payOnline', 'pickup', 'pickupAddress']);
  assert.equal(response.body.cities.length, 6);
  assert.deepEqual(response.body.cities.find((rate) => rate.city === 'Москва'), { city: 'Москва', city_en: 'Moscow', price: 70000 });
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
  assert.ok(shop.sent.some((message) => message.chat === BUYER_ID && message.extra?.reply_markup?.inline_keyboard?.[0]?.[0]?.url === response.body.pay_url));
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

test('промокод даёт скидку на товары, бесплатная доставка от суммы, самовывоз можно выключить', async () => {
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'TEPLO10', percent: 10 });
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/delivery', { otherPrice: 1500, freeFrom: 10000, pickup: false, pickupAddress: '' });
  const product = await shop.database.product.findFirst({ where: { name: 'Радиатор Milano Bianco' } });
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  assert.match((await placeOrder({ delivery: 'pickup' })).body.error, /Самовывоза сейчас нет/);
  assert.equal((await placeOrder({ delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', promo: 'НЕТ' })).status, 400);
  const response = await placeOrder({ delivery: 'city', city: 'Москва', address: 'ул. Ленина, 1', promo: ' teplo10 ' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const order = await actions.findOrder(response.body.id);
  assert.equal(order.promo_code, 'TEPLO10');
  assert.equal(order.discount_percent, 10);
  assert.equal(order.delivery_cost, 0, '13 410 ₽ ≥ 10 000 ₽ — доставка бесплатно');
  assert.equal(order.total, Math.round(product.price * 0.9));
  await shop.call(testHelpers.OWNER_ID, 'POST', '/shop-api/admin/delivery', { otherPrice: 1500, freeFrom: '', pickup: true, pickupAddress: '' });
});

test('сбой создания оплаты: заказ отменён, корзина сохранена', async () => {
  const axios = require('axios');
  const originalPost = axios.post;
  const [product] = await actions.productsInStock();
  await actions.setCart(BUYER_ID, [[product.id, 1]]);
  axios.post = async () => { throw new Error('boom'); };
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
  for (let attempt = 0; attempt < 14; attempt++) lastResponse = await shop.call(8001, 'POST', '/shop-api/promo', { code: 'NOPE' + attempt });
  assert.equal(lastResponse.status, 429);
});

test('без подписи Telegram оформить нельзя', async () => {
  assert.equal((await shop.call(null, 'GET', '/shop-api/checkout-info')).status, 401);
  assert.equal((await shop.call(null, 'POST', '/shop-api/order', {})).status, 401);
});
