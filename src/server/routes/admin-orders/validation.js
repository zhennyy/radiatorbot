// Проверка запросов админки заказов
const orders = require('../../../orders');
const { ValidationError, createValidator, parsePositiveId } = require('../../validation');

// Новый статус: только «в работе» или «отменён»; трек-номер — по желанию
const orderStatusValidator = createValidator((request) => {
  const newStatus = String(request.body.status || '');
  if (!orders.PAID_STATUSES.has(newStatus) && newStatus !== 'cancelled') throw new ValidationError('Неизвестный статус');
  return {
    orderId: parsePositiveId(request.params.id),
    newStatus,
    statusOptions: request.body.track !== undefined ? { track: request.body.track } : {},
  };
});

module.exports = { orderStatusValidator };
