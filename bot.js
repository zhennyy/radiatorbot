// bot.js
require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const db = require('./db');
const { getCart } = require('./cart');
const { checkoutScene } = require('./scenes/checkout');
const isOwner = require('./middleware/isOwner');
const { checkLowStock } = require('./notify');

const bot = new Telegraf(process.env.BOT_TOKEN);
const PAGE_SIZE = 5;

const stage = new Scenes.Stage([checkoutScene]);
bot.use(session());
bot.use(stage.middleware());

function formatPrice(kopecks) {
  return (kopecks / 100).toFixed(0) + ' ₽';
}

function getCatalogPage(page = 0, category = null) {
  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];
  const products = db
    .prepare(`SELECT * FROM products ${where} LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, page * PAGE_SIZE);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM products ${where}`).get(...params).c;
  return { products, hasNext: (page + 1) * PAGE_SIZE < total, hasPrev: page > 0 };
}

bot.start((ctx) => {
  ctx.reply(
    'Добро пожаловать в магазин RadiatorPro 🔥\nВыберите раздел:',
    Markup.keyboard(['📦 Каталог', '🛒 Корзина']).resize()
  );
});

bot.hears('📦 Каталог', (ctx) => sendCatalogPage(ctx, 0));
bot.command('catalog', (ctx) => sendCatalogPage(ctx, 0));

async function sendCatalogPage(ctx, page) {
  const { products, hasNext, hasPrev } = getCatalogPage(page);
  if (!products.length) return ctx.reply('Каталог пуст.');

  for (const p of products) {
    const caption = `${p.name}\n${p.description || ''}\nКатегория: ${p.category}\nЦена: ${formatPrice(p.price)}\nВ наличии: ${p.stock} шт.`;
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback('➕ В корзину', `add_${p.id}`),
    ]);
    if (p.photo_url) {
      await ctx.replyWithPhoto(p.photo_url, { caption, ...keyboard }).catch(() =>
        ctx.reply(caption, keyboard)
      );
    } else {
      await ctx.reply(caption, keyboard);
    }
  }

  const navButtons = [];
  if (hasPrev) navButtons.push(Markup.button.callback('⬅️', `page_${page - 1}`));
  if (hasNext) navButtons.push(Markup.button.callback('➡️', `page_${page + 1}`));
  if (navButtons.length) await ctx.reply('Листать:', Markup.inlineKeyboard(navButtons));
}

bot.action(/page_(\d+)/, (ctx) => {
  ctx.answerCbQuery();
  sendCatalogPage(ctx, parseInt(ctx.match[1], 10));
});

// === Корзина ===

bot.action(/add_(\d+)/, (ctx) => {
  const productId = parseInt(ctx.match[1], 10);
  const chatId = ctx.chat.id;

  const existing = db
    .prepare('SELECT * FROM cart_items WHERE chat_id = ? AND product_id = ?')
    .get(chatId, productId);

  if (existing) {
    db.prepare(
      'UPDATE cart_items SET quantity = quantity + 1 WHERE chat_id = ? AND product_id = ?'
    ).run(chatId, productId);
  } else {
    db.prepare(
      'INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?,?,1)'
    ).run(chatId, productId);
  }
  ctx.answerCbQuery('Добавлено в корзину ✅');
});

bot.hears('🛒 Корзина', showCart);
bot.command('cart', showCart);

async function showCart(ctx) {
  const chatId = ctx.chat.id;
  const { items, total } = getCart(chatId);
  if (!items.length) return ctx.reply('Корзина пуста.');

  let text = 'Ваша корзина:\n\n';
  const buttons = [];
  for (const i of items) {
    text += `${i.name} x${i.quantity} — ${formatPrice(i.price * i.quantity)}\n`;
    buttons.push([
      Markup.button.callback(`➖ ${i.name}`, `dec_${i.product_id}`),
      Markup.button.callback(`❌`, `rm_${i.product_id}`),
    ]);
  }
  text += `\nИтого: ${formatPrice(total)}`;
  buttons.push([Markup.button.callback('✅ Оформить заказ', 'checkout_start')]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
}

bot.action(/dec_(\d+)/, (ctx) => {
  const productId = parseInt(ctx.match[1], 10);
  const chatId = ctx.chat.id;
  db.prepare(
    `UPDATE cart_items SET quantity = quantity - 1
     WHERE chat_id = ? AND product_id = ?`
  ).run(chatId, productId);
  db.prepare(
    'DELETE FROM cart_items WHERE chat_id = ? AND product_id = ? AND quantity <= 0'
  ).run(chatId, productId);
  ctx.answerCbQuery();
  showCart(ctx);
});

bot.action(/rm_(\d+)/, (ctx) => {
  const productId = parseInt(ctx.match[1], 10);
  db.prepare('DELETE FROM cart_items WHERE chat_id = ? AND product_id = ?').run(
    ctx.chat.id,
    productId
  );
  ctx.answerCbQuery('Удалено');
  showCart(ctx);
});

// === Оформление заказа ===

bot.action('checkout_start', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('checkout-wizard');
});

// === Админ-панель (только для владельца) ===

bot.command('orders', isOwner, (ctx) => {
  const orders = db
    .prepare("SELECT * FROM orders WHERE status != 'pending' ORDER BY created_at DESC LIMIT 20")
    .all();
  if (!orders.length) return ctx.reply('Заказов нет.');
  const text = orders
    .map((o) => `#${o.id} — ${o.status} — ${(o.total / 100).toFixed(0)} ₽ — ${o.created_at}`)
    .join('\n');
  ctx.reply(text);
});

bot.command('addproduct', isOwner, async (ctx) => {
  // формат: /addproduct Название | Описание | Цена | Остаток | Категория
  const raw = ctx.message.text.replace('/addproduct', '').trim();
  const [name, description, priceRub, stock, category] = raw.split('|').map((s) => s.trim());
  if (!name || !priceRub) {
    return ctx.reply('Формат: /addproduct Название | Описание | Цена | Остаток | Категория');
  }
  db.prepare(
    'INSERT INTO products (name, description, price, stock, category) VALUES (?,?,?,?,?)'
  ).run(name, description || '', Math.round(parseFloat(priceRub) * 100), parseInt(stock) || 0, category || null);
  ctx.reply(`Товар "${name}" добавлен.`);
});

bot.command('stock', isOwner, (ctx) => {
  // формат: /stock <id_товара> <новый_остаток>
  const [, id, qty] = ctx.message.text.split(' ');
  if (!id || !qty) return ctx.reply('Формат: /stock <id_товара> <новый_остаток>');
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(parseInt(qty), parseInt(id));
  ctx.reply(`Остаток товара #${id} обновлён: ${qty}`);
  checkLowStock(bot);
});

bot.command('markshipped', isOwner, (ctx) => {
  // формат: /markshipped <id_заказа>
  const [, orderId] = ctx.message.text.split(' ');
  if (!orderId) return ctx.reply('Формат: /markshipped <id_заказа>');
  db.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(parseInt(orderId));
  const order = db.prepare('SELECT chat_id FROM orders WHERE id = ?').get(parseInt(orderId));
  if (order) bot.telegram.sendMessage(order.chat_id, `Ваш заказ #${orderId} отправлен! 🚚`);
  ctx.reply(`Заказ #${orderId} помечен как отправленный.`);
});

bot.launch();
console.log('Бот запущен');

const { startWebhookServer } = require('./webhook');
startWebhookServer(bot);

// проверка низкого остатка раз в час
setInterval(() => checkLowStock(bot), 1000 * 60 * 60);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
