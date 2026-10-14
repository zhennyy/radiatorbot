// Экраны покупателя: каталог, карточки, корзина, оформление (доставка, другой город, самовывоз, промокод), заказы, AI, язык, тёмная тема.
const { normalizeOrders, BUYER_ID } = require('./test-data');
const { pressMainButton, closeSheetByVeil, tabButton } = require('./browser');

async function runBuyerScreens(runner, shop) {
  const { openPage, snap, check } = runner;
  const page = await openPage(BUYER_ID, { name: 'buyer' });
  await snap(page, 'b01-catalog');

  await page.locator('#chips .chip', { hasText: 'Дизайнерские' }).click();
  await snap(page, 'b02-catalog-category');
  await page.locator('#chips .chip', { hasText: 'Все' }).click();
  await page.fill('#q', 'хром');
  await snap(page, 'b03-search');
  await page.fill('#q', 'нет такого');
  await snap(page, 'b04-search-empty');
  await page.fill('#q', '');
  await page.dispatchEvent('#q', 'input');

  await page.locator('#grid .card', { hasText: 'Milano' }).click();
  await snap(page, 'b05-sheet');
  await page.locator('#sheet .act .add').click();
  await snap(page, 'b06-sheet-added');
  await page.locator('#sheet .act .step button', { hasText: '+' }).click();
  await page.locator('#sheet .x').click();
  await page.locator('#grid .card', { hasText: 'Retro Cast' }).click();
  await snap(page, 'b07-sheet-out-of-stock');
  await closeSheetByVeil(page);
  await page.locator('#grid .card', { hasText: 'Elegance' }).locator('.add').click();
  await snap(page, 'b08-catalog-with-cart');

  await tabButton(page, 'Корзина').click();
  await snap(page, 'b09-cart');
  await page.locator('#v-cart .line', { hasText: 'Elegance' }).locator('.step button', { hasText: '+' }).click();
  await snap(page, 'b10-cart-plus');

  await pressMainButton(page);
  await snap(page, 'b11-checkout-delivery');
  await page.selectOption('#coCity', '__other');
  await snap(page, 'b12-checkout-other-city');
  await page.locator('#v-checkout .seg button', { hasText: 'Самовывоз' }).click();
  await snap(page, 'b13-checkout-pickup');
  await page.locator('#v-checkout .seg button', { hasText: 'Доставка' }).click();
  await page.selectOption('#coCity', 'Санкт-Петербург');
  await pressMainButton(page);
  await snap(page, 'b14-checkout-address-error', { keepToast: true });
  await page.fill('#coPromo', 'HEAT10');
  await page.locator('#v-checkout .btn', { hasText: 'Применить' }).click();
  await snap(page, 'b15-checkout-promo');

  // сценарий: самовывоз → оплата → заказ виден в «Мои заказы»
  await page.locator('#v-checkout .seg button', { hasText: 'Самовывоз' }).click();
  await page.fill('#coPhone', '+7 900 123-45-67');
  await pressMainButton(page);
  await page.waitForSelector('#v-orders.on .order');
  await runner.settle(page);
  const links = await page.evaluate(() => window.__telegramLog.links);
  check('после оформления открыта ссылка на оплату', links.length === 1 && links[0].startsWith('https://pay.test/'), JSON.stringify(links));
  await normalizeOrders(shop);
  await tabButton(page, 'Каталог').click();
  await tabButton(page, 'Заказы').click();
  await page.waitForSelector('#v-orders .order');
  await snap(page, 'b16-orders-after-checkout');
  const ordersText = await page.locator('#v-orders').innerText();
  check('новый заказ виден в «Мои заказы»', /RP-105/.test(ordersText) && /Ждёт оплат/i.test(ordersText), ordersText.slice(0, 200));
  check('корзина пуста после заказа', (await page.locator('#cartCount').innerText()) === '');
  const newOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  check('заказ создан со скидкой по промокоду и самовывозом', newOrder.promo_code === 'HEAT10' && !newOrder.delivery_city, JSON.stringify({ promo: newOrder.promo_code, city: newOrder.delivery_city }));

  await tabButton(page, 'Корзина').click();
  await snap(page, 'b17-cart-empty');

  await tabButton(page, 'AI-подбор').click();
  await snap(page, 'b18-ai');
  await page.locator('#aiHints .chip').first().click();
  await page.waitForSelector('#aiGrid .card');
  await snap(page, 'b19-ai-result');

  await page.locator('#lang button', { hasText: 'EN' }).click();
  await tabButton(page, 'Catalog').click();
  await snap(page, 'b20-catalog-en');
  await tabButton(page, 'Orders').click();
  await snap(page, 'b21-orders-en');
  await page.locator('#lang button', { hasText: 'RU' }).click();
  await page.context().close();

  const dark = await openPage(BUYER_ID, { name: 'buyer-dark', colorScheme: 'dark' });
  await snap(dark, 'b22-catalog-dark');
  await dark.locator('#grid .card', { hasText: 'Milano' }).click();
  await snap(dark, 'b23-sheet-dark');
  await dark.context().close();

  const outside = await openPage(null, { name: 'outside-telegram', waitFor: '#grid .empty' });
  await snap(outside, 'b24-outside-telegram');
  await outside.context().close();
}

module.exports = { runBuyerScreens };
