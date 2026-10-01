// pricing.js — единые правила цены для витрины и для оформления в чате:
// доставка по городу, «другие города», бесплатно от суммы, промокоды.
// Сравниваем названия в JS: SQLite COLLATE NOCASE не понимает русские буквы («москва» ≠ «Москва»).
const db = require('./db');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

// Тариф города из списка (или null, если такого города нет / он выключен)
function findCity(city) {
  const n = norm(city);
  if (!n) return null;
  return db.prepare('SELECT city, city_en, price FROM delivery_rates WHERE active = 1').all()
    .find((r) => norm(r.city) === n || (r.city_en && norm(r.city_en) === n)) || null;
}
const deliveryPrice = (city) => {
  const r = findCity(city);
  return r ? r.price : db.getDeliverySettings().otherPrice;
};

// Промокод: возвращает { code, percent } или бросает понятную ошибку
function findPromo(code) {
  const n = norm(code).toUpperCase().replace(/\s+/g, '');
  if (!n) return { code: null, percent: 0 };
  const p = db.prepare('SELECT * FROM promo_codes WHERE active = 1').all()
    .find((x) => norm(x.code).toUpperCase().replace(/\s+/g, '') === n);
  if (!p) { const e = new Error('Такого промокода нет'); e.kind = 'notFound'; throw e; }
  if (p.max_uses !== null && p.used_count >= p.max_uses) { const e = new Error('Промокод уже закончился'); e.kind = 'exhausted'; throw e; }
  return { code: p.code, percent: p.discount_percent };
}

// Итог: товары со скидкой + доставка (с учётом «бесплатно от»)
function quote(goodsTotal, percent, city /* null = самовывоз */) {
  const goods = percent > 0 ? Math.round((goodsTotal * (100 - percent)) / 100) : goodsTotal;
  const ds = db.getDeliverySettings();
  let delivery = city == null ? 0 : deliveryPrice(city);
  if (city != null && ds.freeFrom > 0 && goods >= ds.freeFrom) delivery = 0;
  return { goods, delivery, total: goods + delivery };
}

module.exports = { norm, findCity, deliveryPrice, findPromo, quote };
