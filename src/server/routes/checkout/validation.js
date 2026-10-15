// Проверка запросов оформления: способ доставки, адрес, промокод, телефон
const { ValidationError, createValidator, cleanText } = require('../../validation');

const MIN_PHONE_DIGITS = 10;

// Поля доставки из формы витрины — так их ждёт pricing.resolveDelivery
const readDeliveryForm = (requestBody) => ({
  method: requestBody.delivery,
  city: requestBody.city,
  address: requestBody.address,
});

const promoPostValidator = createValidator((request) => ({ promoCode: request.body.code }));

// Заказ: телефон необязателен, но если указан — не меньше 10 цифр
const orderPostValidator = createValidator((request) => {
  const requestBody = request.body || {};
  const phone = cleanText(requestBody.phone, 30);
  if (phone && phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS)
    throw new ValidationError('Проверьте номер телефона');
  return { deliveryForm: readDeliveryForm(requestBody), promoCode: requestBody.promo, phone };
});

module.exports = { promoPostValidator, orderPostValidator };
