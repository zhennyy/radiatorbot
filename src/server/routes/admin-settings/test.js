// Админка настроек: доставка, города, промокоды, статистика, чаты
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const OWNER_ID = testHelpers.OWNER_ID;
const BUYER_ID = 6401;
let shop;

before(async () => {
  shop = await testHelpers.start();
});

test('настройки: доставка, города, промокоды — без лишних разделов', async () => {
  const settings = await shop.call(OWNER_ID, 'GET', '/shop-api/admin/settings');
  assert.equal(settings.status, 200);
  assert.deepEqual(Object.keys(settings.body).sort(), ['cities', 'delivery', 'promos']);
  assert.deepEqual(settings.body.delivery, { otherPrice: 150000, freeFrom: 0, pickup: true, pickupAddress: '' });
  const saved = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/delivery', {
    otherPrice: '1 200',
    freeFrom: 30000,
    pickup: true,
    pickupAddress: 'Отрадное, ул. Победы, 1',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.delivery, {
    otherPrice: 120000,
    freeFrom: 3000000,
    pickup: true,
    pickupAddress: 'Отрадное, ул. Победы, 1',
  });
  const checkoutInfo = await shop.call(BUYER_ID, 'GET', '/shop-api/checkout-info');
  assert.equal(checkoutInfo.body.otherPrice, 120000);
  assert.equal(checkoutInfo.body.pickupAddress, 'Отрадное, ул. Победы, 1');
  assert.match(
    (await shop.call(OWNER_ID, 'POST', '/shop-api/admin/delivery', { otherPrice: 'дорого' })).body.error,
    /числом/,
  );
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/delivery', { otherPrice: 1 })).status, 403);
});

test('города: добавить, изменить цену, удалить', async () => {
  const added = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', { city: 'Казань', price: 900 });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const kazan = added.body.cities.find((rate) => rate.city === 'Казань');
  assert.equal(kazan.price, 90000);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', { city: 'К', price: 100 })).status, 400);
  const updated = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/cities', {
    id: kazan.id,
    city: 'Казань',
    price: 950,
  });
  assert.equal(updated.body.cities.find((rate) => rate.id === kazan.id).price, 95000);
  const removed = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/cities/${kazan.id}/delete`, {});
  assert.ok(!removed.body.cities.some((rate) => rate.id === kazan.id));
});

test('промокоды: проверка формы, дубль, выключение', async () => {
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'X', percent: 10 })).status, 400);
  assert.equal(
    (await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'AUTUMN', percent: 95 })).status,
    400,
  );
  const created = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', {
    code: 'autumn',
    percent: 15,
    max_uses: 3,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const promo = created.body.promos.find((promoCode) => promoCode.code === 'AUTUMN');
  assert.equal(promo.discount_percent, 15);
  assert.match(
    (await shop.call(OWNER_ID, 'POST', '/shop-api/admin/promos', { code: 'AUTUMN', percent: 10 })).body.error,
    /уже есть/,
  );
  const switchedOff = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/promos/${promo.id}`, { active: false });
  assert.equal(switchedOff.body.promos.find((promoCode) => promoCode.id === promo.id).active, 0);
});

test('статистика: выручка по оплаченным заказам, топ товаров, города', async () => {
  const actions = testHelpers.createShopActions(shop);
  const product = await shop.database.product.findFirst({ where: { name: 'Радиатор Nova Grande' } });
  await actions.setCart(BUYER_ID, [[product.id, 2]]);
  const response = await shop.call(BUYER_ID, 'POST', '/shop-api/order', {
    delivery: 'city',
    city: 'Псков',
    address: 'ул. Советская, 5',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await actions.payLastOrder();
  const stats = (await shop.call(OWNER_ID, 'GET', '/shop-api/admin/stats?days=30')).body;
  const order = await actions.findOrder(response.body.id);
  assert.equal(stats.orders, 1);
  assert.equal(stats.revenue, order.total);
  assert.equal(stats.delivery, order.delivery_cost);
  assert.deepEqual(stats.top[0], { id: product.id, name: 'Радиатор Nova Grande', qty: 2, revenue: 2 * product.price });
  assert.deepEqual(stats.cities[0], { city: 'Псков', orders: 1, revenue: order.total });
  assert.equal(stats.active, 1);
  assert.equal(stats.byDay.at(-1).orders, 1);
});

test('чаты: сообщение покупателю после его заказа; статистика и чаты только владелице', async () => {
  const sent = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/chats/${BUYER_ID}`, { text: 'Отправим завтра' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(shop.sent.some((message) => message.chat === BUYER_ID && /Магазин RadiatorPro/.test(message.text)));
  const chat = await shop.call(OWNER_ID, 'GET', `/shop-api/admin/chats/${BUYER_ID}`);
  assert.equal(chat.body.messages.at(-1).text, 'Отправим завтра');
  assert.equal(chat.body.orders.length, 1);
  assert.equal((await shop.call(OWNER_ID, 'GET', '/shop-api/admin/chats')).body.chats[0].chat_id, BUYER_ID);
  const NEW_BUYER_ID = 6402;
  const stats = await shop.call(OWNER_ID, 'GET', '/shop-api/admin/stats?days=7');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.days, 7);
  assert.equal(stats.body.byDay.length, 7);
  assert.equal((await shop.call(BUYER_ID, 'GET', '/shop-api/admin/stats')).status, 403);
  assert.equal(
    (await shop.call(OWNER_ID, 'POST', `/shop-api/admin/chats/${NEW_BUYER_ID}`, { text: '   ' })).status,
    400,
  );
  assert.match(
    (await shop.call(OWNER_ID, 'POST', `/shop-api/admin/chats/${NEW_BUYER_ID}`, { text: 'Привет' })).body.error,
    /ещё не писал/,
  );
});
