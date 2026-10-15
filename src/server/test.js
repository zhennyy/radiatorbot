// Сервер целиком: подпись Telegram, старая админка закрыта, защита от ссылок во внутреннюю сеть
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('./test-helpers');

let shop;
before(async () => {
  shop = await testHelpers.start();
});

test('SSRF: ссылки во внутреннюю сеть отклоняются', async () => {
  const { assertPublicUrl } = require('./index');
  const internalUrls = [
    'https://127.0.0.1/a.jpg',
    'https://localhost/a.jpg',
    'https://169.254.169.254/latest',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://[::1]/x',
    'https://172.16.0.1/x',
  ];
  for (const internalUrl of internalUrls)
    await assert.rejects(() => assertPublicUrl(internalUrl), undefined, internalUrl);
});

test('поддельная подпись Telegram отклоняется', async () => {
  const forgedInitData = testHelpers.initData(8003).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  const response = await fetch(shop.base + '/shop-api/orders', { headers: { 'X-Init-Data': forgedInitData } });
  assert.equal(response.status, 401);
});

test('без подписи витрина недоступна, старая веб-админка закрыта', async () => {
  assert.equal((await shop.call(null, 'GET', '/shop-api/catalog')).status, 401);
  assert.equal((await shop.call(null, 'GET', '/admin')).status, 404);
});

test('маршрутов кофейни (подписки, СДЭК, склад из Excel, отчёты, повтор заказа) здесь нет', async () => {
  const ownerCalls = [
    ['GET', '/shop-api/subscriptions'],
    ['POST', '/shop-api/delivery-quote'],
    ['POST', '/shop-api/orders/1/repeat'],
    ['POST', '/shop-api/admin/stock-import'],
    ['POST', '/shop-api/admin/stock-delta'],
    ['POST', '/shop-api/admin/report'],
    ['POST', '/shop-api/admin/delivery2'],
  ];
  for (const [method, urlPath] of ownerCalls)
    assert.equal(
      (await shop.call(testHelpers.OWNER_ID, method, urlPath, method === 'POST' ? {} : undefined)).status,
      404,
      urlPath,
    );
});

test('ошибка внутри маршрута — короткий JSON без стека', async () => {
  const response = await fetch(shop.base + '/shop-api/cart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': testHelpers.initData(8004) },
    body: '{"product_id":',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.doesNotMatch(body.error, /at .*\.js/);
});
