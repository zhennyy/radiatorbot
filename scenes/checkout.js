// scenes/checkout.js
const { Scenes, Markup } = require('telegraf');
const db = require('../db');
const { getCart } = require('../cart');

// ищем тариф доставки по городу (без учёта регистра); если города нет в списке —
// используем дефолтный тариф на "остальную Россию"
function getDeliveryPrice(city) {
  const rate = db
    .prepare('SELECT price FROM delivery_rates WHERE city = ? COLLATE NOCASE AND active = 1')
    .get(city);
  return rate ? rate.price : db.DEFAULT_DELIVERY_PRICE;
}

function buildCityKeyboard(cityOptions) {
  const cityButtons = cityOptions.map((opt, i) =>
    Markup.button.callback(opt.city, `deliv_city_${i}`)
  );
  const rows = [];
  for (let i = 0; i < cityButtons.length; i += 2) {
    rows.push(cityButtons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback('📍 Другой город', 'deliv_other')]);
  rows.push([Markup.button.callback('🏠 Самовывоз', 'deliv_pickup')]);
  return Markup.inlineKeyboard(rows);
}

const checkoutScene = new Scenes.WizardScene(
  'checkout-wizard',
  // Шаг 1: проверяем корзину и остатки, показываем кнопки выбора города
  async (ctx) => {
    const { items } = getCart(ctx.chat.id);
    if (!items.length) {
      await ctx.reply('Корзина пуста.');
      return ctx.scene.leave();
    }

    for (const i of items) {
      const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(i.product_id);
      if (p.stock < i.quantity) {
        await ctx.reply(`Недостаточно на складе: ${i.name} (осталось ${p.stock})`);
        return ctx.scene.leave();
      }
    }

    const cityOptions = db
      .prepare('SELECT city, price FROM delivery_rates WHERE active = 1 ORDER BY city')
      .all();
    ctx.wizard.state.cityOptions = cityOptions;

    await ctx.reply('Выберите город доставки:', buildCityKeyboard(cityOptions));
    return ctx.wizard.next();
  },
  // Шаг 2: ждём нажатия кнопки выбора города (обрабатывается action-хендлерами ниже)
  async (ctx) => {
    if (ctx.message) {
      await ctx.reply('Пожалуйста, выберите вариант на кнопках выше 👆');
    }
  },
  // Шаг 3: город/название города введено вручную -> адрес
  async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    if (!text) {
      await ctx.reply('Введите текст сообщением.');
      return;
    }

    if (ctx.wizard.state.awaitingCustomCityName) {
      ctx.wizard.state.awaitingCustomCityName = false;
      ctx.wizard.state.deliveryCity = text;
      ctx.wizard.state.deliveryCost = getDeliveryPrice(text);
      await ctx.reply('Введите точный адрес (улица, дом, квартира):');
      return;
    }

    ctx.wizard.state.address = `${ctx.wizard.state.deliveryCity}, ${text}`;
    ctx.wizard.selectStep(3);
    return checkoutScene.steps[3](ctx);
  },
  // Шаг 4: применяем промокод (если есть) и показываем итог с доставкой
  async (ctx) => {
    // этот шаг вызывается либо напрямую (после ввода адреса/самовывоза),
    // либо как следующий шаг визарда после ввода промокода — различаем по флагу
    if (ctx.wizard.state.awaitingPromo) {
      ctx.wizard.state.awaitingPromo = false;
      const input = (ctx.message?.text || '').trim();
      const { total } = getCart(ctx.chat.id);

      let discountPercent = 0;
      let promoCode = null;

      if (input && input !== '-') {
        const promo = db
          .prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE AND active = 1')
          .get(input);
        if (!promo) {
          await ctx.reply('Промокод не найден или больше не действует. Продолжаем без скидки.');
        } else if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
          await ctx.reply('Промокод исчерпан. Продолжаем без скидки.');
        } else {
          discountPercent = promo.discount_percent;
          promoCode = promo.code;
        }
      }

      const discountedTotal =
        discountPercent > 0 ? Math.round((total * (100 - discountPercent)) / 100) : total;
      const deliveryCost = ctx.wizard.state.deliveryCost || 0;
      const grandTotal = discountedTotal + deliveryCost;

      ctx.wizard.state.promoCode = promoCode;
      ctx.wizard.state.discountPercent = discountPercent;
      ctx.wizard.state.discountedTotal = discountedTotal;
      ctx.wizard.state.grandTotal = grandTotal;

      const { items } = getCart(ctx.chat.id);
      let summary = `Адрес: ${ctx.wizard.state.address}\n\nЗаказ:\n`;
      for (const i of items) summary += `${i.name} x${i.quantity}\n`;
      summary += `\nСумма товаров: ${(total / 100).toFixed(0)} ₽`;
      if (discountPercent > 0) {
        summary += `\nПромокод «${promoCode}»: -${discountPercent}%`;
      }
      summary += `\nДоставка${ctx.wizard.state.deliveryCity ? ` (${ctx.wizard.state.deliveryCity})` : ' (самовывоз)'}: ${
        deliveryCost > 0 ? (deliveryCost / 100).toFixed(0) + ' ₽' : 'бесплатно'
      }`;
      summary += `\nИтого: ${(grandTotal / 100).toFixed(0)} ₽`;

      await ctx.reply(
        summary,
        Markup.inlineKeyboard([
          Markup.button.callback('💳 Оплатить через ЮKassa', 'pay_yookassa'),
          Markup.button.callback('Отмена', 'checkout_cancel'),
        ])
      );
      return ctx.wizard.next();
    }

    // первый заход на этот шаг — спрашиваем промокод
    ctx.wizard.state.awaitingPromo = true;
    await ctx.reply('Есть промокод? Введите код или отправьте «-», чтобы пропустить.');
  },
  // Шаг 5: ждём нажатия кнопки оплаты (обрабатывается глобальным action ниже)
  async (ctx) => {}
);

// выбор города из списка кнопок
checkoutScene.action(/^deliv_city_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1], 10);
  const opt = ctx.wizard.state.cityOptions?.[idx];
  if (!opt) {
    await ctx.reply('Список городов устарел, начните оформление заново: 🛒 Корзина → ✅ Оформить заказ');
    return ctx.scene.leave();
  }
  ctx.wizard.state.deliveryCity = opt.city;
  ctx.wizard.state.deliveryCost = opt.price;
  await ctx.reply(`Город: ${opt.city}\nВведите точный адрес (улица, дом, квартира):`);
  ctx.wizard.selectStep(2);
});

// свой вариант города, не из списка
checkoutScene.action('deliv_other', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.wizard.state.awaitingCustomCityName = true;
  await ctx.reply('Введите название города:');
  ctx.wizard.selectStep(2);
});

// самовывоз — доставка не нужна, сразу к промокоду и итогу
checkoutScene.action('deliv_pickup', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.wizard.state.address = 'Самовывоз';
  ctx.wizard.state.deliveryCity = null;
  ctx.wizard.state.deliveryCost = 0;
  ctx.wizard.selectStep(3);
  return checkoutScene.steps[3](ctx);
});

checkoutScene.action('checkout_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Оформление отменено.');
  return ctx.scene.leave();
});

checkoutScene.action('pay_yookassa', async (ctx) => {
  const { createPayment } = require('../payments/yookassa');
  await ctx.answerCbQuery();

  const address = ctx.wizard.state.address;
  const promoCode = ctx.wizard.state.promoCode || null;
  const discountPercent = ctx.wizard.state.discountPercent || 0;
  const deliveryCity = ctx.wizard.state.deliveryCity || null;
  const deliveryCost = ctx.wizard.state.deliveryCost || 0;
  const finalTotal = ctx.wizard.state.grandTotal;

  const orderId = createPendingOrder(
    ctx.chat.id,
    address,
    'yookassa',
    finalTotal,
    promoCode,
    discountPercent,
    deliveryCity,
    deliveryCost
  );
  if (promoCode) {
    db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(promoCode);
  }
  await ctx.scene.leave();

  try {
    const payment = await createPayment(orderId, finalTotal / 100, `Заказ #${orderId}`);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(
      `awaiting_payment:${payment.id}`,
      orderId
    );
    await ctx.reply(
      `Ссылка для оплаты заказа #${orderId}:`,
      Markup.inlineKeyboard([
        Markup.button.url('Оплатить', payment.confirmation.confirmation_url),
      ])
    );
  } catch (err) {
    console.error('Ошибка создания платежа ЮKassa:', err.response?.data || err.message);
    await ctx.reply('Не удалось создать платёж. Проверьте настройки ЮKassa в .env и попробуйте снова.');
  }
});

// создаём заказ со статусом pending; total уже с учётом скидки по промокоду и доставки
function createPendingOrder(
  chatId,
  address,
  provider,
  total,
  promoCode = null,
  discountPercent = 0,
  deliveryCity = null,
  deliveryCost = 0
) {
  const { items } = getCart(chatId);
  const order = db
    .prepare(
      'INSERT INTO orders (chat_id, status, total, address, payment_provider, promo_code, discount_percent, delivery_city, delivery_cost) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    .run(chatId, 'pending', total, address, provider, promoCode, discountPercent, deliveryCity, deliveryCost);
  const orderId = order.lastInsertRowid;
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)'
  );
  for (const i of items) insertItem.run(orderId, i.product_id, i.quantity, i.price);
  return orderId;
}

module.exports = { checkoutScene, createPendingOrder };
