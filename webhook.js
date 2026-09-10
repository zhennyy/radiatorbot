// webhook.js
const express = require('express');
const path = require('path');
const basicAuth = require('express-basic-auth');
const db = require('./db');
const { checkLowStock } = require('./notify');

function startWebhookServer(bot) {
  const app = express();
  app.use(express.json());

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
    const { name, description, price, stock, category } = req.body;
    const result = db
      .prepare('INSERT INTO products (name, description, price, stock, category) VALUES (?,?,?,?,?)')
      .run(name, description || '', Math.round(price * 100), stock || 0, category || null);
    res.json({ id: result.lastInsertRowid });
  });

  app.put('/api/products/:id', (req, res) => {
    const { name, description, price, stock, category } = req.body;
    db.prepare(
      'UPDATE products SET name=?, description=?, price=?, stock=?, category=? WHERE id=?'
    ).run(name, description, Math.round(price * 100), stock, category, req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/products/:id', (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/orders', (req, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
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

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () =>
    console.log(`Вебхук ЮKassa и веб-админка слушают порт ${port} (/admin)`)
  );
}

module.exports = { startWebhookServer };
