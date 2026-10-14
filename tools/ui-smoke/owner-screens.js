// Экраны владелицы: заказы и смена статуса, статистика, товары и редактор, чаты, настройки.
const { OWNER_ID } = require('./test-data');
const { closeSheetByVeil, tabButton, adminSection } = require('./browser');

async function runOwnerScreens(runner, shop) {
  const { openPage, snap, check } = runner;
  const page = await openPage(OWNER_ID, { name: 'owner' });
  await snap(page, 'o01-catalog-owner');
  await tabButton(page, 'Админка').click();
  await page.waitForSelector('#admBody .order');
  await snap(page, 'o02-admin-orders');
  await page.locator('#admBody .chip', { hasText: 'Все' }).click();
  await snap(page, 'o03-admin-orders-all');
  await page.locator('#admBody .chip', { hasText: 'В работе' }).click();

  // сценарий: смена статуса заказа (курьер: «Отправить» → трек-номер)
  const courierOrder = page.locator('#admBody .order', { hasText: 'Невский' });
  await courierOrder.locator('.btn', { hasText: 'Отправить' }).click();
  await snap(page, 'o04-track-sheet');
  await page.fill('#trackIn', 'RA123456789RU');
  await page.click('#trackGo');
  await snap(page, 'o05-order-shipped', { keepToast: true });
  const shipped = await shop.database.order.findFirst({ where: { address: { contains: 'Невский' } } });
  check('статус заказа сменился на «отправлен» с трек-номером', shipped.status === 'shipped' && shipped.track === 'RA123456789RU', `${shipped.status} ${shipped.track}`);
  await page.locator('#admBody .order', { hasText: 'Самовывоз' }).first().locator('.btn', { hasText: 'Начать сборку' }).click();
  await snap(page, 'o06-order-assembling');

  await adminSection(page, 'Статистика').click();
  await page.waitForSelector('#admBody .kpis');
  await snap(page, 'o07-stats');
  await page.locator('#admBody .seg button', { hasText: '7 дней' }).click();
  await snap(page, 'o08-stats-7-days');
  await page.locator('#admBody .bars .bar').last().click();
  await snap(page, 'o09-stats-bar-tip', { keepToast: true });

  await adminSection(page, 'Товары').click();
  await page.waitForSelector('#admBody .aline');
  await snap(page, 'o10-products');
  await page.locator('#admBody .aline', { hasText: 'Nova Grande' }).click();
  await snap(page, 'o11-editor-without-photo');
  await closeSheetByVeil(page);
  await page.locator('#admBody .btn', { hasText: 'Новый товар' }).click();
  await snap(page, 'o12-editor-new');
  await closeSheetByVeil(page);
  await page.locator('#admBody .aline', { hasText: 'Milano' }).click();
  await snap(page, 'o13-editor-with-photo');
  await closeSheetByVeil(page);

  // сценарий: правка товара
  await page.locator('#admBody .aline', { hasText: 'Elegance' }).click();
  await page.fill('#pform input[name="name"]', 'Полотенцесушитель Elegance Plus');
  await page.fill('#pform input[name="stock"]', '42');
  await page.locator('#pform .btn', { hasText: 'Сохранить' }).click();
  await snap(page, 'o14-products-after-edit', { keepToast: true });
  const edited = await shop.database.product.findUnique({ where: { id: 3 } });
  check('товар изменён', edited.name === 'Полотенцесушитель Elegance Plus' && edited.stock === 42, `${edited.name} ${edited.stock}`);

  await adminSection(page, 'Чаты').click();
  await page.waitForSelector('#admBody .aline');
  await snap(page, 'o15-chats');
  await page.locator('#admBody .aline').first().click();
  await page.waitForSelector('#msgs');
  await snap(page, 'o16-chat');
  await page.fill('#reply', 'Подойдёт, могу отложить для вас 🙂');
  await page.click('#sendReply');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.me').length === 2);
  check('ответ покупателю отправлен', shop.sent.some((message) => /отложить для вас/.test(message.text)));
  await page.locator('#admBody .mini', { hasText: 'Чаты' }).click();
  await page.waitForSelector('#admBody .aline');

  await adminSection(page, 'Настройки').click();
  await page.waitForSelector('#admBody .box');
  await snap(page, 'o17-settings');
  await page.fill('#pcode', 'WINTER15');
  await page.fill('#ppct', '15');
  await page.locator('#admBody .btn', { hasText: 'Создать промокод' }).click();
  await snap(page, 'o18-settings-promo-added', { keepToast: true });
  await page.context().close();
}

module.exports = { runOwnerScreens };
