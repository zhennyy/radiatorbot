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
  // Шаг 2: подтверждение заказа
  async (ctx) => {
    ctx.wizard.state.address = ctx.message.text;
    const { items, total } = getCart(ctx.chat.id);

    // проверяем остатки перед подтверждением
    for (const i of items) {
      const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(i.product_id);
      if (p.stock < i.quantity) {
        await ctx.reply(`Недостаточно на складе: ${i.name} (осталось ${p.stock})`);
        return ctx.scene.leave();
      }
    }

    let summary = `Адрес: ${ctx.wizard.state.address}\n\nЗаказ:\n`;
    for (const i of items) summary += `${i.name} x${i.quantity}\n`;
    summary += `\nИтого: ${(total / 100).toFixed(0)} ₽`;

    await ctx.reply(
      summary,
      Markup.inlineKeyboard([
        Markup.button.callback('💳 Оплатить через ЮKassa', 'pay_yookassa'),
        Markup.button.callback('Отмена', 'checkout_cancel'),
      ])
    );
    return ctx.wizard.next();
  },
  // Шаг 3: ждём нажатия кнопки оплаты (обрабатывается глобальным action ниже)
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
  const orderId = createPendingOrder(ctx.chat.id, address, 'yookassa');
  await ctx.scene.leave();

  try {
    const payment = await createPayment(orderId, total / 100, `Заказ #${orderId}`);
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

// создаём заказ со статусом pending; вызывается на этапе оплаты после выбора способа
function createPendingOrder(chatId, address, provider) {
  const { items, total } = getCart(chatId);
  const order = db
    .prepare('INSERT INTO orders (chat_id, status, total, address, payment_provider) VALUES (?,?,?,?,?)')
    .run(chatId, 'pending', total, address, provider);
  const orderId = order.lastInsertRowid;
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)'
  );
  for (const i of items) insertItem.run(orderId, i.product_id, i.quantity, i.price);
  return orderId;
}

module.exports = { checkoutScene, createPendingOrder };
