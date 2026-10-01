// admin-api.js — данные для админки внутри витрины: статистика, чаты, доставка, промокоды.
// Все маршруты только для владелицы (adm = проверка подписи Telegram + OWNER_CHAT_ID).
const db = require('./db');
const orders = require('./orders');
const { sendToBuyer } = require('./chat');

module.exports = function adminApi(app, { bot, adm }) {
  const toKop = (v) => Math.round(parseFloat(String(v ?? '').replace(',', '.').replace(/\s/g, '')) * 100);
  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(400).json({ error: e.message }); }
  };

  // ───────── 📊 Статистика ─────────
  app.get('/shop-api/admin/stats', ...adm, wrap((req) => {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    // created_at — UTC; считаем дни по Москве (+3 ч)
    const all = db.prepare(`SELECT *, date(created_at, '+3 hours') AS day FROM orders
                            WHERE date(created_at, '+3 hours') >= date('now', '+3 hours', ?)`).all(`-${days - 1} days`);
    const items = db.prepare(`SELECT oi.order_id, oi.product_id, oi.quantity, oi.price, p.name FROM order_items oi
                              LEFT JOIN products p ON p.id = oi.product_id`).all();
    const byOrder = new Map();
    for (const i of items) (byOrder.get(i.order_id) || byOrder.set(i.order_id, []).get(i.order_id)).push(i);

    const paid = all.filter((o) => orders.PAID.has(orders.base(o.status)));
    const revenue = paid.reduce((s, o) => s + o.total, 0);
    const delivery = paid.reduce((s, o) => s + (o.delivery_cost || 0), 0);

    const byDay = [];
    const today = new Date(Date.now() + 3 * 3600e3);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today - i * 864e5).toISOString().slice(0, 10);
      const list = paid.filter((o) => o.day === d);
      byDay.push({ date: d, revenue: list.reduce((s, o) => s + o.total, 0), orders: list.length });
    }

    const top = new Map();
    for (const o of paid) for (const i of byOrder.get(o.id) || []) {
      const t = top.get(i.product_id) || { id: i.product_id, name: i.name || '—', qty: 0, revenue: 0 };
      t.qty += i.quantity; t.revenue += i.quantity * i.price; top.set(i.product_id, t);
    }
    const cities = new Map();
    for (const o of paid) {
      const c = o.delivery_city || 'Самовывоз';
      const x = cities.get(c) || { city: c, orders: 0, revenue: 0 };
      x.orders++; x.revenue += o.total; cities.set(c, x);
    }
    const perUser = new Map();
    for (const o of paid) perUser.set(o.chat_id, (perUser.get(o.chat_id) || 0) + 1);
    const rated = paid.filter((o) => o.rating);
    const byStatus = {};
    for (const o of all) { const b = orders.base(o.status); byStatus[b] = (byStatus[b] || 0) + 1; }

    return {
      days, revenue, delivery, goods: revenue - delivery,
      orders: paid.length,
      avg: paid.length ? Math.round(revenue / paid.length) : 0,
      customers: perUser.size,
      repeat: [...perUser.values()].filter((n) => n > 1).length,
      unpaid: (byStatus.awaiting_payment || 0) + (byStatus.pending || 0),
      cancelled: byStatus.cancelled || 0,
      promoUsed: paid.filter((o) => o.promo_code).length,
      rating: rated.length ? Math.round((rated.reduce((s, o) => s + o.rating, 0) / rated.length) * 10) / 10 : null,
      rated: rated.length,
      active: db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status IN ('paid','assembling','shipped')`).get().c,
      byDay,
      top: [...top.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
      cities: [...cities.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
      lowStock: db.prepare('SELECT id, name, stock FROM products WHERE stock <= 3 ORDER BY stock, name').all(),
    };
  }));

  // ───────── 💬 Чаты ─────────
  app.get('/shop-api/admin/chats', ...adm, wrap(() => ({ chats: db.getChats(), unread: db.unreadTotal() })));
  app.get('/shop-api/admin/chats/:chatId', ...adm, wrap((req) => {
    const chatId = Number(req.params.chatId);
    db.markChatRead(chatId);
    const list = db.prepare('SELECT id, order_code, status, total FROM orders WHERE chat_id = ? ORDER BY id DESC LIMIT 10').all(chatId)
      .map((o) => ({ id: o.id, code: o.order_code || String(o.id), status: orders.base(o.status), total: o.total }));
    return { name: db.getName(chatId) || '', messages: db.getChat(chatId), orders: list, unread: db.unreadTotal() };
  }));
  app.post('/shop-api/admin/chats/:chatId', ...adm, wrap(async (req) => {
    const chatId = Number(req.params.chatId);
    const text = String(req.body?.text ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('Пустое сообщение');
    if (!db.prepare('SELECT 1 FROM messages WHERE chat_id = ? UNION SELECT 1 FROM orders WHERE chat_id = ? LIMIT 1').get(chatId, chatId)) {
      throw new Error('Этот покупатель ещё не писал магазину');
    }
    try { await sendToBuyer(bot, chatId, { text }); }
    catch (e) { throw new Error('Telegram не доставил сообщение: ' + e.message); }
    return { messages: db.getChat(chatId) };
  }));
  // Фото из переписки хранит Telegram — отдаём через сервер, только владелице
  app.get('/shop-api/admin/photo/:fileId', ...adm, async (req, res) => {
    try {
      if (!db.prepare('SELECT 1 FROM messages WHERE photo = ?').get(req.params.fileId)) return res.sendStatus(404);
      const link = await bot.telegram.getFileLink(req.params.fileId);
      const r = await require('axios').get(String(link), { responseType: 'arraybuffer', timeout: 15000 });
      res.set({ 'Content-Type': r.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(Buffer.from(r.data));
    } catch { res.sendStatus(404); }
  });

  // ───────── ⚙️ Настройки: доставка ─────────
  const settings = () => ({
    delivery: db.getDeliverySettings(),
    cities: db.prepare('SELECT id, city, city_en, price, active FROM delivery_rates ORDER BY active DESC, city').all(),
    promos: db.prepare('SELECT id, code, discount_percent, max_uses, used_count, active FROM promo_codes ORDER BY active DESC, id DESC').all(),
  });
  app.get('/shop-api/admin/settings', ...adm, wrap(settings));

  app.post('/shop-api/admin/delivery', ...adm, wrap((req) => {
    const b = req.body || {};
    const otherPrice = toKop(b.otherPrice), freeFrom = b.freeFrom === '' || b.freeFrom == null ? 0 : toKop(b.freeFrom);
    if (!(otherPrice >= 0)) throw new Error('Цена для других городов — числом');
    if (!(freeFrom >= 0)) throw new Error('«Бесплатно от» — числом (0 — выключено)');
    db.setSetting('delivery', {
      otherPrice, freeFrom,
      pickup: Boolean(b.pickup),
      pickupAddress: String(b.pickupAddress || '').trim().slice(0, 200),
    });
    return settings();
  }));
  app.post('/shop-api/admin/cities', ...adm, wrap((req) => {
    const b = req.body || {};
    const city = String(b.city || '').trim().slice(0, 80);
    const price = toKop(b.price);
    if (city.length < 2) throw new Error('Укажите город');
    if (!(price >= 0)) throw new Error('Укажите цену доставки');
    const id = parseInt(b.id, 10);
    if (id) {
      const clash = db.prepare('SELECT id FROM delivery_rates WHERE city = ? COLLATE NOCASE AND id != ?').get(city, id);
      if (clash) throw new Error('Такой город уже есть');
      db.prepare('UPDATE delivery_rates SET city = ?, price = ?, active = ? WHERE id = ?').run(city, price, b.active === false ? 0 : 1, id);
    } else {
      db.prepare(`INSERT INTO delivery_rates (city, price) VALUES (?, ?)
                  ON CONFLICT(city) DO UPDATE SET price = excluded.price, active = 1`).run(city, price);
    }
    return settings();
  }));
  app.post('/shop-api/admin/cities/:id/delete', ...adm, wrap((req) => {
    db.prepare('DELETE FROM delivery_rates WHERE id = ?').run(parseInt(req.params.id, 10));
    return settings();
  }));

  // ───────── 🎟 Промокоды ─────────
  app.post('/shop-api/admin/promos', ...adm, wrap((req) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
    const pct = parseInt(b.percent, 10);
    const max = b.max_uses === '' || b.max_uses == null ? null : parseInt(b.max_uses, 10);
    if (!/^[A-ZА-ЯЁ0-9_-]{2,30}$/.test(code)) throw new Error('Код — буквы и цифры, от 2 символов');
    if (!(pct >= 1 && pct <= 90)) throw new Error('Скидка — от 1 до 90%');
    if (max !== null && !(max >= 1)) throw new Error('Лимит — число от 1 (или пусто — без лимита)');
    try { db.prepare('INSERT INTO promo_codes (code, discount_percent, max_uses) VALUES (?, ?, ?)').run(code, pct, max); }
    catch (e) { if (String(e.message).includes('UNIQUE')) throw new Error(`Промокод ${code} уже есть`); throw e; }
    return settings();
  }));
  app.post('/shop-api/admin/promos/:id', ...adm, wrap((req) => {
    db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?').run(req.body?.active ? 1 : 0, parseInt(req.params.id, 10));
    return settings();
  }));
  app.post('/shop-api/admin/promos/:id/delete', ...adm, wrap((req) => {
    db.prepare('DELETE FROM promo_codes WHERE id = ?').run(parseInt(req.params.id, 10));
    return settings();
  }));
};
