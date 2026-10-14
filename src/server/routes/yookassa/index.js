// Вебхук ЮKassa (без авторизации — его вызывает сама ЮKassa). Уведомлению не верим на слово: переспрашиваем платёж у ЮKassa.
const express = require('express');
const { database } = require('../../../database');
const orders = require('../../../orders');
const { getPayment, OUR_APP_ID } = require('../../../payments/yookassa');
const { checkLowStock } = require('../../../notifications');
const { asyncHandler } = require('../../async-handler');
const { paymentSucceededValidator } = require('./validation');

function createYookassaRouter({ bot }) {
  const router = express.Router();

  router.post('/yookassa-webhook', paymentSucceededValidator, asyncHandler(async (request, response) => {
    let payment;
    try {
      payment = await getPayment(request.validated.paymentId);
    } catch (paymentError) {
      console.error('ЮKassa: не удалось проверить платёж', paymentError.message);
      return response.sendStatus(500); // ЮKassa повторит уведомление позже
    }
    if (payment.status !== 'succeeded') return response.sendStatus(200);
    // Платёж другого бота (тот же магазин ЮKassa, например «Флёр») — не наш, пропускаем
    const paymentApp = payment.metadata && payment.metadata.app;
    if (paymentApp && paymentApp !== OUR_APP_ID) return response.sendStatus(200);
    // Деньги уже (частично) вернули — повтор уведомления заказ не «оживляет»
    if (parseFloat(payment.refunded_amount?.value || 0) > 0) return response.sendStatus(200);

    const orderId = parseInt(payment.metadata && payment.metadata.order_id, 10);
    const order = orderId ? await database.order.findUnique({ where: { id: orderId } }) : null;
    if (!order || orders.PAID_STATUSES.has(orders.baseStatus(order.status))) return response.sendStatus(200); // защита от дублей
    // Сумма платежа должна совпасть с суммой заказа (в копейках)
    if (Math.round(parseFloat(payment.amount.value) * 100) !== order.total) {
      console.warn(`ЮKassa: сумма платежа ${payment.amount.value} не совпадает с заказом #${orderId}`);
      return response.sendStatus(200);
    }

    try {
      // статус, склад, промокод, сообщения покупателю и владелице; чужой/повторный платёж не засчитается
      if (!(await orders.markPaid(bot, orderId, payment.id))) console.warn(`ЮKassa: платёж ${payment.id} не засчитан заказу #${orderId} (повтор или чужой)`);
      checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message));
    } catch (processingError) {
      console.error('ЮKassa: оплата получена, но обработка заказа упала', processingError.message);
      return response.sendStatus(500);
    }
    return response.sendStatus(200);
  }));

  return router;
}

module.exports = { createYookassaRouter };
