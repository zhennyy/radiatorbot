// webhook.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const basicAuth = require('express-basic-auth');
const db = require('./db');
const { checkLowStock } = require('./notify');
const { t } = require('./i18n');
const crypto = require('crypto');
const axios = require('axios');
const { getPayment } = require('./payments/yookassa');
const orders = require('./orders');
const { sendToBuyer } = require('./chat');

// фото товаров храним рядом с базой — на Railway это подключённый Volume,
// так что файлы переживают редеплой (в отличие от остальной файловой системы)
const dbDir = path.dirname(path.resolve(process.env.DB_PATH || 'shop.db'));
const uploadsDir = path.join(dbDir, 'uploads');
// Фото товаров, которые лежат в самом проекте (видно в VS Code и на GitHub)
const photosDir = path.join(__dirname, 'photos');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 МБ
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Файл должен быть изображением.'));
    cb(null, true);
  },
});

// ===== Все фото товаров храним у себя: папка uploads на постоянном диске Railway =====
// Если у товара ссылка на чужой сайт — скачиваем картинку один раз и дальше показываем свою копию.
const PUBLIC_BASE = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const isLocalPhoto = (url) => {
  const m = String(url || '').match(/\/(uploads|photos)\/([^/?#]+)$/);
  return Boolean(m) && fs.existsSync(path.join(m[1] === 'photos' ? photosDir : uploadsDir, m[2]));
};

async function localizePhoto(id, url) {
  if (!url || isLocalPhoto(url) || !/^https?:\/\//i.test(url) || !PUBLIC_BASE) return false;
  const r = await require('axios').get(url, {
    responseType: 'arraybuffer', timeout: 20000, maxContentLength: 15 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (RadiatorPro shop)', Accept: 'image/*' },
  });
  const type = String(r.headers['content-type'] || '');
  if (!type.startsWith('image/')) throw new Error('по ссылке не картинка (' + type + ')');
  const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
  const name = `p${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, name), Buffer.from(r.data));
  db.prepare('UPDATE products SET photo_url = ? WHERE id = ? AND photo_url = ?').run(`${PUBLIC_BASE}/uploads/${name}`, id, url);
  return true;
}

let localizing = null;
function localizeAllPhotos() {
  if (localizing) return localizing;
  localizing = (async () => {
    const rows = db.prepare('SELECT id, name, photo_url FROM products WHERE photo_url IS NOT NULL').all();
    for (const p of rows) {
      try {
        if (await localizePhoto(p.id, p.photo_url)) console.log(`Фото «${p.name}» сохранено на сервере`);
      } catch (e) {
        console.warn(`Фото «${p.name}» не скачалось: ${e.message}`);
      }
    }
  })().finally(() => { localizing = null; });
  return localizing;
}

// Разовые правки каталога (выполняются один раз — отметка лежит рядом с фото)
function runOnce(key, fn) {
  const mark = path.join(uploadsDir, `.done-${key}`);
  if (fs.existsSync(mark)) return;
  try { fn(); fs.writeFileSync(mark, new Date().toISOString()); } catch (e) { console.error('Разовая правка не прошла:', key, e.message); }
}
// Фото из папки проекта photos/: файл «<id товара>-название.jpg» один раз ставится товару.
// Если потом заменить фото в админке — новое фото не перезапишется при следующем запуске.
if (fs.existsSync(photosDir) && PUBLIC_BASE) {
  for (const file of fs.readdirSync(photosDir)) {
    const m = file.match(/^(\d+)-[\w.-]+\.(jpe?g|png|webp)$/i);
    if (!m) continue;
    runOnce(`photo-${file}`, () => {
      const r = db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(`${PUBLIC_BASE}/photos/${file}`, parseInt(m[1], 10));
      if (r.changes) console.log(`Фото из проекта: ${file}`);
    });
  }
}
runOnce('2026-10-01-catalog', () => {
  // убираем тестовый товар
  const test = db.prepare("SELECT id FROM products WHERE name = 'Радиатор Test' AND description = 'Тестовое описание'").get();
  if (test) {
    db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(test.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(test.id);
    console.log('Тестовый товар удалён');
  }
  // новое фото для Loft Black (сгенерировано), сервер скачает его к себе
  db.prepare("UPDATE products SET photo_url = ? WHERE name = 'Радиатор Loft Black'")
    .run('https://d8j0ntlcm91z4.cloudfront.net/user_3HReZJSR0X0kuSZvadzwtcMlq6H/hf_20261001_131313_2e81d209-1a55-474f-890e-5aa4c5c66469.png');
});

function startWebhookServer(bot, { showCartFor, aiPick } = {}) {
  const app = express();
  app.set('trust proxy', true); // за прокси Railway — иначе req.protocol всегда 'http'
  app.use(express.json());
  app.use('/uploads', express.static(uploadsDir)); // без авторизации — Telegram должен уметь их скачать
  app.use('/photos', express.static(photosDir, { maxAge: '7d' })); // фото из папки проекта

  // === Витрина (мини-приложение Telegram): /shop + /shop-api ===
  // Покупатель открывает /shop внутри Telegram. Каждый запрос подписан Telegram (initData) —
  // проверяем подпись токеном бота, так что чужую корзину изменить нельзя.
  app.use('/shop', express.static(path.join(__dirname, 'shop-public'), {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'), // Telegram не держит старую версию витрины
  }));

  function tgUser(req) {
    const raw = req.get('X-Init-Data') || '';
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const data = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const check = crypto.createHmac('sha256', secret).update(data).digest('hex');
    if (check.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null; // подпись старше суток
    try { return JSON.parse(params.get('user')); } catch { return null; }
  }
  const shopAuth = (req, res, next) => {
    const user = tgUser(req);
    if (!user || !user.id) return res.status(401).json({ error: 'Откройте магазин из Telegram' });
    req.chatId = user.id; // личный чат с ботом = id пользователя
    next();
  };
  const cartMap = (chatId) =>
    Object.fromEntries(db.prepare('SELECT product_id, quantity FROM cart_items WHERE chat_id = ?').all(chatId)
      .map((r) => [r.product_id, r.quantity]));

  app.get('/shop-api/catalog', shopAuth, (req, res) => {
    const products = db
      .prepare(`SELECT id, name, name_en, description, description_en, category, category_en, price, stock, photo_url
                FROM products ORDER BY stock = 0, category, id`)
      .all();
    // ссылку на фото не отдаём как есть: картинки идут через наш сервер (/shop-photo),
    // иначе часть сайтов-источников не показывает их внутри Telegram
    const list = products.map(({ photo_url, ...p }) => ({
      ...p,
      photo: photo_url ? `/shop-photo/${p.id}?v=${crypto.createHash('md5').update(photo_url).digest('hex').slice(0, 8)}` : null,
    }));
    const owner = isOwnerId(req.chatId);
    res.json({ lang: db.getLang(req.chatId), products: list, cart: cartMap(req.chatId), isOwner: owner, unread: owner ? db.unreadTotal() : 0 });
  });

  // Фото товара через наш сервер: скачиваем по ссылке из админки (или с нашего /uploads) и кэшируем в памяти
  const photoCache = new Map(); // id → { url, type, buf }
  app.get('/shop-photo/:id', async (req, res) => {
    const p = db.prepare('SELECT photo_url FROM products WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!p || !p.photo_url) return res.sendStatus(404);
    try {
      let hit = photoCache.get(req.params.id);
      if (!hit || hit.url !== p.photo_url) {
        const local = p.photo_url.match(/\/(uploads|photos)\/([^/?#]+)$/);
        const localPath = local && path.join(local[1] === 'photos' ? photosDir : uploadsDir, local[2]);
        if (localPath && fs.existsSync(localPath)) {
          return res.set('Cache-Control', 'public, max-age=86400').sendFile(localPath);
        }
        let url = p.photo_url;
        if (!/^https?:\/\//i.test(url)) url = await bot.telegram.getFileLink(url).then(String); // file_id из Telegram
        const r = await axios.get(url, {
          responseType: 'arraybuffer', timeout: 10000, maxContentLength: 10 * 1024 * 1024,
          headers: { 'User-Agent': 'Mozilla/5.0 (RadiatorPro shop)', Accept: 'image/*' },
        });
        const type = String(r.headers['content-type'] || '');
        if (!type.startsWith('image/')) throw new Error('не картинка: ' + type);
        hit = { url: p.photo_url, type, buf: Buffer.from(r.data) };
        if (photoCache.size > 200) photoCache.delete(photoCache.keys().next().value);
        photoCache.set(req.params.id, hit);
      }
      res.set({ 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' }).send(hit.buf);
    } catch (e) {
      console.warn(`Витрина: фото товара #${req.params.id} не загрузилось —`, e.message);
      res.sendStatus(404);
    }
  });

  app.post('/shop-api/cart', shopAuth, (req, res) => {
    const productId = parseInt(req.body.product_id, 10);
    const qty = Math.max(0, parseInt(req.body.qty, 10) || 0);
    const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
    if (!p) return res.status(404).json({ error: 'Товар не найден' });
    if (qty > p.stock) return res.status(400).json({ error: 'Больше нет в наличии' });
    if (qty === 0) {
      db.prepare('DELETE FROM cart_items WHERE chat_id = ? AND product_id = ?').run(req.chatId, productId);
    } else {
      db.prepare(`INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?,?,?)
                  ON CONFLICT(chat_id, product_id) DO UPDATE SET quantity = excluded.quantity`).run(req.chatId, productId, qty);
    }
    res.json({ ok: true, cart: cartMap(req.chatId) });
  });

  // Язык интерфейса (переключатель RU/EN в шапке витрины)
  app.post('/shop-api/lang', shopAuth, (req, res) => {
    const lang = req.body.lang === 'en' ? 'en' : 'ru';
    db.setLang(req.chatId, lang);
    res.json({ ok: true, lang });
  });

  // Мои заказы — последние 20 с составом
  app.get('/shop-api/orders', shopAuth, (req, res) => {
    const lang = db.getLang(req.chatId);
    const labels = t(lang, 'orderStatus') || {};
    const itemsStmt = db.prepare(
      `SELECT oi.quantity, oi.price, p.id, p.name, p.name_en FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`);
    const list = db
      .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.chatId)
      .map((o) => {
        const status = String(o.status || '').split(':')[0];
        return {
          id: o.id,
          code: o.order_code || String(o.id),
          status,
          statusLabel: orders.statusLabel({ base: status, delivery_city: o.delivery_city }, lang) || labels[status] || status,
          step: orders.FLOW.indexOf(status),
          pickup: !o.delivery_city,
          track: o.track || '',
          rating: o.rating || 0,
          can_pay: status === 'awaiting_payment',
          total: o.total,
          delivery_cost: o.delivery_cost || 0,
          address: o.address || '',
          created_at: o.created_at,
          items: itemsStmt.all(o.id).map((i) => ({
            id: i.id, qty: i.quantity, price: i.price,
            name: (lang === 'en' && i.name_en) || i.name || '—',
          })),
        };
      });
    res.json({ orders: list });
  });

  // AI-подбор: совет + id подходящих товаров (не чаще раза в 5 секунд на человека)
  const aiLast = new Map();
  app.post('/shop-api/ai', shopAuth, async (req, res) => {
    const query = String(req.body.query || '').trim().slice(0, 500);
    if (!query) return res.status(400).json({ error: 'Опишите, что нужно подобрать' });
    if (!aiPick) return res.status(503).json({ error: 'AI-подбор сейчас недоступен' });
    if (Date.now() - (aiLast.get(req.chatId) || 0) < 5000) return res.status(429).json({ error: 'Секунду, ещё думаю над прошлым запросом' });
    aiLast.set(req.chatId, Date.now());
    try {
      const lang = db.getLang(req.chatId);
      const { adviceText, productIds } = await aiPick(query, lang);
      res.json({ advice: adviceText, ids: productIds });
    } catch (e) {
      console.error('Витрина: AI-подбор не ответил', e.response?.data || e.message);
      res.status(502).json({ error: t(db.getLang(req.chatId), 'aiError') });
    }
  });

  // ===== Админка внутри витрины — только для владелицы (OWNER_CHAT_ID), без пароля:
  // Telegram сам подписывает, кто открыл приложение =====
  const isOwnerId = (id) => Boolean(process.env.OWNER_CHAT_ID) && String(id) === String(process.env.OWNER_CHAT_ID);
  const ownerOnly = (req, res, next) => (isOwnerId(req.chatId) ? next() : res.status(403).json({ error: 'Только для владелицы' }));
  const adm = [shopAuth, ownerOnly];
  const toKop = (v) => Math.round(parseFloat(String(v).replace(',', '.').replace(/\s/g, '')) * 100);
  const cleanProduct = (b) => {
    const p = {
      name: String(b.name || '').trim().slice(0, 120),
      description: String(b.description || '').trim().slice(0, 1000),
      price: toKop(b.price),
      stock: Math.max(0, parseInt(b.stock, 10) || 0),
      category: String(b.category || '').trim().slice(0, 60) || null,
      name_en: String(b.name_en || '').trim().slice(0, 120) || null,
      description_en: String(b.description_en || '').trim().slice(0, 1000) || null,
      category_en: String(b.category_en || '').trim().slice(0, 60) || null,
    };
    if (!p.name) throw new Error('Укажите название');
    if (!(p.price > 0)) throw new Error('Укажите цену');
    return p;
  };

  app.get('/shop-api/admin/products', ...adm, (req, res) => {
    const rows = db.prepare('SELECT * FROM products ORDER BY category, id').all();
    res.json({ products: rows.map(({ photo_url, ...p }) => ({ ...p, has_photo: Boolean(photo_url),
      photo: photo_url ? `/shop-photo/${p.id}?v=${crypto.createHash('md5').update(photo_url).digest('hex').slice(0, 8)}` : null })) });
  });

  app.post('/shop-api/admin/products', ...adm, (req, res) => {
    try {
      const p = cleanProduct(req.body);
      const r = db.prepare(`INSERT INTO products (name, description, price, stock, category, name_en, description_en, category_en)
                            VALUES (@name, @description, @price, @stock, @category, @name_en, @description_en, @category_en)`).run(p);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/shop-api/admin/products/:id', ...adm, (req, res) => {
    try {
      const p = cleanProduct(req.body);
      const r = db.prepare(`UPDATE products SET name=@name, description=@description, price=@price, stock=@stock, category=@category,
                            name_en=@name_en, description_en=@description_en, category_en=@category_en WHERE id=@id`)
        .run({ ...p, id: parseInt(req.params.id, 10) });
      if (!r.changes) return res.status(404).json({ error: 'Товар не найден' });
      if (p.stock > 0) checkLowStock(bot);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/shop-api/admin/products/:id/delete', ...adm, (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM cart_items WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // Фото с телефона: приходит готовый JPEG (витрина сама уменьшает его до 1600 px)
  app.post('/shop-api/admin/products/:id/photo', express.raw({ type: 'image/*', limit: '10mb' }), ...adm, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: 'Товар не найден' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Файл не получен' });
    const ext = /png/.test(req.get('content-type')) ? '.png' : /webp/.test(req.get('content-type')) ? '.webp' : '.jpg';
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(uploadsDir, name), req.body);
    const url = `${req.protocol}://${req.get('host')}/uploads/${name}`;
    db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(url, id);
    photoCache.delete(String(id));
    res.json({ ok: true });
  });

  // Фото по ссылке (https), например из генератора картинок — сервер сам скачает и покажет
  app.post('/shop-api/admin/products/:id/photo-url', ...adm, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const url = String(req.body.url || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 1000) return res.status(400).json({ error: 'Нужна ссылка, начинающаяся с https://' });
    const r = db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run(url, id);
    if (!r.changes) return res.status(404).json({ error: 'Товар не найден' });
    photoCache.delete(String(id));
    localizeAllPhotos()
      .then(() => res.json({ ok: true, local: isLocalPhoto(db.prepare('SELECT photo_url FROM products WHERE id = ?').get(id).photo_url) }))
      .catch(() => res.json({ ok: true, local: false }));
  });

  // Резервная копия: бот присылает владелице ZIP в чат (каталог, заказы, промокоды, доставка, фото)
  app.post('/shop-api/admin/backup', ...adm, async (req, res) => {
    try {
      const { makeBackup } = require('./backup');
      const b = makeBackup({ uploadsDir, photosDir });
      await bot.telegram.sendDocument(req.chatId, { source: b.buffer, filename: b.filename },
        { caption: `📦 Резервная копия магазина\nФото: ${b.photos} · заказы и каталог — в Excel-файлах внутри.\nХраните у себя: там адреса покупателей.` });
      res.json({ ok: true, size: b.buffer.length });
    } catch (e) {
      console.error('Резервная копия:', e.message);
      res.status(500).json({ error: 'Не получилось собрать копию' });
    }
  });

  app.get('/shop-api/admin/orders', ...adm, (req, res) => {
    const itemsStmt = db.prepare(`SELECT oi.quantity, oi.price, p.name FROM order_items oi
                                  LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`);
    const list = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 150').all().map((o) => ({
      id: o.id, code: o.order_code || String(o.id), status: String(o.status || '').split(':')[0],
      total: o.total, delivery_cost: o.delivery_cost || 0, created_at: o.created_at,
      address: String(o.address || '').replace(/ · тел\..*$/, ''), phone: orders.phoneOf(o),
      pickup: !o.delivery_city, track: o.track || '', rating: o.rating || 0,
      promo: o.promo_code || '', discount: o.discount_percent || 0,
      buyer: db.getName(o.chat_id) || '', chat_id: o.chat_id,
      items: itemsStmt.all(o.id).map((i) => ({ name: i.name || '—', qty: i.quantity, price: i.price })),
    }));
    res.json({ orders: list });
  });

  app.post('/shop-api/admin/orders/:id/status', ...adm, async (req, res) => {
    const status = String(req.body.status || '');
    if (!orders.PAID.has(status) && status !== 'cancelled') return res.status(400).json({ error: 'Неизвестный статус' });
    try {
      const o = await orders.changeStatus(bot, parseInt(req.params.id, 10), status,
        req.body.track !== undefined ? { track: req.body.track } : {});
      res.json({ ok: true, status: o.base, track: o.track || '' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // статистика, чаты, доставка, промокоды
  require('./admin-api')(app, { bot, adm });

  // ===== Оформление и оплата прямо в витрине =====
  // Всё считаем на сервере: цены — из базы, доставка — из тарифов, скидка — из промокода.
  const { createPendingOrder, getDeliveryPrice } = require('./scenes/checkout');
  const { getCart } = require('./cart');

  app.get('/shop-api/checkout-info', shopAuth, (req, res) => {
    const cities = db.prepare('SELECT city, city_en, price FROM delivery_rates WHERE active = 1 ORDER BY city').all();
    const ds = db.getDeliverySettings();
    res.json({ cities, otherPrice: ds.otherPrice, freeFrom: ds.freeFrom, pickup: ds.pickup, pickupAddress: ds.pickupAddress,
      payOnline: Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY) });
  });

  function findPromo(code) {
    code = String(code || '').trim().slice(0, 40);
    if (!code) return { percent: 0, code: null };
    const p = db.prepare('SELECT * FROM promo_codes WHERE code = ? COLLATE NOCASE AND active = 1').get(code);
    if (!p) throw new Error('Такого промокода нет');
    if (p.max_uses !== null && p.used_count >= p.max_uses) throw new Error('Промокод уже закончился');
    return { percent: p.discount_percent, code: p.code };
  }
  app.post('/shop-api/promo', shopAuth, (req, res) => {
    try { res.json({ ok: true, ...findPromo(req.body.code) }); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  const orderBusy = new Set(); // защита от двойного нажатия «Оплатить»
  app.post('/shop-api/order', shopAuth, async (req, res) => {
    const chatId = req.chatId;
    if (orderBusy.has(chatId)) return res.status(429).json({ error: 'Секунду, оформляем…' });
    orderBusy.add(chatId);
    try {
      const lang = db.getLang(chatId);
      const b = req.body || {};
      const { items, total } = getCart(chatId);
      if (!items.length) return res.status(400).json({ error: 'Корзина пуста' });
      for (const i of items) {
        if (i.stock < i.quantity) return res.status(400).json({ error: t(lang, 'insufficientStock', (lang === 'en' && i.name_en) || i.name, i.stock) });
      }
      // доставка
      let deliveryCity = null, deliveryCost = 0, address;
      const addr = String(b.address || '').trim().slice(0, 300);
      const ds = db.getDeliverySettings();
      if (b.delivery === 'pickup') {
        if (!ds.pickup) return res.status(400).json({ error: 'Самовывоза сейчас нет — выберите доставку' });
        address = t(lang, 'pickupSet');
      } else {
        const city = String(b.city || '').trim().slice(0, 80);
        if (!city) return res.status(400).json({ error: 'Выберите город' });
        if (addr.length < 5) return res.status(400).json({ error: 'Укажите адрес: улица, дом, квартира' });
        deliveryCity = city;
        deliveryCost = getDeliveryPrice(city);
        address = `${city}, ${addr}`;
      }
      const phone = String(b.phone || '').trim().slice(0, 30);
      if (phone && phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Проверьте номер телефона' });
      if (phone) address += ` · тел. ${phone}`;
      let promo;
      try { promo = findPromo(b.promo); } catch (e) { return res.status(400).json({ error: e.message }); }
      const discounted = promo.percent > 0 ? Math.round((total * (100 - promo.percent)) / 100) : total;
      if (ds.freeFrom > 0 && discounted >= ds.freeFrom) deliveryCost = 0; // бесплатная доставка от суммы
      const finalTotal = discounted + deliveryCost;

      const orderId = createPendingOrder(chatId, address, 'yookassa', finalTotal, promo.code, promo.percent, deliveryCity, deliveryCost);
      if (promo.code) db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(promo.code);
      const code = db.prepare('SELECT order_code FROM orders WHERE id = ?').get(orderId).order_code || String(orderId);

      const { createPayment } = require('./payments/yookassa');
      const payment = await createPayment(orderId, finalTotal / 100, `Заказ #${code}`);
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(`awaiting_payment:${payment.id}`, orderId);
      const url = payment.confirmation.confirmation_url;
      // ссылка на оплату — ещё и в чат, чтобы не потерялась
      bot.telegram.sendMessage(chatId, t(lang, 'payLinkText', code), {
        reply_markup: { inline_keyboard: [[{ text: t(lang, 'payUrlButton'), url }]] },
      }).catch(() => {});
      res.json({ ok: true, id: orderId, code, total: finalTotal, pay_url: url });
    } catch (e) {
      console.error('Витрина: не удалось оформить заказ', e.response?.data || e.message);
      res.status(502).json({ error: 'Не получилось создать оплату. Попробуйте ещё раз через минуту' });
    } finally {
      orderBusy.delete(chatId);
    }
  });

  // Ссылка «Оплатить» для заказа, который ещё ждёт оплату
  app.post('/shop-api/orders/:id/pay', shopAuth, async (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ? AND chat_id = ?').get(parseInt(req.params.id, 10), req.chatId);
    const payId = o && String(o.status || '').startsWith('awaiting_payment:') ? o.status.split(':')[1] : null;
    if (!payId) return res.status(404).json({ error: 'Этот заказ уже не ждёт оплату' });
    try {
      const p = await getPayment(payId);
      if (p.status !== 'pending' || !p.confirmation?.confirmation_url) return res.status(410).json({ error: 'Ссылка на оплату устарела — оформите заказ заново' });
      res.json({ pay_url: p.confirmation.confirmation_url });
    } catch (e) { res.status(502).json({ error: 'ЮKassa не ответила, попробуйте ещё раз' }); }
  });

  // «Оформить» в витрине → бот присылает корзину с кнопкой оформления в чат
  app.post('/shop-api/checkout', shopAuth, async (req, res) => {
    try {
      if (showCartFor) await showCartFor(req.chatId);
      res.json({ ok: true });
    } catch (e) {
      console.error('Витрина: не удалось отправить корзину', e.message);
      res.status(500).json({ error: 'Не получилось, попробуйте ещё раз' });
    }
  });

  // === Вебхук ЮKassa (без авторизации — вызывается самой ЮKassa) ===
  app.post('/yookassa-webhook', async (req, res) => {
    const event = req.body;

    if (event && event.event === 'payment.succeeded' && event.object && event.object.id) {
      // Не верим уведомлению «на слово»: переспрашиваем платёж у самой ЮKassa.
      // Иначе кто угодно мог бы отправить сюда поддельный «оплачено».
      let payment;
      try {
        payment = await getPayment(event.object.id);
      } catch (e) {
        console.error('ЮKassa: не удалось проверить платёж', e.message);
        return res.sendStatus(500); // ЮKassa повторит уведомление позже
      }
      if (payment.status !== 'succeeded') return res.sendStatus(200);
      // Платёж другого бота (тот же магазин ЮKassa, например «Флёр») — не наш, пропускаем
      const app = payment.metadata && payment.metadata.app;
      if (app && app !== 'radiatorbot') return res.sendStatus(200);

      const orderId = parseInt(payment.metadata && payment.metadata.order_id, 10);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || orders.PAID.has(orders.base(order.status))) return res.sendStatus(200); // защита от дублей
      // Сумма платежа должна совпасть с суммой заказа (в копейках)
      if (Math.round(parseFloat(payment.amount.value) * 100) !== order.total) {
        console.warn(`ЮKassa: сумма платежа ${payment.amount.value} не совпадает с заказом #${orderId}`);
        return res.sendStatus(200);
      }

      try {
        await orders.markPaid(bot, orderId); // статус, склад, корзина, сообщения покупателю и владелице
        checkLowStock(bot);
      } catch (e) {
        console.error('ЮKassa: оплата получена, но обработка заказа упала', e.message);
        return res.sendStatus(500);
      }
    }

    res.sendStatus(200);
  });

  // === Веб-админка: /admin (страница) + /api/* (данные), обе за basic-auth ===
  const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS },
    challenge: true,
  });

  app.use('/admin', adminAuth, express.static(path.join(__dirname, 'admin-public')));
  app.use('/api', adminAuth);

  app.get('/api/products', (req, res) => {
    res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all());
  });

  app.post('/api/products', (req, res) => {
    const { name, description, price, stock, category, photo_url, name_en, description_en, category_en } = req.body;
    const result = db
      .prepare(
        'INSERT INTO products (name, description, price, stock, category, photo_url, name_en, description_en, category_en) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        name,
        description || '',
        Math.round(price * 100),
        stock || 0,
        category || null,
        photo_url || null,
        name_en || null,
        description_en || null,
        category_en || null
      );
    res.json({ id: result.lastInsertRowid });
  });

  app.put('/api/products/:id', (req, res) => {
    const { name, description, price, stock, category, photo_url, name_en, description_en, category_en } = req.body;
    db.prepare(
      'UPDATE products SET name=?, description=?, price=?, stock=?, category=?, photo_url=?, name_en=?, description_en=?, category_en=? WHERE id=?'
    ).run(
      name,
      description,
      Math.round(price * 100),
      stock,
      category,
      photo_url || null,
      name_en || null,
      description_en || null,
      category_en || null,
      req.params.id
    );
    localizeAllPhotos();
    res.json({ ok: true });
  });

  app.delete('/api/products/:id', (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/upload', (req, res) => {
    upload.single('photo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Файл не получен.' });
      const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      res.json({ url });
    });
  });

  // общий фильтр заказов по статусу и поисковой строке — используется и списком, и CSV-экспортом
  function filterOrders(status, q, limit) {
    let orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300').all();

    if (status) {
      orders = orders.filter((o) => (o.status || '').split(':')[0] === status);
    }
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      orders = orders.filter(
        (o) =>
          String(o.id).includes(needle) ||
          (o.order_code || '').toLowerCase().includes(needle) ||
          String(o.chat_id).includes(needle) ||
          (o.address || '').toLowerCase().includes(needle)
      );
    }
    if (limit) orders = orders.slice(0, limit);

    const items = db
      .prepare(
        `SELECT oi.order_id, oi.quantity, oi.price, p.name, p.name_en FROM order_items oi
         JOIN products p ON p.id = oi.product_id`
      )
      .all();
    return orders.map((o) => ({
      ...o,
      delivery_city_en: db.getCityEn(o.delivery_city),
      items: items.filter((i) => i.order_id === o.id),
    }));
  }

  app.get('/api/orders', (req, res) => {
    const { status, q } = req.query;
    res.json(filterOrders(status, q, 100));
  });

  // экспорт отфильтрованного списка заказов в CSV (с BOM для корректной кириллицы в Excel)
  app.get('/api/orders/export', (req, res) => {
    const { status, q } = req.query;
    const orders = filterOrders(status, q, null);

    const csvCell = (val) => {
      const s = val === null || val === undefined ? '' : String(val);
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = [
      'ID', 'Дата', 'Статус', 'Товары', 'Сумма', 'Доставка (город)', 'Стоимость доставки',
      'Адрес', 'Промокод', 'Скидка %', 'Способ оплаты', 'Chat ID',
    ];
    const rows = orders.map((o) => [
      o.id,
      o.created_at,
      STATUS_LABEL_RU[(o.status || '').split(':')[0]] || o.status,
      o.items.map((i) => `${i.name} x${i.quantity}`).join('; '),
      (o.total / 100).toFixed(2),
      o.delivery_city || '',
      o.delivery_cost ? (o.delivery_cost / 100).toFixed(2) : '',
      o.address || '',
      o.promo_code || '',
      o.discount_percent || '',
      o.payment_provider || '',
      o.chat_id,
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  });

  // полная карточка одного заказа — состав, доставка, промокод, способ оплаты
  app.get('/api/orders/:id', (req, res) => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Заказ не найден.' });
    const items = db
      .prepare(
        `SELECT oi.quantity, oi.price, p.name, p.name_en, p.photo_url FROM order_items oi
         JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`
      )
      .all(order.id);
    res.json({ ...order, delivery_city_en: db.getCityEn(order.delivery_city), items });
  });

  const STATUS_LABEL_RU = {
    pending: 'ожидает', awaiting_payment: 'ожидает оплаты', paid: 'оплачен',
    shipped: 'отправлен', delivered: 'доставлен', cancelled: 'отменён',
  };

  // заказы, которые реально принесли деньги (не pending/ожидание оплаты/отменённые)
  const PAID_STATUSES = ['paid', 'shipped', 'delivered'];

  app.get('/api/analytics', (req, res) => {
    const placeholders = PAID_STATUSES.map(() => '?').join(',');
    const paidOrders = db
      .prepare(`SELECT * FROM orders WHERE status IN (${placeholders})`)
      .all(...PAID_STATUSES);

    // created_at хранится как "YYYY-MM-DD HH:MM:SS" (UTC, SQLite CURRENT_TIMESTAMP) —
    // приводим к формату, который надёжно парсит Date()
    const toDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z');

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay.getTime() - 6 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(startOfDay.getTime() - 29 * 24 * 60 * 60 * 1000);

    const since = (date) => paidOrders.filter((o) => toDate(o.created_at) >= date);

    const revenue = (list) => list.reduce((sum, o) => sum + o.total, 0);

    const ordersToday = since(startOfDay);
    const ordersWeek = since(startOfWeek);
    const ordersMonth = since(startOfMonth);

    const avgOrderValue = paidOrders.length
      ? Math.round(revenue(paidOrders) / paidOrders.length)
      : 0;

    const topProducts = db
      .prepare(
        `SELECT p.name AS name, p.name_en AS name_en, SUM(oi.quantity) AS qty, SUM(oi.quantity * oi.price) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         WHERE o.status IN (${placeholders})
         GROUP BY oi.product_id
         ORDER BY qty DESC
         LIMIT 5`
      )
      .all(...PAID_STATUSES);

    res.json({
      revenue: { today: revenue(ordersToday), week: revenue(ordersWeek), month: revenue(ordersMonth) },
      ordersCount: { today: ordersToday.length, week: ordersWeek.length, month: ordersMonth.length },
      avgOrderValue,
      totalOrders: paidOrders.length,
      topProducts,
    });
  });

  app.post('/api/orders/:id/status', async (req, res) => {
    try {
      await orders.changeStatus(bot, parseInt(req.params.id, 10), String(req.body.status || ''));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // === Промокоды ===

  app.get('/api/promos', (req, res) => {
    res.json(db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all());
  });

  app.post('/api/promos', (req, res) => {
    const { code, discount_percent, max_uses } = req.body;
    const percent = parseInt(discount_percent, 10);
    if (!code || !percent || percent <= 0 || percent >= 100) {
      return res.status(400).json({ error: 'Укажите код и процент скидки (1-99).' });
    }
    try {
      db.prepare(
        'INSERT INTO promo_codes (code, discount_percent, max_uses) VALUES (?,?,?)'
      ).run(code.toUpperCase(), percent, max_uses ? parseInt(max_uses, 10) : null);
      res.json({ ok: true });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: `Промокод "${code.toUpperCase()}" уже существует.` });
      }
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/promos/:code/active', (req, res) => {
    const { active } = req.body;
    db.prepare('UPDATE promo_codes SET active = ? WHERE code = ? COLLATE NOCASE').run(
      active ? 1 : 0,
      req.params.code
    );
    res.json({ ok: true });
  });

  // === Тарифы доставки ===

  app.get('/api/delivery', (req, res) => {
    res.json({
      rates: db.prepare('SELECT * FROM delivery_rates ORDER BY city').all(),
      defaultPrice: db.DEFAULT_DELIVERY_PRICE,
    });
  });

  app.post('/api/delivery', (req, res) => {
    const { city, city_en, price } = req.body;
    const priceRub = parseFloat(price);
    if (!city || !priceRub || priceRub < 0) {
      return res.status(400).json({ error: 'Укажите город и цену.' });
    }
    db.prepare(
      `INSERT INTO delivery_rates (city, city_en, price) VALUES (?, ?, ?)
       ON CONFLICT(city) DO UPDATE SET
         city_en = COALESCE(excluded.city_en, delivery_rates.city_en),
         price = excluded.price,
         active = 1`
    ).run(city.trim(), (city_en || '').trim() || null, Math.round(priceRub * 100));
    res.json({ ok: true });
  });

  app.put('/api/delivery/:city/active', (req, res) => {
    const { active } = req.body;
    db.prepare('UPDATE delivery_rates SET active = ? WHERE city = ? COLLATE NOCASE').run(
      active ? 1 : 0,
      req.params.city
    );
    res.json({ ok: true });
  });

  // обновить только английское название города (используется кнопкой "🌐 EN" в админке)
  app.put('/api/delivery/:city/english', (req, res) => {
    const { city_en } = req.body;
    db.prepare('UPDATE delivery_rates SET city_en = ? WHERE city = ? COLLATE NOCASE').run(
      (city_en || '').trim() || null,
      req.params.city
    );
    res.json({ ok: true });
  });

  // при старте и раз в 6 часов проверяем, что все фото лежат у нас
  setTimeout(localizeAllPhotos, 5000);
  setInterval(localizeAllPhotos, 6 * 3600 * 1000);

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () =>
    console.log(`Вебхук ЮKassa и веб-админка слушают порт ${port} (/admin)`)
  );
}

module.exports = { startWebhookServer };
