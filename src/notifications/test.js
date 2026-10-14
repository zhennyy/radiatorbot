// Предупреждение о заканчивающемся товаре: пишем владелице один раз, пока список не изменится
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const testHelpers = require('../server/test-helpers');

let shop;
before(async () => { shop = await testHelpers.start(); });

test('заканчивающийся товар: одно сообщение владелице, повтор — только при изменении', async () => {
  const { checkLowStock } = require('./index');
  const product = await shop.database.product.findFirst({ orderBy: { id: 'asc' } });
  await shop.database.product.update({ where: { id: product.id }, data: { stock: 2 } });
  shop.sent.length = 0;
  await checkLowStock(shop.bot);
  const warnings = () => shop.sent.filter((message) => String(message.chat) === process.env.OWNER_CHAT_ID && /Заканчивается/.test(message.text));
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0].text, new RegExp(`${product.name} — осталось 2 шт\\.`));
  await checkLowStock(shop.bot);
  assert.equal(warnings().length, 1, 'тот же список — без повтора');
  await shop.database.product.update({ where: { id: product.id }, data: { stock: 0 } });
  await checkLowStock(shop.bot);
  assert.equal(warnings().length, 2);
  assert.match(warnings()[1].text, /закончился/);
});
