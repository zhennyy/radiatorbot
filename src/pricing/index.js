// Единые правила цены для витрины и для оформления в чате:
// доставка по городу, «другие города», бесплатно от суммы, промокоды.
// Названия сравниваем в JS: SQLite COLLATE NOCASE не понимает русские буквы («москва» ≠ «Москва»).
const { database } = require('../database');
const { getDeliverySettings } = require('../settings');
const { translate } = require('../i18n');

const MAX_CITY_LENGTH = 80;
const MAX_ADDRESS_LENGTH = 300;
const MIN_ADDRESS_LENGTH = 5;

const normalizeName = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
const normalizePromoCode = (code) => normalizeName(code).toUpperCase().replace(/\s+/g, '');

// Ошибка с текстом для покупателя (400), а не внутренняя
const userError = (message) => Object.assign(new Error(message), { expose: true, statusCode: 400 });

// Тариф города из списка (или null, если такого города нет / он выключен)
async function findCity(cityName) {
  const normalizedCity = normalizeName(cityName);
  if (!normalizedCity) return null;
  const activeRates = await database.deliveryRate.findMany({
    where: { active: 1 },
    select: { city: true, city_en: true, price: true },
  });
  return (
    activeRates.find(
      (rate) =>
        normalizeName(rate.city) === normalizedCity || (rate.city_en && normalizeName(rate.city_en) === normalizedCity),
    ) || null
  );
}

async function getDeliveryPrice(cityName) {
  const cityRate = await findCity(cityName);
  return cityRate ? cityRate.price : (await getDeliverySettings()).otherPrice;
}

const promoError = (message, kind) => Object.assign(new Error(message), { kind });

// Промокод: возвращает { code, percent } или бросает понятную ошибку
async function findPromo(code) {
  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) return { code: null, percent: 0 };
  const activePromoCodes = await database.promoCode.findMany({ where: { active: 1 } });
  const promoCode = activePromoCodes.find((candidate) => normalizePromoCode(candidate.code) === normalizedCode);
  if (!promoCode) throw promoError('Такого промокода нет', 'notFound');
  if (promoCode.max_uses !== null && promoCode.used_count >= promoCode.max_uses)
    throw promoError('Промокод уже закончился', 'exhausted');
  return { code: promoCode.code, percent: promoCode.discount_percent };
}

// Итог: товары со скидкой + доставка (с учётом «бесплатно от»). deliveryCity = null — самовывоз
async function quote(goodsTotal, discountPercent, deliveryCity) {
  const goods = discountPercent > 0 ? Math.round((goodsTotal * (100 - discountPercent)) / 100) : goodsTotal;
  const deliverySettings = await getDeliverySettings();
  let delivery = deliveryCity == null ? 0 : await getDeliveryPrice(deliveryCity);
  if (deliveryCity != null && deliverySettings.freeFrom > 0 && goods >= deliverySettings.freeFrom) delivery = 0;
  return { goods, delivery, total: goods + delivery };
}

// Доставка из формы витрины: самовывоз или город + адрес.
// Возвращает { deliveryCity, address, delivery, goods, total }; неверные данные — ошибка для покупателя.
async function resolveDelivery({ method, city, address }, goodsTotal, discountPercent, language = 'ru') {
  let deliveryCity = null;
  let fullAddress;
  if (method === 'pickup') {
    if (!(await getDeliverySettings()).pickup) throw userError('Самовывоза сейчас нет — выберите доставку');
    fullAddress = translate(language, 'pickupSet');
  } else {
    const cityName = String(city || '')
      .trim()
      .slice(0, MAX_CITY_LENGTH);
    const streetAddress = String(address || '')
      .trim()
      .slice(0, MAX_ADDRESS_LENGTH);
    if (!cityName) throw userError('Выберите город');
    if (streetAddress.length < MIN_ADDRESS_LENGTH) throw userError('Укажите адрес: улица, дом, квартира');
    const knownCity = await findCity(cityName);
    deliveryCity = knownCity ? knownCity.city : cityName;
    fullAddress = `${deliveryCity}, ${streetAddress}`;
  }
  const priceQuote = await quote(goodsTotal, discountPercent, deliveryCity);
  return {
    deliveryCity,
    address: fullAddress,
    delivery: priceQuote.delivery,
    goods: priceQuote.goods,
    total: priceQuote.total,
  };
}

// Английское название города для истории заказов (orders.delivery_city хранит русский текст на момент заказа)
async function translateCity(cityName, language) {
  if (!cityName || language !== 'en') return cityName;
  const cityRate = await database.deliveryRate.findFirst({ where: { city: cityName }, select: { city_en: true } });
  return (cityRate && cityRate.city_en) || cityName;
}

module.exports = {
  normalizeName,
  findCity,
  getDeliveryPrice,
  findPromo,
  quote,
  resolveDelivery,
  translateCity,
  userError,
};
