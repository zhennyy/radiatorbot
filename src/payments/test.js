// Платёж ЮKassa: сумма, описание с кодом заказа, метка нашего бота; статус заказа после создания платежа
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

let shop;
before(async () => { shop = await testHelpers.start(); });

test('платёж создаётся на сумму заказа с кодом заказа и меткой radiatorbot', async () => {
  const orders = require('../orders');
  const { startPayment } = require('./start');
  const product = await shop.database.product.findFirst({ orderBy: { id: 'asc' } });
  const orderId = await orders.createPendingOrder({ chatId: 9101, address: 'Самовывоз', total: 123450, items: [{ product_id: product.id, quantity: 1, price: 123450 }] });
  const payment = await startPayment(orderId);
  const sentPayment = testHelpers.payments.get(payment.id);
  const order = await shop.database.order.findUnique({ where: { id: orderId } });
  assert.equal(sentPayment.body.amount.value, '1234.50');
  assert.equal(sentPayment.body.description, `Заказ #${order.order_code} в RadiatorPro`);
  assert.deepEqual(sentPayment.body.metadata, { order_id: orderId, app: 'radiatorbot' });
  assert.equal(order.status, `awaiting_payment:${payment.id}`);
  assert.equal(order.payment_id, payment.id);
  assert.match(order.order_code, /^[A-HJ-NP-Z2-9]{4}$/);
});
