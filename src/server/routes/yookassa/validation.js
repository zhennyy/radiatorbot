// Проверка уведомления ЮKassa: нас интересует только успешная оплата с корректным id платежа.
// Остальные события спокойно подтверждаем (200), чтобы ЮKassa не слала их повторно.
const PAYMENT_ID_PATTERN = /^[\w-]{1,64}$/;

function paymentSucceededValidator(request, response, next) {
  const event = request.body;
  const isPaymentSucceeded = event && event.event === 'payment.succeeded' && event.object && PAYMENT_ID_PATTERN.test(String(event.object.id));
  if (!isPaymentSucceeded) return response.sendStatus(200);
  request.validated = { paymentId: String(event.object.id) };
  return next();
}

module.exports = { paymentSucceededValidator };
