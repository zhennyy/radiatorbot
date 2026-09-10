// cart.js
const db = require('./db');

function getCart(chatId) {
  const items = db
    .prepare(
      `SELECT ci.product_id, ci.quantity, p.name, p.name_en, p.price, p.stock
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       WHERE ci.chat_id = ?`
    )
    .all(chatId);
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return { items, total };
}

module.exports = { getCart };
