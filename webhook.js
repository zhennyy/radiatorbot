// webhook.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const basicAuth = require('express-basic-auth');
const db = require('./db');
const { checkLowStock } = require('./notify');

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

function startWebhookServer(bot) {
  const app = express();
  app.set('trust proxy', true); // за прокси Railway — иначе req.protocol всегда 'http'
  app.use(express.json());
  app.use('/uploads', express.static(uploadsDir)); // без авторизации — Telegram должен уметь их скачать

  // === Вебхук ЮKassa (без авторизации — вызывается самой ЮKassa) ===
  app.post('/yookassa-webhook', async (req, res) => {
    const event = req.body;

    if (event.event === 'payment.succeeded') {
      const orderId = parseInt(event.object.metadata.order_id, 10);
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || order.status === 'paid') return res.sendStatus(200); // защита от дублей

      db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(orderId);

      const orderItems = db
        .prepare('SELECT * FROM order_items WHERE order_id = ?')
        .all(orderId);
      for (const i of orderItems) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(
          i.quantity,
          i.product_id
        );
      }
      checkLowStock(bot);
      db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(order.chat_id);

      await bot.telegram.sendMessage(
        order.chat_id,
        `Оплата получена! Заказ #${orderId} принят в работу. ✅`
      );

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
    const { name, description, price, stock, category, photo_url } = req.body;
    const result = db
      .prepare('INSERT INTO products (name, description, price, stock, category, photo_url) VALUES (?,?,?,?,?,?)')
      .run(name, description || '', Math.round(price * 100), stock || 0, category || null, photo_url || null);
    res.json({ id: result.lastInsertRowid });
  });

  app.put('/api/products/:id', (req, res) => {
    const { name, description, price, stock, category, photo_url } = req.body;
    db.prepare(
      'UPDATE products SET name=?, description=?, price=?, stock=?, category=?, photo_url=? WHERE id=?'
    ).run(name, description, Math.round(price * 100), stock, category, photo_url || null, req.params.id);
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

  app.get('/api/orders', (req, res) => {
    const { status, q } = req.query;
    let orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 300').all();

    if (status) {
      orders = orders.filter((o) => (o.status || '').split(':')[0] === status);
    }
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      orders = orders.filter(
        (o) =>
          String(o.id).includes(needle) ||
          String(o.chat_id).includes(needle) ||
          (o.address || '').toLowerCase().includes(needle)
      );
    }
    orders = orders.slice(0, 100);

    const items = db
      .prepare(
        `SELECT oi.order_id, oi.quantity, p.name FROM order_items oi
         JOIN products p ON p.id = oi.product_id`
      )
      .all();
    const withItems = orders.map((o) => ({
      ...o,
      items: items.filter((i) => i.order_id === o.id),
    }));
    res.json(withItems);
  });

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
        `SELECT p.name AS name, SUM(oi.quantity) AS qty, SUM(oi.quantity * oi.price) AS revenue
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
      const order = db.prepare('SELECT chat_id FROM orders WHERE id = ?').get(req.params.id);
      if (order) {
        await bot.telegram.sendMessage(order.chat_id, `Ваш заказ #${req.params.id} отправлен! 🚚`);
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
    const { city, price } = req.body;
    const priceRub = parseFloat(price);
    if (!city || !priceRub || priceRub < 0) {
      return res.status(400).json({ error: 'Укажите город и цену.' });
    }
    db.prepare(
      `INSERT INTO delivery_rates (city, price) VALUES (?, ?)
       ON CONFLICT(city) DO UPDATE SET price = excluded.price, active = 1`
    ).run(city.trim(), Math.round(priceRub * 100));
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

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () =>
    console.log(`Вебхук ЮKassa и веб-админка слушают порт ${port} (/admin)`)
  );
}

module.exports = { startWebhookServer };
