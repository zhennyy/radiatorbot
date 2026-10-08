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

// TELEGRAM_API_ROOT — посредник для Telegram (нужен, если сервер в России)
const bot = new Telegraf(process.env.BOT_TOKEN, process.env.TELEGRAM_API_ROOT ? { telegram: { apiRoot: process.env.TELEGRAM_API_ROOT.replace(/\/*$/, '/') } } : {});

// ttl: брошенное оформление само забывается через 30 минут
const stage = new Scenes.Stage([checkoutScene], { ttl: 30 * 60 });
bot.use(session());
// Любая команда (/start, /cart…) во время оформления в чате — выходим из оформления, а не «глотаем» её
bot.use((ctx, next) => {
  if (ctx.session?.__scenes?.current && ctx.message?.text?.startsWith('/')) delete ctx.session.__scenes;
  return next();
});
// Кнопки статусов, ответы покупателям и оценки работают всегда — даже посреди оформления
require('./chat').setupActions(bot);
bot.use(stage.middleware());

function formatPrice(kopecks) {
  return Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
}

// Постоянная клавиатура снизу — переприсылаем её после каждого раздела,
// чтобы она не пропадала, даже если Telegram-клиент её случайно скрыл.
// Покупатель может переключить язык интерфейса кнопкой "🌐 Язык / Language" —
// эта кнопка и её обработчики распознают нажатие независимо от текущего языка.
// Адрес витрины: SHOP_URL из .env (на сервере — https://<бот>.botforall.ru/shop/); RAILWAY_PUBLIC_DOMAIN — запасной вариант для облачных хостингов
const SHOP_URL =
  process.env.SHOP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/shop/` : null);

function buildMainMenu(lang) {
  // Есть витрина — нижнего меню нет: всё внутри мини-приложения (кнопка «🛍 Магазин» слева от поля ввода).
  // Старую клавиатуру у покупателей при этом убираем.
  if (SHOP_URL) return Markup.removeKeyboard();
  const catalogBtn = t(lang, 'btnCatalog');
  return Markup.keyboard([
    [catalogBtn, t(lang, 'btnSearch'), t(lang, 'btnCart')],
    [t(lang, 'btnCategories'), t(lang, 'btnMyOrders'), t(lang, 'btnAiPick')],
    [t(lang, 'btnLanguage')],
  ]).resize();
}

// Кнопки магазина под приветствием — крупные, чтобы не искать маленькую кнопку у поля ввода
function shopUrl(tab) {
  if (!tab) return SHOP_URL;
  return SHOP_URL + (SHOP_URL.includes('?') ? '&' : '?') + 'tab=' + tab;
}
function shopKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp(t(lang, 'openShopBtn'), shopUrl())],
    [Markup.button.webApp(t(lang, 'myOrdersBtn'), shopUrl('orders')), Markup.button.webApp(t(lang, 'aiPickBtn'), shopUrl('ai'))],
  ]);
}
async function dropOldKeyboard(ctx) {
  if (ctx.session.kbRemoved) return;
  ctx.session.kbRemoved = true;
  const m = await ctx.reply('✨', Markup.removeKeyboard()).catch(() => null);
  if (m) ctx.deleteMessage(m.message_id).catch(() => {});
}

bot.start(async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  const name = db.getName(ctx.chat.id);
  if (!name) {
    ctx.session.awaitingName = true;
    if (SHOP_URL) {
      ctx.session.kbRemoved = true;
      await ctx.reply(t(lang, 'welcomeShop'), Markup.removeKeyboard());
    } else {
      await ctx.reply(t(lang, 'welcome'), buildMainMenu(lang));
    }
    await ctx.reply(t(lang, 'askName'));
    return;
  }
  if (!SHOP_URL) return ctx.reply(t(lang, 'welcomeBack', name), buildMainMenu(lang));
  await dropOldKeyboard(ctx);
  await ctx.reply(t(lang, 'welcomeBackShop', name), shopKeyboard(lang));
});

// === Переключение языка / Language switch ===

bot.hears([t('ru', 'btnLanguage'), t('en', 'btnLanguage')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
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

bot.hears([t('ru', 'btnCatalog'), t('en', 'btnCatalog')], async (ctx) => {
  if (!SHOP_URL) return sendCarousel(ctx, -1, 0);
  return shopHint(ctx);
});

// Всё теперь внутри витрины: на старые кнопки отвечаем подсказкой и кнопкой «Открыть магазин»
async function shopHint(ctx) {
  const lang = db.getLang(ctx.chat.id);
  await ctx.reply(t(lang, 'shopMoved'), shopKeyboard(lang));
  await dropOldKeyboard(ctx);
}
bot.command('catalog', (ctx) => sendCarousel(ctx, -1, 0));

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

// === Каталог-карусель / Catalog carousel ===
// Одна карточка товара, которая меняется на месте при листании ◀ ▶ —
// чат не засоряется десятками сообщений. Категории — кнопками под карточкой.

function catalogCategories() {
  return db
    .prepare('SELECT DISTINCT category, category_en FROM products WHERE category IS NOT NULL ORDER BY category')
    .all();
}

function cartCount(chatId) {
  return db.prepare('SELECT COALESCE(SUM(quantity), 0) AS c FROM cart_items WHERE chat_id = ?').get(chatId).c;
}

function qtyInCart(chatId, productId) {
  const row = db.prepare('SELECT quantity FROM cart_items WHERE chat_id = ? AND product_id = ?').get(chatId, productId);
  return row ? row.quantity : 0;
}

// ci — номер категории в catalogCategories() (-1 = все), idx — номер товара в списке
function carouselView(chatId, lang, ci, idx) {
  const cats = catalogCategories();
  const cat = ci >= 0 && cats[ci] ? cats[ci].category : null;
  if (!cat) ci = -1;
  const products = cat
    ? db.prepare('SELECT * FROM products WHERE category = ? ORDER BY stock = 0, id').all(cat)
    : db.prepare('SELECT * FROM products ORDER BY stock = 0, id').all();
  if (!products.length) return null;

  const n = products.length;
  idx = ((idx % n) + n) % n; // листаем по кругу
  const p = products[idx];

  const name = (lang === 'en' && p.name_en) || p.name;
  const description = (lang === 'en' && p.description_en) || p.description;
  const category = (lang === 'en' && p.category_en) || p.category;
  // Аккуратная карточка: категория мелко сверху, название, описание, цена и наличие
  const caption =
    (category ? `<i>${escapeHtml(category)}</i>\n` : '') +
    `<b>${escapeHtml(name)}</b>\n` +
    (description ? `${escapeHtml(description)}\n` : '') +
    `\n💰 <b>${formatPrice(p.price)}</b>\n` +
    (p.stock > 0 ? t(lang, 'inStock', p.stock) : t(lang, 'outOfStock'));

  const btn = Markup.button.callback;
  const rows = [];
  const q = qtyInCart(chatId, p.id);
  if (p.stock > 0) {
    rows.push([
      btn(q ? t(lang, 'inCartQty', q) : `${t(lang, 'addToCart')} · ${formatPrice(p.price)}`, `ca:${ci}:${idx}:${p.id}`),
    ]);
  } else {
    rows.push([btn(t(lang, 'outOfStock'), 'cnoop')]);
  }
  if (n > 1) {
    rows.push([btn('◀️', `cv:${ci}:${idx - 1}`), btn(`${idx + 1} / ${n}`, 'cnoop'), btn('▶️', `cv:${ci}:${idx + 1}`)]);
  }
  if (cats.length > 1) {
    const chips = [{ label: t(lang, 'allCategories'), i: -1 }].concat(
      cats.map((c, i) => ({ label: (lang === 'en' && c.category_en) || c.category, i }))
    );
    for (let k = 0; k < chips.length; k += 2) {
      rows.push(
        chips.slice(k, k + 2).map((c) => btn(c.i === ci ? `• ${c.label} •` : c.label, `cv:${c.i}:0`))
      );
    }
  }
  const inCartTotal = cartCount(chatId);
  if (inCartTotal > 0) rows.push([btn(t(lang, 'cartShort', inCartTotal), 'copencart')]);

  return { p, caption, markup: Markup.inlineKeyboard(rows).reply_markup };
}

async function sendCarousel(ctx, ci = -1, idx = 0) {
  const lang = db.getLang(ctx.chat.id);
  const v = carouselView(ctx.chat.id, lang, ci, idx);
  if (!v) return ctx.reply(t(lang, 'noProducts'), buildMainMenu(lang));
  const extra = { parse_mode: 'HTML', reply_markup: v.markup };
  if (v.p.photo_url) {
    return ctx.replyWithPhoto(v.p.photo_url, { caption: v.caption, ...extra }).catch(() => ctx.reply(v.caption, extra));
  }
  return ctx.reply(v.caption, extra);
}

// Перерисовать карусель в том же сообщении
async function updateCarousel(ctx, ci, idx) {
  const lang = db.getLang(ctx.chat.id);
  const v = carouselView(ctx.chat.id, lang, ci, idx);
  if (!v) return;
  const isPhoto = Boolean(ctx.callbackQuery.message && ctx.callbackQuery.message.photo);
  try {
    if (v.p.photo_url && isPhoto) {
      await ctx.editMessageMedia(
        { type: 'photo', media: v.p.photo_url, caption: v.caption, parse_mode: 'HTML' },
        { reply_markup: v.markup }
      );
    } else if (!v.p.photo_url && !isPhoto) {
      await ctx.editMessageText(v.caption, { parse_mode: 'HTML', reply_markup: v.markup });
    } else {
      throw new Error('message type changed');
    }
  } catch (e) {
    if (/not modified/i.test(e.message)) return;
    // фото ↔ текст нельзя поменять правкой — заменяем сообщение новым
    await ctx.deleteMessage().catch(() => {});
    await sendCarousel(ctx, ci, idx);
  }
}

bot.action(/^cv:(-?\d+):(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await updateCarousel(ctx, parseInt(ctx.match[1], 10), parseInt(ctx.match[2], 10));
});

bot.action(/^ca:(-?\d+):(-?\d+):(\d+)$/, async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  const ci = parseInt(ctx.match[1], 10);
  const idx = parseInt(ctx.match[2], 10);
  const productId = parseInt(ctx.match[3], 10);
  const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
  const q = qtyInCart(ctx.chat.id, productId);
  if (!p || p.stock <= q) return ctx.answerCbQuery(t(lang, 'noMoreStock')).catch(() => {});
  if (q) {
    db.prepare('UPDATE cart_items SET quantity = quantity + 1 WHERE chat_id = ? AND product_id = ?').run(ctx.chat.id, productId);
  } else {
    db.prepare('INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?,?,1)').run(ctx.chat.id, productId);
  }
  await ctx.answerCbQuery(t(lang, 'addedToCart')).catch(() => {});
  const v = carouselView(ctx.chat.id, lang, ci, idx);
  if (v) await ctx.editMessageReplyMarkup(v.markup).catch(() => {});
});

// кнопки из сообщений с прежней сеткой 2×2 — открываем обычную карточку
bot.action(/^cg:(-?\d+):(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await updateCarousel(ctx, +ctx.match[1], +ctx.match[2] * 4);
});
bot.action(/^cd:(-?\d+):(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await updateCarousel(ctx, +ctx.match[1], +ctx.match[2]);
});

bot.action('cnoop', (ctx) => ctx.answerCbQuery().catch(() => {}));
bot.action('copencart', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCart(ctx);
});

// старые кнопки «⬅️ ➡️» из прежних сообщений — открываем карусель
bot.action(/^page_(\d+)(?:_c(\d+))?$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  return sendCarousel(ctx, -1, 0);
});

// === Категории / Categories ===

bot.hears([t('ru', 'btnCategories'), t('en', 'btnCategories')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
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
});

bot.action(/^cat_(\d+)$/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  // номера категорий совпадают с catalogCategories() — тот же запрос и порядок
  return sendCarousel(ctx, parseInt(ctx.match[1], 10), 0);
});

// === Поиск по названию / Search ===

bot.hears([t('ru', 'btnSearch'), t('en', 'btnSearch')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
bot.hears([t('ru', 'btnSearch'), t('en', 'btnSearch')], (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  ctx.session.awaitingSearch = true;
  ctx.reply(t(lang, 'searchPrompt'), buildMainMenu(lang));
});

bot.on('text', async (ctx, next) => {
  const lang = db.getLang(ctx.chat.id);

  if (ctx.session?.awaitingName) {
    ctx.session.awaitingName = false;
    const name = ctx.message.text.trim().slice(0, 64);
    if (!name) {
      ctx.session.awaitingName = true;
      return ctx.reply(t(lang, 'askName'));
    }
    // Вместо имени сразу написали вопрос — не записываем его как имя: берём имя из Telegram,
    // а сообщение передаём менеджеру
    if (name.length > 30 || /[?!.,:;()\d]/.test(name) || name.split(/\s+/).length > 3) {
      db.setName(ctx.chat.id, (ctx.from.first_name || '').slice(0, 64) || '—');
      if (SHOP_URL) await ctx.reply(t(lang, 'nameSavedShop', ctx.from.first_name || ''), shopKeyboard(lang));
      return next();
    }
    db.setName(ctx.chat.id, name);
    await ctx.reply(SHOP_URL ? t(lang, 'nameSavedShop', name) : t(lang, 'nameSaved', name), SHOP_URL ? shopKeyboard(lang) : buildMainMenu(lang));
    return;
  }

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
    return;
  }

  if (ctx.session?.awaitingAiConsult) {
    ctx.session.awaitingAiConsult = false;
    const query = ctx.message.text.trim();
    if (!query) return;

    const thinkingMsg = await ctx.reply(t(lang, 'aiThinking'));
    try {
      const { adviceText, productIds } = await getAiRecommendation(query.slice(0, 500), lang, ctx.from.id);
      await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      await ctx.reply(adviceText || t(lang, 'aiNoRecommendation'));

      for (const id of productIds) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (p) await renderProductCard(ctx, p, lang);
      }
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      if (err.code === 'AI_LIMIT') return ctx.reply(lang === 'en' ? 'The AI consultant has reached its limit for now — please try again later.' : 'ИИ-консультант на сегодня устал 🙂 Попробуйте позже.');
      console.error('Ошибка AI-консультанта:', err.response?.status || err.message);
      await ctx.reply(t(lang, 'aiError'));
    }
    return;
  }

  return next();
});

// === AI-консультант по подбору радиатора / AI product-pick consultant ===

bot.hears([t('ru', 'btnAiPick'), t('en', 'btnAiPick')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
bot.hears([t('ru', 'btnAiPick'), t('en', 'btnAiPick')], (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  ctx.session.awaitingAiConsult = true;
  ctx.reply(t(lang, 'aiPickPrompt'), buildMainMenu(lang));
});

// Лимиты на ИИ, чтобы никто не «накрутил» счёт за Claude:
// на человека — не больше AI_USER_DAY запросов в сутки, на всех — не больше AI_GLOBAL_HOUR в час.
const AI_USER_DAY = Number(process.env.AI_USER_DAY || 30);
const AI_GLOBAL_HOUR = Number(process.env.AI_GLOBAL_HOUR || 200);
const aiUse = new Map(); // userId -> { day, n }
let aiHour = { h: 0, n: 0 };
function aiQuota(userId) {
  const day = new Date().toISOString().slice(0, 10), h = Math.floor(Date.now() / 3600000);
  if (aiHour.h !== h) aiHour = { h, n: 0 };
  const u = aiUse.get(String(userId));
  const cur = u && u.day === day ? u : { day, n: 0 };
  if (cur.n >= AI_USER_DAY || aiHour.n >= AI_GLOBAL_HOUR) { const e = new Error('AI_LIMIT'); e.code = 'AI_LIMIT'; throw e; }
  cur.n++; aiHour.n++;
  if (aiUse.size > 5000) aiUse.clear(); // раз в сутки ключи всё равно обновятся
  aiUse.set(String(userId), cur);
}

async function getAiRecommendation(userQuery, lang, userId = 'chat') {
  aiQuota(userId);
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
    // ANTHROPIC_BASE_URL — свой адрес-посредник для Claude (нужен на серверах в России)
    (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages',
    {
      model: 'claude-sonnet-5',
      max_tokens: 800,
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

  // ответ модели может содержать служебный блок "thinking" перед текстом —
  // берём именно блок с type === 'text', а не первый элемент массива
  const textBlock = response.data.content?.find((b) => b.type === 'text');
  const raw = textBlock?.text || '';

  // ищем строку с рекомендациями в любом месте текста (не только в самом конце)
  const match = raw.match(/РЕКОМЕНДАЦИИ:\s*([^\n]*)/i);
  let productIds = [];
  let adviceText = raw.trim();

  if (match) {
    const allowed = new Set(products.map((p) => p.id)); // только товары из каталога, который видел ИИ
    productIds = [...new Set([...match[1].matchAll(/(\d+)/g)].map((m) => parseInt(m[1], 10)))].filter((id) => allowed.has(id)).slice(0, 3);
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

bot.hears([t('ru', 'btnCart'), t('en', 'btnCart')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
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

bot.hears([t('ru', 'btnMyOrders'), t('en', 'btnMyOrders')], (ctx, next) => (SHOP_URL ? shopHint(ctx) : next()));
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
      .map((i) => `• ${escapeHtml((lang === 'en' && i.name_en) || i.name)} ×${i.quantity}`)
      .join('\n');
    const date = (o.created_at || '').slice(0, 16).replace('T', ' ');
    const cityDisplay = db.translateCity(o.delivery_city, lang);

    let text = `<b>${t(lang, 'orderNumber', o.order_code || o.id)}</b>\n`;
    text += `${statusLabel}\n\n`;
    text += `${itemsText}\n\n`;
    if (o.discount_percent > 0) {
      text += `${t(lang, 'promoLine', escapeHtml(o.promo_code || ''), o.discount_percent)}\n`;
    }
    if (o.delivery_cost > 0) {
      text += `${t(lang, 'deliveryLine', escapeHtml(cityDisplay || ''), formatPrice(o.delivery_cost))}\n`;
    } else if (o.delivery_city === null && (o.address === 'Самовывоз' || o.address === 'Pickup')) {
      text += `${t(lang, 'pickupLine')}\n`;
    }
    text += `${t(lang, 'sumLabel')} <b>${formatPrice(o.total)}</b>\n`;
    text += `${t(lang, 'addressLabel')} ${escapeHtml(o.address || '—')}\n`;
    text += `🕐 ${date}`;

    await ctx.reply(text, { parse_mode: 'HTML' });
  }

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
      text += `Промокод «${escapeHtml(o.promo_code || '')}»: −${o.discount_percent}%\n`;
    }
    if (o.delivery_cost > 0) {
      text += `🚚 Доставка${o.delivery_city ? ` (${escapeHtml(o.delivery_city)})` : ''}: ${formatPrice(o.delivery_cost)}\n`;
    } else if (o.delivery_city === null && (o.address === 'Самовывоз' || o.address === 'Pickup')) {
      text += `🚚 Самовывоз\n`;
    }
    text += `💰 Сумма: <b>${formatPrice(o.total)}</b>\n`;
    text += `📍 ${escapeHtml(o.address || "—")}\n`;
    text += `🕐 ${date}`;

    await ctx.reply(text, { parse_mode: 'HTML' }).catch((e) => console.error('/orders:', e.message));
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

bot.command('markshipped', isOwner, async (ctx) => {
  // формат: /markshipped <id_заказа>
  const [, orderId] = ctx.message.text.split(' ');
  if (!orderId) return ctx.reply('Формат: /markshipped <id_заказа>');
  try {
    const o = await require('./orders').changeStatus(bot, parseInt(orderId, 10), 'shipped');
    ctx.reply(`Заказ № ${o.code} помечен как отправленный, покупателю написали.`);
  } catch (e) { ctx.reply(e.message); }
});

// Переписка с покупателями — регистрируем последней, после всех кнопок и сценариев
require('./chat').setupRelay(bot);

// Ошибка в одном обработчике не должна ронять бота целиком
bot.catch((err, ctx) => console.error('Ошибка бота:', ctx?.updateType, err?.message || err));
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e?.message || e));

bot.launch();
console.log('Бот запущен');

// Синяя кнопка «🛍 Магазин» слева от поля ввода — открывает витрину у всех покупателей
if (SHOP_URL) {
  bot.telegram
    .setChatMenuButton({ menuButton: { type: 'web_app', text: '🛍 Магазин', web_app: { url: SHOP_URL } } })
    .catch((e) => console.error('Не удалось поставить кнопку «Магазин»:', e.message));
}

const { startWebhookServer } = require('./webhook');
startWebhookServer(bot, {
  // AI-подбор из витрины — тот же консультант, что и в чате
  aiPick: (query, lang, userId) => getAiRecommendation(query, lang, userId),
  // витрина просит показать корзину в чате — используем ту же функцию, что и кнопка «🛒 Корзина»
  showCartFor: (chatId) =>
    showCart({ chat: { id: chatId }, reply: (text, extra) => bot.telegram.sendMessage(chatId, text, extra) }),
});

// проверка низкого остатка раз в час
setInterval(() => checkLowStock(bot), 1000 * 60 * 60);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
