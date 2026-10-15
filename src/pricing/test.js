// Цены: доставка по городу и «другие города», бесплатно от суммы, промокоды
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

let shop;
let pricing;
before(async () => {
  shop = await testHelpers.start();
  pricing = require('./index');
});

test('город из списка находится по-русски и по-английски, без учёта регистра и «ё»', async () => {
  assert.equal((await pricing.findCity('  санкт-петербург ')).price, 40000);
  assert.equal((await pricing.findCity('Moscow')).city, 'Москва');
  await shop.database.deliveryRate.create({ data: { city: 'Королёв', price: 50000 } });
  assert.equal((await pricing.findCity('королев')).city, 'Королёв');
  assert.equal(await pricing.findCity('Тверь'), null);
  assert.equal(await pricing.getDeliveryPrice('Тверь'), 150000);
});

test('итог: скидка только на товары, самовывоз бесплатно, «бесплатно от» считается по сумме со скидкой', async () => {
  assert.deepEqual(await pricing.quote(100000, 0, null), { goods: 100000, delivery: 0, total: 100000 });
  assert.deepEqual(await pricing.quote(100000, 10, 'Москва'), { goods: 90000, delivery: 70000, total: 160000 });
  const { setSetting } = require('../settings');
  await setSetting('delivery', { freeFrom: 95000 });
  assert.equal((await pricing.quote(100000, 10, 'Москва')).delivery, 70000, '90 000 < 95 000');
  assert.equal((await pricing.quote(100000, 0, 'Москва')).delivery, 0);
  await setSetting('delivery', {});
});

test('промокоды: пробелы и регистр не важны, выключенный и исчерпанный — понятная ошибка', async () => {
  await shop.database.promoCode.createMany({
    data: [
      { code: 'ОТОПЛЕНИЕ', discount_percent: 15 },
      { code: 'OLD', discount_percent: 5, active: 0 },
      { code: 'LIMIT', discount_percent: 5, max_uses: 2, used_count: 2 },
    ],
  });
  assert.deepEqual(await pricing.findPromo(' отопление '), { code: 'ОТОПЛЕНИЕ', percent: 15 });
  assert.deepEqual(await pricing.findPromo(''), { code: null, percent: 0 });
  await assert.rejects(
    () => pricing.findPromo('old'),
    (promoError) => promoError.kind === 'notFound',
  );
  await assert.rejects(
    () => pricing.findPromo('limit'),
    (promoError) => promoError.kind === 'exhausted' && /закончился/.test(promoError.message),
  );
});

test('английское название города для истории заказов', async () => {
  assert.equal(await pricing.translateCity('Москва', 'en'), 'Moscow');
  assert.equal(await pricing.translateCity('Москва', 'ru'), 'Москва');
  assert.equal(await pricing.translateCity('Тверь', 'en'), 'Тверь');
});
