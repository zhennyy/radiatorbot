// Оформление и оплата прямо в витрине. Всё считаем на сервере: цены — из базы, доставка — из тарифов, скидка — из промокода.
const express = require('express');
const { database, toSqliteTimestamp } = require('../../../database');
const { translate } = require('../../../i18n');
const cart = require('../../../cart');
const pricing = require('../../../pricing');
const orders = require('../../../orders');
const customers = require('../../../customers');
const { startPayment } = require('../../../payments/start');
const { getDeliverySettings } = require('../../../settings');
const { asyncHandler } = require('../../async-handler');
const { promoPostValidator, orderPostValidator } = require('./validation');

const PROMO_ATTEMPTS_PER_MINUTE = 12;
const ONE_MINUTE_MS = 60000;

function createCheckoutRouter({ bot, shopAuth, isRequestAllowed }) {
  const router = express.Router();
  const isPromoAttemptAllowed = (chatId) =>
    isRequestAllowed('promo:' + chatId, PROMO_ATTEMPTS_PER_MINUTE, ONE_MINUTE_MS);

  router.get(
    '/checkout-info',
    shopAuth,
    asyncHandler(async (request, response) => {
      const cities = await database.deliveryRate.findMany({
        where: { active: 1 },
        select: { city: true, city_en: true, price: true },
        orderBy: { city: 'asc' },
      });
      const deliverySettings = await getDeliverySettings();
      response.json({
        cities,
        otherPrice: deliverySettings.otherPrice,
        freeFrom: deliverySettings.freeFrom,
        pickup: deliverySettings.pickup,
        pickupAddress: deliverySettings.pickupAddress,
        payOnline: Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY),
      });
    }),
  );

  router.post(
    '/promo',
    shopAuth,
    promoPostValidator,
    asyncHandler(async (request, response) => {
      if (!isPromoAttemptAllowed(request.chatId))
        return response.status(429).json({ error: 'Слишком много попыток, подождите минуту' }); // защита от подбора кодов
      try {
        return response.json({ ok: true, ...(await pricing.findPromo(request.validated.promoCode)) });
      } catch (promoError) {
        return response.status(400).json({ error: promoError.message });
      }
    }),
  );

  const chatsPlacingOrder = new Set(); // защита от двойного нажатия «Оплатить»
  router.post(
    '/order',
    shopAuth,
    orderPostValidator,
    asyncHandler(async (request, response) => {
      const chatId = request.chatId;
      if (chatsPlacingOrder.has(chatId)) return response.status(429).json({ error: 'Секунду, оформляем…' });
      chatsPlacingOrder.add(chatId);
      let orderId = null;
      try {
        const language = await customers.getLanguage(chatId);
        const { deliveryForm, promoCode, phone } = request.validated;
        const { items, total } = await cart.getCart(chatId);
        if (!items.length) return response.status(400).json({ error: 'Корзина пуста' });
        const unavailableItem = items.find((cartItem) => cartItem.stock < cartItem.quantity);
        if (unavailableItem) {
          return response.status(400).json({
            error: translate(
              language,
              'insufficientStock',
              (language === 'en' && unavailableItem.name_en) || unavailableItem.name,
              unavailableItem.stock,
            ),
          });
        }
        let promo;
        try {
          promo = await pricing.findPromo(promoCode);
        } catch (promoError) {
          isPromoAttemptAllowed(chatId); // неверный промокод тоже считается попыткой подбора
          return response.status(400).json({ error: promoError.message });
        }
        // доставка, «бесплатно от», скидка
        const resolvedDelivery = await pricing.resolveDelivery(deliveryForm, total, promo.percent, language);
        orderId = await orders.createPendingOrder({
          chatId,
          address: phone ? `${resolvedDelivery.address} · тел. ${phone}` : resolvedDelivery.address,
          total: resolvedDelivery.total,
          items,
          promoCode: promo.code,
          discountPercent: promo.percent,
          deliveryCity: resolvedDelivery.deliveryCity,
          deliveryCost: resolvedDelivery.delivery,
          consentAt: toSqliteTimestamp(), // согласие отмечено в форме (проверено в validation.js)
        });
        const createdOrder = await database.order.findUnique({ where: { id: orderId }, select: { order_code: true } });
        const orderCode = createdOrder.order_code || String(orderId);
        const payment = await startPayment(orderId);
        await cart.clearCart(chatId); // корзина превратилась в заказ
        const paymentUrl = payment.confirmation.confirmation_url;
        // ссылка на оплату — ещё и в чат, чтобы не потерялась
        bot.telegram
          .sendMessage(chatId, translate(language, 'payLinkText', orderCode), {
            reply_markup: { inline_keyboard: [[{ text: translate(language, 'payUrlButton'), url: paymentUrl }]] },
          })
          .catch(() => {});
        return response.json({
          ok: true,
          id: orderId,
          code: orderCode,
          total: resolvedDelivery.total,
          pay_url: paymentUrl,
        });
      } catch (orderError) {
        if (orderId) await orders.cancelIfNotPaid(orderId); // оплата не создалась — заказ не висит
        if (orderError.expose) return response.status(400).json({ error: orderError.message });
        console.error('Витрина: не удалось оформить заказ', orderError.response?.data || orderError.message);
        return response.status(502).json({ error: 'Не получилось создать оплату. Попробуйте ещё раз через минуту' });
      } finally {
        chatsPlacingOrder.delete(chatId);
      }
    }),
  );

  return router;
}

module.exports = { createCheckoutRouter };
