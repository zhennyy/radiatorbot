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

// фото товаров храним рядом с базой — на Railway это подключённый Volume,
// так что файлы переживают редеплой (в отличие от остальной файловой системы)
const dbDir = path.dirname(path.resolve(process.env.DB_PATH || 'shop.db'));
const uploadsDir = path.join(dbDir, 'uploads');
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

function startWebhookServer(bot, { showCartFor, aiPick } = {}) {
  const app = express();
  app.set('trust proxy', true); // за прокси Railway — иначе req.protocol всегда 'http'
  app.use(express.json());
  app.use('/uploads', express.static(uploadsDir)); // без авторизации — Telegram должен уметь их скачать

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
    res.json({ lang: db.getLang(req.chatId), products: list, cart: cartMap(req.chatId), isOwner: isOwnerId(req.chatId) });
  });

  // Фото товара через наш сервер: скачиваем по ссылке из админки (или с нашего /uploads) и кэшируем в памяти
  const photoCache = new Map(); // id → { url, type, buf }
  app.get('/shop-photo/:id', async (req, res) => {
    const p = db.prepare('SELECT photo_url FROM products WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!p || !p.photo_url) return res.sendStatus(404);
    try {
      let hit = photoCache.get(req.params.id);
      if (!hit || hit.url !== p.photo_url) {
        const local = p.photo_url.match(/\/uploads\/([^/?#]+)$/);
        if (local && fs.existsSync(path.join(uploadsDir, local[1]))) {
          return res.set('Cache-Control', 'public, max-age=86400').sendFile(path.join(uploadsDir, local[1]));
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
    const orders = db
      .prepare('SELECT * FROM orders WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.chatId)
      .map((o) => {
        const status = String(o.status || '').split(':')[0];
        return {
          id: o.id,
          code: o.order_code || String(o.id),
          status,
          statusLabel: labels[status] || status,
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
    res.json({ orders });
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
    res.json({ ok: true });
  });

  app.get('/shop-api/admin/orders', ...adm, (req, res) => {
    const itemsStmt = db.prepare(`SELECT oi.quantity, oi.price, p.name FROM order_items oi
                                  LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`);
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 60').all().map((o) => ({
      id: o.id, code: o.order_code || String(o.id), status: String(o.status || '').split(':')[0],
      total: o.total, delivery_cost: o.delivery_cost || 0, address: o.address || '', created_at: o.created_at,
      buyer: db.getName(o.chat_id) || '', chat_id: o.chat_id,
      items: itemsStmt.all(o.id).map((i) => ({ name: i.name || '—', qty: i.quantity, price: i.price })),
    }));
    res.json({ orders });
  });

  app.post('/shop-api/admin/orders/:id/status', ...adm, async (req, res) => {
    const status = String(req.body.status || '');
    if (!['paid', 'shipped', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Неизвестный статус' });
    const id = parseInt(req.params.id, 10);
    const order = db.prepare('SELECT chat_id, order_code FROM orders WHERE id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    if (status === 'shipped') {
      const lang = db.getLang(order.chat_id);
      await bot.telegram.sendMessage(order.chat_id, t(lang, 'orderShipped', db.getName(order.chat_id), order.order_code || id)).catch(() => {});
    }
    res.json({ ok: true });
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
      if (!order || order.status === 'paid') return res.sendStatus(200); // защита от дублей
      // Сумма платежа должна совпасть с суммой заказа (в копейках)
      if (Math.round(parseFloat(payment.amount.value) * 100) !== order.total) {
        console.warn(`ЮKassa: сумма платежа ${payment.amount.value} не совпадает с заказом #${orderId}`);
        return res.sendStatus(200);
      }

      db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(orderId);

      const orderItems = db
        .prepare('SELECT * FROM order_items WHERE order_id = ?')
        .all(orderId);
      for (const i of orderItems) {
        db.prepare('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?').run(
          i.quantity,
          i.product_id
        );
      }
      checkLowStock(bot);
      db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(order.chat_id);

      const buyerLang = db.getLang(order.chat_id);
      const buyerName = db.getName(order.chat_id);
      await bot.telegram.sendMessage(order.chat_id, t(buyerLang, 'paymentReceived', buyerName, order.order_code || orderId));

      if (process.env.OWNER_CHAT_ID) {
        const itemsText = orderItems
          .map((i) => {
            const p = db.prepare('SELECT name FROM products WHERE id = ?').get(i.product_id);
            return `${p.name} x${i.quantity}`;
          })
          .join(', ');
        await bot.telegram.sendMessage(
          process.env.OWNER_CHAT_ID,
          `🆕 Новый оплаченный заказ #${orderId}\n${itemsText}\nСумма: ${(order.total / 100).toFixed(0)} ₽\nАдрес: ${order.address}`
        );
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
    const { status } = req.body; // paid | shipped | delivered | cancelled
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
    if (status === 'shipped') {
      const order = db.prepare('SELECT chat_id, order_code FROM orders WHERE id = ?').get(req.params.id);
      if (order) {
        const buyerLang = db.getLang(order.chat_id);
        const buyerName = db.getName(order.chat_id);
        await bot.telegram.sendMessage(order.chat_id, t(buyerLang, 'orderShipped', buyerName, order.order_code || req.params.id));
      }
    }
    res.json({ ok: true });
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

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () =>
    console.log(`Вебхук ЮKassa и веб-админка слушают порт ${port} (/admin)`)
  );
}

module.exports = { startWebhookServer };
