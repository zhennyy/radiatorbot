// Действия без скриншотов: проверяем, что кнопки работают и не сыплют ошибками (и найденные баги не вернулись).
const { BUYER_ID, OWNER_ID } = require('./test-data');
const { pressBackButton, closeSheetByVeil, tabButton, adminSection, VIEWPORT } = require('./browser');

const isSheetOpen = (page) => page.evaluate(() => document.body.classList.contains('open'));

async function runBuyerChecks(runner) {
  const { openPage, check, settle } = runner;
  const buyer = await openPage(BUYER_ID, { name: 'buyer-extra' });
  await buyer.locator('#grid .card', { hasText: 'Nova Grande' }).click();
  await pressBackButton(buyer);
  check('кнопка «Назад» Telegram закрывает карточку товара', !(await isSheetOpen(buyer)));
  await tabButton(buyer, 'Заказы').click();
  await buyer.waitForSelector('#v-orders .order');
  const linksBefore = (await buyer.evaluate(() => window.__telegramLog.links)).length;
  await buyer.locator('#v-orders .btn.pay').first().click();
  await settle(buyer, { keepToast: true });
  check(
    '«Оплатить» у неоплаченного заказа открывает ссылку',
    (await buyer.evaluate(() => window.__telegramLog.links)).length === linksBefore + 1,
  );
  await tabButton(buyer, 'AI-подбор').click();
  await buyer.fill('#aiQ', 'что-нибудь в ванную');
  await buyer.click('#aiGo');
  await buyer.waitForSelector('#aiGrid .card');
  check('AI-подбор отвечает на свой запрос', /Nova Grande/.test(await buyer.locator('#aiAdvice').innerText()));
  await buyer.locator('#aiGrid .card .add').click();
  await settle(buyer);
  check('из AI-подбора товар кладётся в корзину', (await buyer.locator('#cartCount').innerText()) === '1');
  await buyer.locator('#aiGrid .card .step button', { hasText: '−' }).click();
  await settle(buyer);
  await buyer.context().close();
}

async function runOwnerChecks(runner, shop) {
  const { openPage, check, settle } = runner;
  const owner = await openPage(OWNER_ID, { name: 'owner-extra' });
  await tabButton(owner, 'Админка').click();
  await owner.waitForSelector('#admBody .order');
  await owner.locator('#admBody .order').first().locator('.mini', { hasText: 'Написать' }).click();
  await owner.waitForSelector('#msgs');
  check('«Написать» из заказа открывает чат', true);
  await pressBackButton(owner);
  await owner.waitForSelector('#admBody .aline[data-action="open-chat"], #admBody .aline[data-chat]');
  check('«Назад» из чата возвращает к списку чатов', !(await owner.locator('#msgs').count()));
  await owner.locator('#admBody .aline').first().click();
  await owner.waitForSelector('#msgs');
  await owner.locator('#admBody .chips.small .chip').first().click();
  await owner.waitForSelector('#admBody .order.flash');
  check('из чата можно перейти к заказу', true);

  // «Трек» у отправленного заказа: поправить трек-номер
  await owner.locator('#admBody .order', { hasText: 'Невский' }).locator('.btn', { hasText: 'Трек' }).click();
  await owner.fill('#trackIn', 'RA000000001RU');
  await owner.click('#trackGo');
  await settle(owner, { keepToast: true });
  const tracked = await shop.database.order.findFirst({ where: { address: { contains: 'Невский' } } });
  check('трек-номер исправляется кнопкой «Трек»', tracked.track === 'RA000000001RU', tracked.track);
  // отмена неоплаченного заказа (подтверждение в Telegram — подставное «да»)
  await owner.locator('#admBody .chip', { hasText: 'Ждут оплату' }).click();
  await owner.locator('#admBody .order').first().locator('.btn', { hasText: 'Отменить' }).click();
  await settle(owner, { keepToast: true });
  const cancelledCount = await shop.database.order.count({ where: { status: 'cancelled' } });
  check('заказ отменяется после подтверждения', cancelledCount === 1, String(cancelledCount));

  await adminSection(owner, 'Статистика').click();
  await owner.waitForSelector('#admBody .kpis');
  await owner.locator('#admBody .aline', { hasText: 'Loft Black' }).click();
  await owner.waitForSelector('#pform');
  check(
    'из «Заканчивается» открывается редактор товара',
    /Loft Black/.test(await owner.inputValue('#pform input[name="name"]')),
  );
  await closeSheetByVeil(owner);

  await owner.locator('#admBody .aline', { hasText: 'Milano' }).click();
  await owner
    .locator('#sheet .x')
    .click({ timeout: 3000 })
    .catch(() => {});
  check('крестик в редакторе товара с фото закрывает шторку', !(await isSheetOpen(owner)));
  if (await isSheetOpen(owner)) await closeSheetByVeil(owner);
  // Enter в поле названия не должен отправлять «фото по ссылке» (первая кнопка формы)
  const photoUrlRequests = [];
  owner.on('request', (request) => {
    if (request.url().includes('/photo-url')) photoUrlRequests.push(request.url());
  });
  await owner.locator('#admBody .aline', { hasText: 'Nova Grande' }).click();
  await owner.locator('#pform input[name="name"]').press('Enter');
  await settle(owner, { keepToast: true });
  check('Enter в редакторе не отправляет фото по ссылке', photoUrlRequests.length === 0, photoUrlRequests.join(' '));
  if (await isSheetOpen(owner)) await closeSheetByVeil(owner);

  await adminSection(owner, 'Настройки').click();
  await owner.waitForSelector('#admBody .prow');
  const pageWidth = await owner.evaluate(() => document.documentElement.scrollWidth);
  check('настройки не шире экрана телефона', pageWidth <= VIEWPORT.width, String(pageWidth));
  const moscowPrice = owner
    .locator('#admBody .crow', { has: owner.locator('input.cn[value="Москва"]') })
    .locator('.cp');
  await moscowPrice.fill('750');
  await moscowPrice.dispatchEvent('change');
  await settle(owner, { keepToast: true });
  const moscow = await shop.database.deliveryRate.findFirst({ where: { city: 'Москва' } });
  check('цена доставки города сохраняется при изменении', moscow.price === 75000, String(moscow.price));
  await owner.locator('#admBody .prow', { hasText: 'HEAT10' }).locator('.sw i').click();
  await settle(owner, { keepToast: true });
  const promo = await shop.database.promoCode.findFirst({ where: { code: 'HEAT10' } });
  check('промокод выключается переключателем', promo && !promo.active, JSON.stringify(promo && promo.active));
  await owner.locator('#admBody .prow', { hasText: 'WINTER15' }).locator('.mini').click();
  await settle(owner, { keepToast: true });
  check('промокод удаляется', !(await shop.database.promoCode.findFirst({ where: { code: 'WINTER15' } })));
  await owner.locator('#admBody .btn', { hasText: 'Получить копию' }).click();
  await settle(owner, { keepToast: true });
  check(
    'резервная копия запрошена',
    /архив|копи/i.test(await owner.locator('#toast').innerText()),
    await owner.locator('#toast').innerText(),
  );
  await owner.context().close();
}

async function runExtraChecks(runner, shop) {
  await runBuyerChecks(runner);
  await runOwnerChecks(runner, shop);
}

module.exports = { runExtraChecks };
