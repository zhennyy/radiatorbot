// bot.js
require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const db = require('./db');
const { getCart } = require('./cart');
const { checkoutScene } = require('./scenes/checkout');
const isOwner = require('./middleware/isOwner');
const { checkLowStock } = require('./notify');
const { t } = require('./i18n');

const bot = new Telegraf(process.env.BOT_TOKEN);
const PAGE_SIZE = 5;

const stage = new Scenes.Stage([checkoutScene]);
bot.use(session());
bot.use(stage.middleware());

function formatPrice(kopecks) {
  return (kopecks / 100).toFixed(0) + ' ₽';
}

// Постоянная клавиатура снизу — переприсылаем её после каждого раздела,
// чтобы она не пропадала, даже если Telegram-клиент её случайно скрыл.
// Покупатель может переключить язык интерфейса кнопкой "🌐 Язык / Language" —
// эта кнопка и её обработчики распознают нажатие независимо от текущего языка.
function buildMainMenu(lang) {
  return Markup.keyboard([
    [t(lang, 'btnCatalog'), t(lang, 'btnSearch')],
    [t(lang, 'btnCategories'), t(lang, 'btnCart')],
    [t(lang, 'btnMyOrders'), t(lang, 'btnAiPick')],
    [t(lang, 'btnLanguage')],
  ]).resize();
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
  const lang = db.getLang(ctx.chat.id);
  ctx.reply(t(lang, 'welcome'), buildMainMenu(lang));
});

// === Переключение языка / Language switch ===

bot.hears([t('ru', 'btnLanguage'), t('en', 'btnLanguage')], async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  await ctx.reply(
    t(lang, 'chooseLanguage'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'lang_ru'), Markup.button.callback('🇬🇧 English', 'lang_en')],
    ])
  );
});

bot.action(/^lang_(ru|en)$/, async (ctx) => {
  const lang = ctx.match[1];
  db.setLang(ctx.chat.id, lang);
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'languageSet'), buildMainMenu(lang));
});

bot.hears([t('ru', 'btnCatalog'), t('en', 'btnCatalog')], (ctx) => sendCatalogPage(ctx, 0));
bot.command('catalog', (ctx) => sendCatalogPage(ctx, 0));

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderProductCard(ctx, p, lang) {
  const name = (lang === 'en' && p.name_en) || p.name;
  const description = (lang === 'en' && p.description_en) || p.description;
  const category = (lang === 'en' && p.category_en) || p.category;

  const stockLine = p.stock > 0 ? t(lang, 'inStock', p.stock) : t(lang, 'outOfStock');

  const caption =
    `🔥 <b>${escapeHtml(name)}</b>\n` +
    (description ? `<i>${escapeHtml(description)}</i>\n\n` : '\n') +
    `🏷 ${escapeHtml(category)}\n` +
    `${t(lang, 'priceLabel')} <b>${formatPrice(p.price)}</b>\n` +
    stockLine;

  const extra = {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([Markup.button.callback(t(lang, 'addToCart'), `add_${p.id}`)]),
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
  const lang = db.getLang(ctx.chat.id);
  const { products, hasNext, hasPrev } = getCatalogPage(page, category);
  if (!products.length) return ctx.reply(t(lang, 'noProducts'), buildMainMenu(lang));

  for (const p of products) {
    await renderProductCard(ctx, p, lang);
  }

  const catIndex = category && ctx.session?.catList ? ctx.session.catList.indexOf(category) : -1;
  const catSuffix = catIndex >= 0 ? `_c${catIndex}` : '';

  const navButtons = [];
  if (hasPrev) navButtons.push(Markup.button.callback('⬅️', `page_${page - 1}${catSuffix}`));
  if (hasNext) navButtons.push(Markup.button.callback('➡️', `page_${page + 1}${catSuffix}`));
  if (navButtons.length) await ctx.reply(t(lang, 'pageNav'), Markup.inlineKeyboard(navButtons));

  await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
}

bot.action(/^page_(\d+)(?:_c(\d+))?$/, (ctx) => {
  ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10);
  const category =
    ctx.match[2] !== undefined ? ctx.session?.catList?.[parseInt(ctx.match[2], 10)] || null : null;
  sendCatalogPage(ctx, page, category);
});

// === Категории / Categories ===

bot.hears([t('ru', 'btnCategories'), t('en', 'btnCategories')], async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  const rows = db
    .prepare('SELECT DISTINCT category, category_en FROM products WHERE category IS NOT NULL ORDER BY category')
    .all();
  if (!rows.length) return ctx.reply(t(lang, 'noCategories'), buildMainMenu(lang));
  ctx.session.catList = rows.map((r) => r.category); // фильтруем всегда по русскому значению в БД
  const buttons = rows.map((r, i) => [
    Markup.button.callback((lang === 'en' && r.category_en) || r.category, `cat_${i}`),
  ]);
  await ctx.reply(t(lang, 'categoriesPrompt'), Markup.inlineKeyboard(buttons));
  await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
});

bot.action(/^cat_(\d+)$/, (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  ctx.answerCbQuery();
  const category = ctx.session?.catList?.[parseInt(ctx.match[1], 10)];
  if (!category) return ctx.reply(t(lang, 'categoriesStale'));
  sendCatalogPage(ctx, 0, category);
});

// === Поиск по названию / Search ===

bot.hears([t('ru', 'btnSearch'), t('en', 'btnSearch')], (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  ctx.session.awaitingSearch = true;
  ctx.reply(t(lang, 'searchPrompt'), buildMainMenu(lang));
});

bot.on('text', async (ctx, next) => {
  const lang = db.getLang(ctx.chat.id);

  if (ctx.session?.awaitingSearch) {
    ctx.session.awaitingSearch = false;
    const term = ctx.message.text.trim();
    if (!term) return;
    const products = db
      .prepare('SELECT * FROM products WHERE name LIKE ? OR name_en LIKE ? ORDER BY name LIMIT 20')
      .all(`%${term}%`, `%${term}%`);
    if (!products.length) return ctx.reply(t(lang, 'searchNoResults', term), buildMainMenu(lang));
    for (const p of products) {
      await renderProductCard(ctx, p, lang);
    }
    await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
    return;
  }

  if (ctx.session?.awaitingAiConsult) {
    ctx.session.awaitingAiConsult = false;
    const query = ctx.message.text.trim();
    if (!query) return;

    const thinkingMsg = await ctx.reply(t(lang, 'aiThinking'));
    try {
      const { adviceText, productIds } = await getAiRecommendation(query, lang);
      await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(adviceText || t(lang, 'aiNoRecommendation'));

      for (const id of productIds) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (p) await renderProductCard(ctx, p, lang);
      }
    } catch (err) {
      console.error('Ошибка AI-консультанта:', err.response?.data || err.message);
      await ctx.reply(t(lang, 'aiError'));
    }
    await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
    return;
  }

  return next();
});

// === AI-консультант по подбору радиатора / AI product-pick consultant ===

bot.hears([t('ru', 'btnAiPick'), t('en', 'btnAiPick')], (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  ctx.session.awaitingAiConsult = true;
  ctx.reply(t(lang, 'aiPickPrompt'), buildMainMenu(lang));
});

async function getAiRecommendation(userQuery, lang) {
  const products = db
    .prepare('SELECT id, name, description, price, category, stock FROM products WHERE stock > 0')
    .all();

  const catalogText = products
    .map((p) => `#${p.id} ${p.name} (${p.category}) — ${formatPrice(p.price)}. ${p.description || ''}`)
    .join('\n');

  const replyLanguageInstruction =
    lang === 'en' ? 'Answer in English, friendly and to the point, no markdown formatting.' : 'Отвечай по-русски, дружелюбно и по делу, без markdown-разметки.';

  const systemPrompt =
    'Ты — консультант интернет-магазина отопительного оборудования RadiatorPro. ' +
    'Ниже дан текущий каталог товаров в наличии. Подбери покупателю 1-3 подходящих товара ' +
    'по его описанию (площадь и тип помещения, тип отопления, бюджет, стиль и т.п.) и кратко объясни выбор. ' +
    `${replyLanguageInstruction} ` +
    'В самом конце ответа ОБЯЗАТЕЛЬНО добавь отдельной строкой формата ' +
    '"РЕКОМЕНДАЦИИ: #id1, #id2" с ID рекомендованных товаров из каталога.\n\n' +
    `Каталог:\n${catalogText}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 1500,
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

  console.log('AI-консультант, полный response.data:', JSON.stringify(response.data));
  // ответ модели может содержать служебный блок "thinking" перед текстом —
  // берём именно блок с type === 'text', а не первый элемент массива
  const textBlock = response.data.content?.find((b) => b.type === 'text');
  const raw = textBlock?.text || '';
  console.log('AI-консультант, сырой ответ:', raw);

  // ищем строку с рекомендациями в любом месте текста (не только в самом конце)
  const match = raw.match(/РЕКОМЕНДАЦИИ:\s*([^\n]*)/i);
  let productIds = [];
  let adviceText = raw.trim();

  if (match) {
    productIds = [...match[1].matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10));
    adviceText = raw.slice(0, match.index).trim();
  }

  if (!adviceText) {
    adviceText = productIds.length ? t(lang, 'aiHere') : t(lang, 'aiNoMatch');
  }

  return { adviceText, productIds };
}

// === Корзина / Cart ===

bot.action(/add_(\d+)/, (ctx) => {
  const lang = db.getLang(ctx.chat.id);
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
  ctx.answerCbQuery(t(lang, 'addedToCart'));
});

bot.hears([t('ru', 'btnCart'), t('en', 'btnCart')], showCart);
bot.command('cart', showCart);

async function showCart(ctx) {
  const lang = db.getLang(ctx.chat.id);
  const chatId = ctx.chat.id;
  const { items, total } = getCart(chatId);
  if (!items.length) return ctx.reply(t(lang, 'cartEmpty'), buildMainMenu(lang));

  let text = t(lang, 'cartTitle');
  const buttons = [];
  for (const i of items) {
    const displayName = (lang === 'en' && i.name_en) || i.name;
    text += `${displayName} x${i.quantity} — ${formatPrice(i.price * i.quantity)}\n`;
    buttons.push([
      Markup.button.callback(`➖ ${displayName}`, `dec_${i.product_id}`),
      Markup.button.callback(`❌`, `rm_${i.product_id}`),
    ]);
  }
  text += t(lang, 'cartTotal', formatPrice(total));
  buttons.push([Markup.button.callback(t(lang, 'checkoutButton'), 'checkout_start')]);

  await ctx.reply(text, Markup.inlineKeyboard(buttons));
  await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
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
  const lang = db.getLang(ctx.chat.id);
  const productId = parseInt(ctx.match[1], 10);
  db.prepare('DELETE FROM cart_items WHERE chat_id = ? AND product_id = ?').run(
    ctx.chat.id,
    productId
  );
  ctx.answerCbQuery(t(lang, 'removed'));
  showCart(ctx);
});

// === История заказов покупателя / Buyer's order history ===

bot.hears([t('ru', 'btnMyOrders'), t('en', 'btnMyOrders')], showMyOrders);
bot.command('myorders', showMyOrders);

async function showMyOrders(ctx) {
  const lang = db.getLang(ctx.chat.id);
  const orders = db
    .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 10')
    .all(ctx.chat.id);

  if (!orders.length) return ctx.reply(t(lang, 'ordersEmpty'), buildMainMenu(lang));

  const itemsStmt = db.prepare(
    `SELECT oi.quantity, p.name, p.name_en FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`
  );

  await ctx.reply(t(lang, 'ordersTitle', orders.length), { parse_mode: 'HTML' });

  for (const o of orders) {
    const statusKey = (o.status || '').split(':')[0];
    const statusLabel = t(lang, 'orderStatus')[statusKey] || statusKey;
    const items = itemsStmt.all(o.id);
    const itemsText = items
      .map((i) => `• ${(lang === 'en' && i.name_en) || i.name} ×${i.quantity}`)
      .join('\n');
    const date = (o.created_at || '').slice(0, 16).replace('T', ' ');
    const cityDisplay = db.translateCity(o.delivery_city, lang);

    let text = `<b>${t(lang, 'orderNumber', o.id)}</b>\n`;
    text += `${statusLabel}\n\n`;
    text += `${itemsText}\n\n`;
    if (o.discount_percent > 0) {
      text += `${t(lang, 'promoLine', o.promo_code, o.discount_percent)}\n`;
    }
    if (o.delivery_cost > 0) {
      text += `${t(lang, 'deliveryLine', cityDisplay, formatPrice(o.delivery_cost))}\n`;
    } else if (o.delivery_city === null && (o.address === 'Самовывоз' || o.address === 'Pickup')) {
      text += `${t(lang, 'pickupLine')}\n`;
    }
    text += `${t(lang, 'sumLabel')} <b>${formatPrice(o.total)}</b>\n`;
    text += `${t(lang, 'addressLabel')} ${o.address || '—'}\n`;
    text += `🕐 ${date}`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  await ctx.reply(t(lang, 'menuPrompt'), buildMainMenu(lang));
}

// === Оформление заказа / Checkout ===

bot.action('checkout_start', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('checkout-wizard');
});

// === Админ-панель (только для владельца, тексты на русском — это внутренний инструмент) ===
// === Owner admin commands (Russian only — internal tooling for the shop owner) ===

const ORDER_STATUS_LABEL = {
  pending: '⏳ ожидает оплаты',
  awaiting_payment: '⏳ ожидает оплаты',
  paid: '✅ оплачен',
  shipped: '🚚 отправлен',
  delivered: '📦 доставлен',
  cancelled: '❌ отменён',
};

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
    if (o.delivery_cost > 0) {
      text += `🚚 Доставка${o.delivery_city ? ` (${o.delivery_city})` : ''}: ${formatPrice(o.delivery_cost)}\n`;
    } else if (o.delivery_city === null && (o.address === 'Самовывоз' || o.address === 'Pickup')) {
      text += `🚚 Самовывоз\n`;
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

// === Тарифы доставки (только для владельца) ===

bot.command('adddelivery', isOwner, (ctx) => {
  // формат: /adddelivery Город Цена  (например: /adddelivery Казань 900)
  const raw = ctx.message.text.replace('/adddelivery', '').trim();
  const parts = raw.split(' ');
  const priceRub = parts.pop();
  const city = parts.join(' ').trim();
  const price = parseFloat(priceRub);
  if (!city || !priceRub || Number.isNaN(price) || price < 0) {
    return ctx.reply('Формат: /adddelivery Город Цена\nНапример: /adddelivery Казань 900');
  }
  db.prepare(
    `INSERT INTO delivery_rates (city, price) VALUES (?, ?)
     ON CONFLICT(city) DO UPDATE SET price = excluded.price, active = 1`
  ).run(city, Math.round(price * 100));
  ctx.reply(`Тариф для города "${city}" установлен: ${Math.round(price)} ₽.`);
});

bot.command('deliveries', isOwner, (ctx) => {
  const rates = db.prepare('SELECT * FROM delivery_rates ORDER BY city').all();
  if (!rates.length) return ctx.reply('Тарифы доставки пока не заданы.');
  const text = rates
    .map((r) => `${r.city} — ${formatPrice(r.price)}${r.active ? '' : ' (выключен)'}`)
    .join('\n');
  ctx.reply(
    `${text}\n\nДля городов не из списка действует тариф по умолчанию: ${formatPrice(
      db.DEFAULT_DELIVERY_PRICE
    )}.`
  );
});

bot.command('deldelivery', isOwner, (ctx) => {
  // формат: /deldelivery Город
  const city = ctx.message.text.replace('/deldelivery', '').trim();
  if (!city) return ctx.reply('Формат: /deldelivery Город');
  const result = db
    .prepare('UPDATE delivery_rates SET active = 0 WHERE city = ? COLLATE NOCASE')
    .run(city);
  ctx.reply(
    result.changes ? `Тариф для города "${city}" выключен.` : `Город "${city}" не найден в списке тарифов.`
  );
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
  if (order) {
    const buyerLang = db.getLang(order.chat_id);
    bot.telegram.sendMessage(order.chat_id, t(buyerLang, 'orderShipped', orderId));
  }
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
