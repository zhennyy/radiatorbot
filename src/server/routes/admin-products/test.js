// Админка товаров: добавить, изменить, удалить, фото, резервная копия; доступ только владелице
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../../test-helpers');

const OWNER_ID = testHelpers.OWNER_ID;
const BUYER_ID = 6001;
const PRODUCT_FIELDS = ['category', 'category_en', 'description', 'description_en', 'has_photo', 'id', 'name', 'name_en', 'photo', 'price', 'stock'];
let shop;
let actions;

before(async () => {
  shop = await testHelpers.start();
  actions = testHelpers.createShopActions(shop);
});

test('добавить товар: цена в рублях → копейки, английские поля, проверка формы', async () => {
  const productId = await actions.createProduct({ name: '  Радиатор Termo  ', price: '12 345,5', stock: 4, category: 'Стальные', name_en: 'Termo Radiator' });
  assert.equal(typeof productId, 'number');
  const product = await actions.findProduct(productId);
  assert.equal(product.name, 'Радиатор Termo');
  assert.equal(product.price, 1234550);
  assert.equal(product.stock, 4);
  assert.equal(product.name_en, 'Termo Radiator');
  assert.equal(product.description_en, null);
  assert.match((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { price: 100 })).body.error, /Укажите название/);
  assert.match((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products', { name: 'Без цены', price: 'abc' })).body.error, /Укажите цену/);
});

test('список товаров для админки: поля без ссылки на фото, по категориям', async () => {
  const response = await shop.call(OWNER_ID, 'GET', '/shop-api/admin/products');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body.products[0]).sort(), PRODUCT_FIELDS);
  const categories = response.body.products.map((product) => product.category ?? '');
  assert.deepEqual(categories, [...categories].sort());
});

test('изменить товар: все поля и остаток; несуществующий — 404; пополнение — проверка склада', async () => {
  const productId = await actions.createProduct({ name: 'Полотенцесушитель Wave', price: 5000, stock: 1 });
  shop.sent.length = 0;
  const edited = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${productId}`, { name: 'Полотенцесушитель Wave 2', price: 5500, stock: 2, description: 'Хром' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const product = await actions.findProduct(productId);
  assert.deepEqual([product.name, product.price, product.stock, product.description], ['Полотенцесушитель Wave 2', 550000, 2, 'Хром']);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(shop.sent.some((message) => /Заканчивается на складе/.test(message.text) && /Wave 2 — осталось 2 шт\./.test(message.text)));
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products/999999', { name: 'X', price: 1 })).status, 404);
});

test('удалить товар: пропадает из каталога и корзин, старые заказы остаются', async () => {
  const productId = await actions.createProduct({ name: 'На удаление', price: 100, stock: 10 });
  const orderResponse = await actions.buy(BUYER_ID, [[productId, 1]]);
  await actions.setCart(BUYER_ID + 1, [[productId, 1]]);
  assert.deepEqual((await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${productId}/delete`, {})).body, { ok: true });
  assert.equal(await actions.findProduct(productId), null);
  assert.equal(await shop.database.cartItem.count({ where: { product_id: productId } }), 0);
  assert.equal(await shop.database.orderItem.count({ where: { order_id: orderResponse.body.id } }), 1);
  const myOrder = (await shop.call(BUYER_ID, 'GET', '/shop-api/orders')).body.orders.find((order) => order.id === orderResponse.body.id);
  assert.deepEqual(myOrder.items[0], { id: null, qty: 1, price: 10000, name: '—' });
});

test('фото: с телефона (raw) и по ссылке — только https', async () => {
  const [product] = await actions.productsInStock();
  const uploadPhoto = (productId, bytes) => fetch(`${shop.base}/shop-api/admin/products/${productId}/photo`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Init-Data': testHelpers.initData(OWNER_ID) }, body: bytes,
  });
  assert.equal((await uploadPhoto(999999, Buffer.alloc(500))).status, 404);
  assert.equal((await uploadPhoto(product.id, Buffer.alloc(10))).status, 400);
  assert.equal((await uploadPhoto(product.id, Buffer.alloc(500, 1))).status, 200);
  assert.match((await actions.findProduct(product.id)).photo_url, /^http:\/\/127\.0\.0\.1:\d+\/uploads\/\d+-\d+\.jpg$/);
  const catalogProduct = (await shop.call(BUYER_ID, 'GET', '/shop-api/catalog')).body.products.find((listed) => listed.id === product.id);
  const photoResponse = await fetch(shop.base + catalogProduct.photo);
  assert.equal(photoResponse.status, 200);
  assert.equal((await photoResponse.arrayBuffer()).byteLength, 500);
  assert.equal((await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${product.id}/photo-url`, { url: 'http://example.com/a.jpg' })).status, 400);
  assert.equal((await shop.call(OWNER_ID, 'POST', '/shop-api/admin/products/999999/photo-url', { url: 'https://example.com/a.jpg' })).status, 404);
  const byLink = await shop.call(OWNER_ID, 'POST', `/shop-api/admin/products/${product.id}/photo-url`, { url: 'https://example.com/a.jpg' });
  assert.deepEqual(byLink.body, { ok: true, local: false }); // без PUBLIC_URL фото не скачивается к себе
});

test('резервная копия уходит владелице ZIP-файлом', async () => {
  let sentDocument = null;
  shop.bot.telegram.sendDocument = async (chatId, document) => { sentDocument = { chatId, document }; return {}; };
  const response = await shop.call(OWNER_ID, 'POST', '/shop-api/admin/backup', {});
  assert.equal(response.status, 200);
  assert.equal(sentDocument.chatId, OWNER_ID);
  assert.match(sentDocument.document.filename, /^radiatorpro-backup-\d{4}-\d\d-\d\d_\d\d-\d\d\.zip$/);
  assert.equal(sentDocument.document.source.readUInt32LE(0), 0x04034b50, 'это ZIP');
  assert.ok(sentDocument.document.source.includes(Buffer.from('Резервная копия RadiatorPro')));
});

test('покупателю админка товаров недоступна, без подписи — 401', async () => {
  assert.equal((await shop.call(BUYER_ID, 'GET', '/shop-api/admin/products')).status, 403);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/products', { name: 'Взлом', price: 1 })).status, 403);
  assert.equal((await shop.call(BUYER_ID, 'POST', '/shop-api/admin/backup', {})).status, 403);
  assert.equal((await shop.call(null, 'GET', '/shop-api/admin/products')).status, 401);
});
