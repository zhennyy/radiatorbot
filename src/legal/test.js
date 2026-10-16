// Адреса юридических страниц (152-ФЗ): от SHOP_URL или PUBLIC_URL, без адреса магазина — null
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { legalPageUrl } = require('./index');

const savedEnvironment = { SHOP_URL: process.env.SHOP_URL, PUBLIC_URL: process.env.PUBLIC_URL };
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('адрес страницы строится от SHOP_URL (с параметрами и без слеша в конце)', () => {
  process.env.SHOP_URL = 'https://radiator.botforall.ru/shop/?tab=catalog';
  assert.equal(legalPageUrl('consent'), 'https://radiator.botforall.ru/shop/legal/consent.html');
  process.env.SHOP_URL = 'https://radiator.botforall.ru/shop';
  assert.equal(legalPageUrl('offer'), 'https://radiator.botforall.ru/shop/legal/offer.html');
});

test('без SHOP_URL — от PUBLIC_URL, без обоих — null; неизвестная страница — ошибка', () => {
  delete process.env.SHOP_URL;
  process.env.PUBLIC_URL = 'https://radiator.botforall.ru/';
  assert.equal(legalPageUrl('privacy'), 'https://radiator.botforall.ru/shop/legal/privacy.html');
  delete process.env.PUBLIC_URL;
  assert.equal(legalPageUrl('privacy'), null);
  assert.throws(() => legalPageUrl('terms'), /Неизвестная/);
});
