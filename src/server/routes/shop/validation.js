// Проверка запросов витрины
const { ValidationError, createValidator, parsePositiveId, cleanText } = require('../../validation');

const MAX_AI_QUERY_LENGTH = 500;

const cartPostValidator = createValidator((request) => {
  const productId = parsePositiveId(request.body.product_id);
  if (!productId) throw new ValidationError('Товар не найден', 404);
  return { productId, quantity: Math.max(0, parseInt(request.body.qty, 10) || 0) };
});

const languagePostValidator = createValidator((request) => ({ language: request.body.lang === 'en' ? 'en' : 'ru' }));

const aiPostValidator = createValidator((request) => {
  const query = cleanText(request.body.query, MAX_AI_QUERY_LENGTH);
  if (!query) throw new ValidationError('Опишите, что нужно подобрать');
  return { query };
});

module.exports = { cartPostValidator, languagePostValidator, aiPostValidator };
