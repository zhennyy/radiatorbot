// scenes/checkout.js
const { Scenes, Markup } = require('telegraf');
const db = require('../db');
const { getCart } = require('../cart');

const checkoutScene = new Scenes.WizardScene(
  'checkout-wizard',
  // Шаг 1: спросить адрес
  async (ctx) => {
    const { items } = getCart(ctx.chat.id);
    if (!items.length) {
      await ctx.reply('Корзина пуста.');
      return ctx.scene.leave();
    }
    await ctx.reply('Введите адрес доставки (или напишите "самовывоз"):');
    return ctx.wizard.next();
  },
  // Шаг 2: сохраняем адрес, проверяем остатки, спрашиваем промокод
  async (ctx) => {
    ctx.wizard.state.address = ctx.message.text;
    const { items } = getCart(ctx.chat.id);

    // проверяем остатки перед подтверждением
    for (const i of items) {
      const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(i.product_id);
      if (p.stock < i.quantity) {
        await ctx.reply(`Недостаточно на складе: ${i.name} (осталось ${p.stock})`);
        return ctx.scene.leave();
      }
    }

    await ctx.reply('Есть промокод? Введите код или отправьте «-», чтобы пропустить.');
    return ctx.wizard.next();
  },
  // Шаг 3: применяем промокод (если есть) и показываем итог
  async (ctx) => {
    const { items, total } = getCart(ctx.chat.id);
    const input = (ctx.message.text || '').trim();

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

    ctx.wizard.state.promoCode = promoCode;
    ctx.wizard.state.discountPercent = discountPercent;
    ctx.wizard.state.discountedTotal = discountedTotal;

    let summary = `Адрес: ${ctx.wizard.state.address}\n\nЗаказ:\n`;
    for (const i of items) summary += `${i.name} x${i.quantity}\n`;
    if (discountPercent > 0) {
      summary += `\nСумма: ${(total / 100).toFixed(0)} ₽`;
      summary += `\nПромокод «${promoCode}»: -${discountPercent}%`;
    }
    summary += `\nИтого: ${(discountedTotal / 100).toFixed(0)} ₽`;

    await ctx.reply(
      summary,
      Markup.inlineKeyboard([
        Markup.button.callback('💳 Оплатить через ЮKassa', 'pay_yookassa'),
        Markup.button.callback('Отмена', 'checkout_cancel'),
      ])
    );
    return ctx.wizard.next();
  },
  // Шаг 4: ждём нажатия кнопки оплаты (обрабатывается глобальным action ниже)
  async (ctx) => {}
);

checkoutScene.action('checkout_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Оформление отменено.');
  return ctx.scene.leave();
});

checkoutScene.action('pay_yookassa', async (ctx) => {
  const { createPayment } = require('../payments/yookassa');
  await ctx.answerCbQuery();

  const { total } = getCart(ctx.chat.id);
  const address = ctx.wizard.state.address;
  const promoCode = ctx.wizard.state.promoCode || null;
  const discountPercent = ctx.wizard.state.discountPercent || 0;
  const finalTotal = ctx.wizard.state.discountedTotal ?? total;

  const orderId = createPendingOrder(
    ctx.chat.id,
    address,
    'yookassa',
    finalTotal,
    promoCode,
    discountPercent
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

// создаём заказ со статусом pending; total уже с учётом скидки по промокоду (если был)
function createPendingOrder(chatId, address, provider, total, promoCode = null, discountPercent = 0) {
  const { items } = getCart(chatId);
  const order = db
    .prepare(
      'INSERT INTO orders (chat_id, status, total, address, payment_provider, promo_code, discount_percent) VALUES (?,?,?,?,?,?,?)'
    )
    .run(chatId, 'pending', total, address, provider, promoCode, discountPercent);
  const orderId = order.lastInsertRowid;
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)'
  );
  for (const i of items) insertItem.run(orderId, i.product_id, i.quantity, i.price);
  return orderId;
}

module.exports = { checkoutScene, createPendingOrder };
