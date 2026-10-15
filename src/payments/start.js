// Единая точка создания платежа для заказа (витрина и чат): платёж в ЮKassa, статус и id платежа у заказа
const { database } = require('../database');
const { createPayment } = require('./yookassa');

const paymentDescription = (orderCode) => `Заказ #${orderCode} в RadiatorPro`;

async function startPayment(orderId) {
  const order = await database.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('Заказ не найден');
  const orderCode = order.order_code || String(order.id);
  const payment = await createPayment(orderId, order.total / 100, paymentDescription(orderCode));
  await database.order.update({
    where: { id: orderId },
    data: { status: `awaiting_payment:${payment.id}`, payment_id: payment.id },
  });
  return payment;
}

module.exports = { startPayment, paymentDescription };
