// Проверка запросов админки: статистика, сообщение покупателю, доставка, города, промокоды
const { ValidationError, createValidator, parsePositiveId, toKopecks, cleanText } = require('../../validation');

const STATS_PERIODS = [7, 30, 90];
const MAX_MESSAGE_LENGTH = 4000;
const PROMO_CODE_PATTERN = /^[A-ZА-ЯЁ0-9_-]{2,30}$/;
const MAX_DISCOUNT_PERCENT = 90;

const statsValidator = createValidator((request) => ({
  days: STATS_PERIODS.includes(Number(request.query.days)) ? Number(request.query.days) : 30,
}));

const chatIdValidator = createValidator((request) => ({ chatId: Number(request.params.chatId) }));

const chatMessageValidator = createValidator((request) => {
  const text = cleanText(request.body?.text, MAX_MESSAGE_LENGTH);
  if (!text) throw new ValidationError('Пустое сообщение');
  return { chatId: Number(request.params.chatId), text };
});

const deliverySettingsValidator = createValidator((request) => {
  const form = request.body || {};
  const otherPrice = toKopecks(form.otherPrice);
  const freeFrom = form.freeFrom === '' || form.freeFrom == null ? 0 : toKopecks(form.freeFrom);
  if (!(otherPrice >= 0)) throw new ValidationError('Цена для других городов — числом');
  if (!(freeFrom >= 0)) throw new ValidationError('«Бесплатно от» — числом (0 — выключено)');
  return { deliverySettings: { otherPrice, freeFrom, pickup: Boolean(form.pickup), pickupAddress: cleanText(form.pickupAddress, 200) } };
});

const cityValidator = createValidator((request) => {
  const form = request.body || {};
  const city = cleanText(form.city, 80);
  const price = toKopecks(form.price);
  if (city.length < 2) throw new ValidationError('Укажите город');
  if (!(price >= 0)) throw new ValidationError('Укажите цену доставки');
  return { rateId: parsePositiveId(form.id), city, price, isActive: form.active !== false };
});

const promoCodeValidator = createValidator((request) => {
  const form = request.body || {};
  const code = String(form.code || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
  const discountPercent = parseInt(form.percent, 10);
  const maxUses = form.max_uses === '' || form.max_uses == null ? null : parseInt(form.max_uses, 10);
  if (!PROMO_CODE_PATTERN.test(code)) throw new ValidationError('Код — буквы и цифры, от 2 символов');
  if (!(discountPercent >= 1 && discountPercent <= MAX_DISCOUNT_PERCENT)) throw new ValidationError(`Скидка — от 1 до ${MAX_DISCOUNT_PERCENT}%`);
  if (maxUses !== null && !(maxUses >= 1)) throw new ValidationError('Лимит — число от 1 (или пусто — без лимита)');
  return { code, discountPercent, maxUses };
});

const promoToggleValidator = createValidator((request) => ({ promoId: parsePositiveId(request.params.id), isActive: Boolean(request.body?.active) }));

module.exports = {
  statsValidator, chatIdValidator, chatMessageValidator, deliverySettingsValidator, cityValidator, promoCodeValidator, promoToggleValidator,
};
