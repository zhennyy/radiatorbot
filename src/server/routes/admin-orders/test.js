// Админка заказов: список, смена статуса, трек-номер, доступ только владелице
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const OWNER_ID = testHelpers.OWNER_ID;
const BUYER_ID = 6301;
let shop;
let actions;
let paidOrderId;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
  const [product] = await actions.productsInStock();
  const response = await actions.buy(BUYER_ID, [[product.id, 1]]);
  await actions.payLastOrder();
  paidOrderId = response.body.id;
});

const changeStatus = (userId, body) => shop.call(userId, 'POST', `/shop-api/admin/orders/${paidOrderId}/status`, body);

test('список заказов: только владелице, с составом и телефоном', async () => {
  assert.equal((await shop.call(BUYER_ID, 'GET', '/shop-api/admin/orders')).status, 403);
  const response = await shop.call(OWNER_ID, 'GET', '/shop-api/admin/orders');
  assert.equal(response.status, 200);
  const listedOrder = response.body.orders.find((order) => order.id === paidOrderId);
  assert.equal(listedOrder.status, 'paid');
  assert.equal(listedOrder.items.length, 1);
  assert.equal(listedOrder.phone, '89001234567');
});

test('смена статуса: отправка с трек-номером, покупателю приходит уведомление', async () => {
  shop.sent.length = 0;
  const response = await changeStatus(OWNER_ID, { status: 'shipped', track: 'RA123456789RU' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, 'shipped');
  assert.equal(response.body.track, 'RA123456789RU');
  assert.ok(shop.sent.some((message) => message.chat === BUYER_ID && /RA123456789RU/.test(message.text)));
});

test('неизвестный статус и чужие руки отклоняются', async () => {
  assert.equal((await changeStatus(OWNER_ID, { status: 'awaiting_payment' })).status, 400);
  assert.equal((await changeStatus(OWNER_ID, { status: 'взломан' })).status, 400);
  assert.equal((await changeStatus(BUYER_ID, { status: 'delivered' })).status, 403);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/orders/999999/status', { status: 'delivered' })).status, 400);
});
