// Витрина: каталог, корзина, язык, мои заказы, ссылка на оплату, AI-подбор, чужие заказы
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const BUYER_ID = 5201;
const CATALOG_PRODUCT_FIELDS = [
  'category',
  'category_en',
  'description',
  'description_en',
  'id',
  'name',
  'name_en',
  'photo',
  'price',
  'stock',
];
let shop;
let actions;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
});

test('каталог: стартовые радиаторы, поля как ждёт витрина, признак владелицы', async () => {
  const response = await shop.call(BUYER_ID, 'GET', '/shop-api/catalog');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['cart', 'isOwner', 'lang', 'products', 'unread']);
  assert.equal(response.body.isOwner, false);
  assert.equal(response.body.lang, 'ru');
  const milano = response.body.products.find((product) => product.name === 'Радиатор Milano Bianco');
  assert.ok(milano, 'стартовый товар на месте');
  assert.equal(milano.price, 1490000);
  assert.equal(milano.name_en, 'Milano Bianco Radiator');
  assert.deepEqual(Object.keys(milano).sort(), CATALOG_PRODUCT_FIELDS);
  assert.equal((await shop.call(testHelpers.OWNER_ID, 'GET', '/shop-api/catalog')).body.isOwner, true);
});

test('каталог: сначала товары в наличии, фото — через наш сервер с версией', async () => {
  const [product] = await actions.productsInStock();
  await shop.database.product.update({
    where: { id: product.id },
    data: { stock: 0, photo_url: 'https://example.com/a.jpg' },
  });
  const products = (await shop.call(BUYER_ID, 'GET', '/shop-api/catalog')).body.products;
  assert.equal(products.at(-1).id, product.id, 'закончившийся товар в конце');
  assert.match(products.at(-1).photo, new RegExp(`^/shop-photo/${product.id}\\?v=[0-9a-f]{8}$`));
  await shop.database.product.update({ where: { id: product.id }, data: { stock: product.stock, photo_url: null } });
});

test('корзина: несуществующий товар, больше остатка, добавить и убрать', async () => {
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: 'abc', qty: 1 })).status, 404);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: 999999, qty: 1 })).status, 404);
  const [product] = await actions.productsInStock();
  assert.equal(
    (await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: product.id, qty: product.stock + 1 })).status,
    400,
  );
  const added = await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: product.id, qty: 2 });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, { ok: true, cart: { [product.id]: 2 } });
  const removed = await shop.call(BUYER_ID, 'POST', '/shop-api/cart', { product_id: product.id, qty: 0 });
  assert.deepEqual(removed.body.cart, {});
});

test('язык витрины: en сохраняется, всё остальное — ru', async () => {
  assert.deepEqual((await shop.call(BUYER_ID, 'POST', '/shop-api/lang', { lang: 'en' })).body, {
    ok: true,
    lang: 'en',
  });
  assert.equal((await shop.call(BUYER_ID, 'GET', '/shop-api/catalog')).body.lang, 'en');
  assert.deepEqual((await shop.call(BUYER_ID, 'POST', '/shop-api/lang', { lang: 'de' })).body, {
    ok: true,
    lang: 'ru',
  });
});

test('мои заказы: состав, статус, ссылка на оплату; чужой заказ недоступен', async () => {
  const [product] = await actions.productsInStock();
  const orderResponse = await actions.buy(BUYER_ID, [[product.id, 1]]);
  assert.equal(orderResponse.status, 200, JSON.stringify(orderResponse.body));
  const myOrders = (await shop.call(BUYER_ID, 'GET', '/shop-api/orders')).body.orders;
  const order = myOrders.find((listedOrder) => listedOrder.id === orderResponse.body.id);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.can_pay, true);
  assert.equal(order.pickup, true);
  assert.equal(order.code, orderResponse.body.code);
  assert.deepEqual(order.items, [
    { id: product.id, qty: 1, price: product.price, name: (await actions.findProduct(product.id)).name },
  ]);
  assert.equal((await shop.call(BUYER_ID + 1, 'GET', '/shop-api/orders')).body.orders.length, 0);
  const payLink = await shop.call(BUYER_ID, 'POST', `/shop-api/orders/${order.id}/pay`, {});
  assert.equal(payLink.status, 200);
  assert.match(payLink.body.pay_url, /^https:\/\/pay\.test\//);
  assert.equal((await shop.call(BUYER_ID + 1, 'POST', `/shop-api/orders/${order.id}/pay`, {})).status, 404);
  await actions.payLastOrder();
  assert.equal(
    (await shop.call(BUYER_ID, 'POST', `/shop-api/orders/${order.id}/pay`, {})).status,
    404,
    'оплаченный заказ уже не ждёт оплату',
  );
});

test('AI-подбор: пустой запрос, ответ консультанта, не чаще раза в 5 секунд', async () => {
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/ai', { query: '   ' })).status, 400);
  const answer = await shop.call(BUYER_ID, 'POST', '/shop-api/ai', { query: 'Комната 20 м², центральное отопление' });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { advice: 'Подойдёт Nova Grande', ids: [2] });
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/ai', { query: 'Ещё раз' })).status, 429);
});

test('корзина в чат по кнопке «Оформить»', async () => {
  assert.deepEqual((await shop.call(BUYER_ID, 'POST', '/shop-api/checkout', {})).body, { ok: true });
});
