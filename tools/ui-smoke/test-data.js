// Тестовые данные магазина для проверки в браузере: доставка, промокод, фото, товары «мало» и «нет в наличии», заказы, переписка.
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../../src/server/test-helpers');

const BUYER_ID = 2002;
const SECOND_BUYER_ID = 2003;
const OWNER_ID = helpers.OWNER_ID;
const DAY_MS = 24 * 3600 * 1000;
const CATALOG_FIX_MARKER = '.done-2026-10-01-catalog';

// Дата заказа/сообщения «N дней назад» в формате базы — одинаковая при повторных прогонах в тот же день
function daysAgo(days, time) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10) + ' ' + time;
}

// При старте сервер разово ставит Loft Black фото по внешней ссылке — дожидаемся, чтобы потом заменить своим
async function waitForOneTimeFixes() {
  const marker = path.join(path.dirname(process.env.DB_PATH), 'uploads', CATALOG_FIX_MARKER);
  for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}

async function prepareShop(shop) {
  const actions = helpers.createShopActions(shop);
  const customers = require('../../src/customers');
  const ownerCall = (method, urlPath, body) => shop.call(OWNER_ID, method, urlPath, body);
  const expectOk = (response, what) => {
    if (response.status !== 200) throw new Error(`${what}: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  };

  await waitForOneTimeFixes();
  expectOk(
    await ownerCall('POST', '/shop-api/admin/delivery', {
      otherPrice: '900',
      freeFrom: '30000',
      pickup: true,
      pickupAddress: 'СПб, ул. Седова, 12 — пн–сб 10:00–19:00',
    }),
    'доставка',
  );
  expectOk(
    await ownerCall('POST', '/shop-api/admin/promos', { code: 'HEAT10', percent: '10', max_uses: '50' }),
    'промокод',
  );
  await actions.createProduct({
    name: 'Радиатор Retro Cast',
    description: 'Чугунный ретро-радиатор, 10 секций',
    price: '32000',
    stock: '0',
    category: 'Чугунные',
  });

  // фото: у двух товаров — настоящие из папки проекта, у Loft Black — битое (проверяем заглушку), остальные без фото
  await shop.database.product.update({ where: { id: 1 }, data: { photo_url: '/photos/1-milano-bianco.jpg' } });
  await shop.database.product.update({ where: { id: 3 }, data: { photo_url: '/photos/3-elegance.jpg' } });
  await shop.database.product.update({ where: { id: 4 }, data: { photo_url: 'AgACAgIAAxkBAAIBROKEN', stock: 2 } });

  await customers.setName(BUYER_ID, 'Ольга');
  await customers.setName(SECOND_BUYER_ID, 'Анна');

  // заказы: у покупателя — выданный самовывоз (с оценкой) и неоплаченный; у второго — курьер в сборке и оплаченный самовывоз
  expectOk(await actions.buy(BUYER_ID, [[1, 1]]), 'заказ 1');
  await actions.payLastOrder();
  const firstOrder = await shop.database.order.findFirst({ where: { chat_id: BUYER_ID }, orderBy: { id: 'desc' } });
  for (const status of ['assembling', 'shipped', 'delivered'])
    expectOk(await ownerCall('POST', `/shop-api/admin/orders/${firstOrder.id}/status`, { status }), 'статус ' + status);
  await shop.database.order.update({ where: { id: firstOrder.id }, data: { rating: 5 } });
  expectOk(await actions.buy(BUYER_ID, [[5, 2]]), 'заказ 2');

  await actions.clearCart(SECOND_BUYER_ID);
  await actions.setCart(SECOND_BUYER_ID, [
    [2, 1],
    [3, 1],
  ]);
  expectOk(
    await shop.call(SECOND_BUYER_ID, 'POST', '/shop-api/order', {
      delivery: 'city',
      city: 'Санкт-Петербург',
      address: 'Невский проспект, 10, кв. 5',
      phone: '+7 900 111-22-33',
      promo: 'HEAT10',
    }),
    'заказ 3',
  );
  await actions.payLastOrder();
  const courierOrder = await shop.database.order.findFirst({
    where: { chat_id: SECOND_BUYER_ID },
    orderBy: { id: 'desc' },
  });
  expectOk(
    await ownerCall('POST', `/shop-api/admin/orders/${courierOrder.id}/status`, { status: 'assembling' }),
    'сборка',
  );
  expectOk(await actions.buy(SECOND_BUYER_ID, [[5, 3]]), 'заказ 4');
  await actions.payLastOrder();

  await shop.database.message.createMany({
    data: [
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        text: 'Здравствуйте! Nova Grande подойдёт на комнату 18 м²?',
        is_read: 1,
        created_at: daysAgo(1, '10:15:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 1,
        text: 'Да, его мощности хватит с запасом 🙂',
        is_read: 1,
        created_at: daysAgo(1, '10:20:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        photo: 'AgACAgIAAxkBAAIBPHOTO',
        is_read: 0,
        created_at: daysAgo(0, '08:05:00'),
      },
      {
        chat_id: SECOND_BUYER_ID,
        from_owner: 0,
        text: 'Вот ниша под окном, куда хочу поставить',
        is_read: 0,
        created_at: daysAgo(0, '08:06:00'),
      },
    ],
  });
  await normalizeOrders(shop);
}

// Коды и даты заказов случайные/текущие — делаем их одинаковыми, чтобы скриншоты сравнивались
async function normalizeOrders(shop) {
  const allOrders = await shop.database.order.findMany({ orderBy: { id: 'asc' } });
  for (const order of allOrders) {
    await shop.database.order.update({
      where: { id: order.id },
      data: { order_code: `RP-${100 + order.id}`, created_at: daysAgo(6 - order.id, `1${order.id}:30:00`) },
    });
  }
}

module.exports = { prepareShop, normalizeOrders, BUYER_ID, SECOND_BUYER_ID, OWNER_ID };
