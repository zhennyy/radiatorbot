// bot.js
require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
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

// Постоянная клавиатура снизу — переприсылаем её после каждого раздела,
// чтобы она не пропадала, даже если Telegram-клиент её случайно скрыл
const mainMenu = Markup.keyboard([
  ['📦 Каталог', '🔍 Поиск'],
  ['📂 Категории', '🛒 Корзина'],
  ['📋 Мои заказы', '🤖 AI-подбор'],
]).resize();

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
  ctx.reply('Добро пожаловать в магазин RadiatorPro 🔥\nВыберите раздел:', mainMenu);
});

bot.hears('📦 Каталог', (ctx) => sendCatalogPage(ctx, 0));
bot.command('catalog', (ctx) => sendCatalogPage(ctx, 0));

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderProductCard(ctx, p) {
  const stockLine =
    p.stock > 0 ? `📦 В наличии: ${p.stock} шт.` : '⛔️ Нет в наличии';

  const caption =
    `🔥 <b>${escapeHtml(p.name)}</b>\n` +
    (p.description ? `<i>${escapeHtml(p.description)}</i>\n\n` : '\n') +
    `🏷 ${escapeHtml(p.category)}\n` +
    `💰 Цена: <b>${formatPrice(p.price)}</b>\n` +
    stockLine;

  const extra = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([Markup.button.callback('➕ В корзину', `add_${p.id}`)]),
  };

  if (p.photo_url) {
    await ctx.replyWithPhoto(p.photo_url, { caption, ...extra }).catch(() =>
      ctx.reply(caption, extra)
    );
  } else {
    await ctx.reply(caption, extra);
  }
}

async function sendCatalogPage(ctx, page, category = null) {
  const { products, hasNext, hasPrev } = getCatalogPage(page, category);
  if (!products.length) return ctx.reply('Товаров не найдено.', mainMenu);

  for (const p of products) {
    await renderProductCard(ctx, p);
  }

  const catIndex = category && ctx.session?.catList ? ctx.session.catList.indexOf(category) : -1;
  const catSuffix = catIndex >= 0 ? `_c${catIndex}` : '';

  const navButtons = [];
  if (hasPrev) navButtons.push(Markup.button.callback('⬅️', `page_${page - 1}${catSuffix}`));
  if (hasNext) navButtons.push(Markup.button.callback('➡️', `page_${page + 1}${catSuffix}`));
  if (navButtons.length) await ctx.reply('Листать:', Markup.inlineKeyboard(navButtons));

  await ctx.reply('Меню 👇', mainMenu);
}

bot.action(/^page_(\d+)(?:_c(\d+))?$/, (ctx) => {
  ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10);
  const category =
    ctx.match[2] !== undefined ? ctx.session?.catList?.[parseInt(ctx.match[2], 10)] || null : null;
  sendCatalogPage(ctx, page, category);
});

// === Категории ===

bot.hears('📂 Категории', async (ctx) => {
  const categories = db
    .prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category')
    .all()
    .map((r) => r.category);
  if (!categories.length) return ctx.reply('Категории пока не заданы.', mainMenu);
  ctx.session.catList = categories;
  const buttons = categories.map((c, i) => [Markup.button.callback(c, `cat_${i}`)]);
  await ctx.reply('Выберите категорию:', Markup.inlineKeyboard(buttons));
  await ctx.reply('Меню 👇', mainMenu);
});

bot.action(/^cat_(\d+)$/, (ctx) => {
  ctx.answerCbQuery();
  const category = ctx.session?.catList?.[parseInt(ctx.match[1], 10)];
  if (!category) return ctx.reply('Список категорий устарел, откройте его заново: 📂 Категории');
  sendCatalogPage(ctx, 0, category);
});

// === Поиск по названию ===

bot.hears('🔍 Поиск', (ctx) => {
  ctx.session.awaitingSearch = true;
  ctx.reply('Введите название товара (или часть названия) для поиска:', mainMenu);
});

bot.on('text', async (ctx, next) => {
  if (ctx.session?.awaitingSearch) {
    ctx.session.awaitingSearch = false;
    const term = ctx.message.text.trim();
    if (!term) return;
    const products = db
      .prepare('SELECT * FROM products WHERE name LIKE ? ORDER BY name LIMIT 20')
      .all(`%${term}%`);
    if (!products.length) return ctx.reply(`Ничего не найдено по запросу «${term}».`, mainMenu);
    for (const p of products) {
      await renderProductCard(ctx, p);
    }
    await ctx.reply('Меню 👇', mainMenu);
    return;
  }

  if (ctx.session?.awaitingAiConsult) {
    ctx.session.awaitingAiConsult = false;
    const query = ctx.message.text.trim();
    if (!query) return;

    const thinkingMsg = await ctx.reply('🤖 Подбираю варианты...');
    try {
      const { adviceText, productIds } = await getAiRecommendation(query);
      await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(adviceText || 'Не удалось сформировать рекомендацию.');

      for (const id of productIds) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (p) await renderProductCard(ctx, p);
      }
    } catch (err) {
      console.error('Ошибка AI-консультанта:', err.response?.data || err.message);
      await ctx.reply('Не удалось получить рекомендацию от AI-консультанта. Попробуйте ещё раз чуть позже.');
    }
    await ctx.reply('Меню 👇', mainMenu);
    return;
  }

  return next();
});

// === AI-консультант по подбору радиатора ===

bot.hears('🤖 AI-подбор', (ctx) => {
  ctx.session.awaitingAiConsult = true;
  ctx.reply(
    'Опишите, что вам нужно: площадь и тип помещения, тип отопления, бюджет, желаемый стиль — и я подберу подходящие товары из каталога 🤖',
    mainMenu
  );
});

async function getAiRecommendation(userQuery) {
  const products = db
    .prepare('SELECT id, name, description, price, category, stock FROM products WHERE stock > 0')
    .all();

  const catalogText = products
    .map((p) => `#${p.id} ${p.name} (${p.category}) — ${formatPrice(p.price)}. ${p.description || ''}`)
    .join('\n');

  const systemPrompt =
    'Ты — консультант интернет-магазина отопительного оборудования RadiatorPro. ' +
    'Ниже дан текущий каталог товаров в наличии. Подбери покупателю 1-3 подходящих товара ' +
    'по его описанию (площадь и тип помещения, тип отопления, бюджет, стиль и т.п.) и кратко объясни выбор. ' +
    'Отвечай по-русски, дружелюбно и по делу, без markdown-разметки. ' +
    'В самом конце ответа ОБЯЗАТЕЛЬНО добавь отдельной строкой формата ' +
    '"РЕКОМЕНДАЦИИ: #id1, #id2" с ID рекомендованных товаров из каталога.\n\n' +
    `Каталог:\n${catalogText}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userQuery }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );

  const raw = response.data.content?.[0]?.text || '';
  const match = raw.match(/РЕКОМЕНДАЦИИ:\s*(.+)\s*$/i);
  let productIds = [];
  let adviceText = raw.trim();

  if (match) {
    productIds = [...match[1].matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
    adviceText = raw.slice(0, match.index).trim();
  }

  return { adviceText, productIds };
}

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
  if (!items.length) return ctx.reply('Корзина пуста.', mainMenu);

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
  await ctx.reply('Меню 👇', mainMenu);
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

// === История заказов покупателя ===

const ORDER_STATUS_LABEL = {
  pending: '⏳ ожидает оплаты',
  awaiting_payment: '⏳ ожидает оплаты',
  paid: '✅ оплачен',
  shipped: '🚚 отправлен',
  delivered: '📦 доставлен',
  cancelled: '❌ отменён',
};

bot.hears('📋 Мои заказы', showMyOrders);
bot.command('myorders', showMyOrders);

async function showMyOrders(ctx) {
  const orders = db
    .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(ctx.chat.id);

  if (!orders.length) return ctx.reply('У вас пока нет заказов.', mainMenu);

  const itemsStmt = db.prepare(
    `SELECT oi.quantity, p.name FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`
  );

  await ctx.reply(`📋 <b>Ваши заказы</b> (последние ${orders.length})`, { parse_mode: 'HTML' });

  for (const o of orders) {
    const statusKey = (o.status || '').split(':')[0];
    const statusLabel = ORDER_STATUS_LABEL[statusKey] || statusKey;
    const items = itemsStmt.all(o.id);
    const itemsText = items.map((i) => `• ${i.name} ×${i.quantity}`).join('\n');
    const date = (o.created_at || '').slice(0, 16).replace('T', ' ');

    let text = `<b>Заказ #${o.id}</b>\n`;
    text += `${statusLabel}\n\n`;
    text += `${itemsText}\n\n`;
    if (o.discount_percent > 0) {
      text += `Промокод «${o.promo_code}»: −${o.discount_percent}%\n`;
    }
    text += `💰 Сумма: <b>${formatPrice(o.total)}</b>\n`;
    text += `📍 ${o.address || '—'}\n`;
    text += `🕐 ${date}`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  await ctx.reply('Меню 👇', mainMenu);
}

// === Оформление заказа ===

bot.action('checkout_start', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('checkout-wizard');
});

// === Админ-панель (только для владельца) ===

bot.command('orders', isOwner, async (ctx) => {
  const orders = db
    .prepare("SELECT * FROM orders WHERE status != 'pending' ORDER BY created_at DESC LIMIT 20")
    .all();
  if (!orders.length) return ctx.reply('Заказов нет.');

  await ctx.reply(`📋 <b>Заказы</b> (последние ${orders.length})`, { parse_mode: 'HTML' });

  for (const o of orders) {
    const statusKey = (o.status || '').split(':')[0];
    const statusLabel = ORDER_STATUS_LABEL[statusKey] || statusKey;
    const date = (o.created_at || '').slice(0, 16).replace('T', ' ');

    let text = `<b>Заказ #${o.id}</b>\n`;
    text += `${statusLabel}\n\n`;
    if (o.discount_percent > 0) {
      text += `Промокод «${o.promo_code}»: −${o.discount_percent}%\n`;
    }
    text += `💰 Сумма: <b>${formatPrice(o.total)}</b>\n`;
    text += `📍 ${o.address || '—'}\n`;
    text += `🕐 ${date}`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  }
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

// === Промокоды (только для владельца) ===

bot.command('addpromo', isOwner, (ctx) => {
  // формат: /addpromo КОД ПРОЦЕНТ [МАКС_ИСПОЛЬЗОВАНИЙ]
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const [, code, percentStr, maxUsesStr] = parts;
  const percent = parseInt(percentStr, 10);
  if (!code || !percent || percent <= 0 || percent >= 100) {
    return ctx.reply('Формат: /addpromo КОД ПРОЦЕНТ [МАКС_ИСПОЛЬЗОВАНИЙ]\nНапример: /addpromo SALE10 10 50');
  }
  const maxUses = maxUsesStr ? parseInt(maxUsesStr, 10) : null;
  try {
    db.prepare(
      'INSERT INTO promo_codes (code, discount_percent, max_uses) VALUES (?,?,?)'
    ).run(code.toUpperCase(), percent, maxUses);
    ctx.reply(`Промокод "${code.toUpperCase()}" создан: скидка ${percent}%${maxUses ? `, лимит ${maxUses} использований` : ''}.`);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      ctx.reply(`Промокод "${code.toUpperCase()}" уже существует.`);
    } else {
      ctx.reply('Не удалось создать промокод: ' + err.message);
    }
  }
});

bot.command('promos', isOwner, (ctx) => {
  const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
  if (!promos.length) return ctx.reply('Промокодов пока нет.');
  const text = promos
    .map((p) => {
      const status = p.active ? 'активен' : 'выключен';
      const usage = p.max_uses ? `${p.used_count}/${p.max_uses}` : `${p.used_count}/∞`;
      return `${p.code} — ${p.discount_percent}% — ${status} — использован ${usage}`;
    })
    .join('\n');
  ctx.reply(text);
});

bot.command('delpromo', isOwner, (ctx) => {
  // формат: /delpromo КОД
  const [, code] = ctx.message.text.split(' ');
  if (!code) return ctx.reply('Формат: /delpromo КОД');
  const result = db.prepare('UPDATE promo_codes SET active = 0 WHERE code = ? COLLATE NOCASE').run(code);
  ctx.reply(result.changes ? `Промокод "${code.toUpperCase()}" выключен.` : `Промокод "${code.toUpperCase()}" не найден.`);
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
