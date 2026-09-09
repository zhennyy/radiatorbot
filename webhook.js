// webhook.js
const express = require('express');
const db = require('./db');
const { checkLowStock } = require('./notify');

function startWebhookServer(bot) {
  const app = express();
  app.use(express.json());

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

  const port = process.env.WEBHOOK_PORT || 3001;
  app.listen(port, () => console.log(`Вебхук ЮKassa слушает порт ${port}`));
}

module.exports = { startWebhookServer };
