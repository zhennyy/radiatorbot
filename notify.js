// notify.js
const db = require('./db');

function checkLowStock(bot, threshold = 3) {
  const low = db.prepare('SELECT * FROM products WHERE stock <= ?').all(threshold);
  if (low.length) {
    const text = low.map((p) => `${p.name}: осталось ${p.stock}`).join('\n');
    bot.telegram.sendMessage(process.env.OWNER_CHAT_ID, `⚠️ Заканчивается на складе:\n${text}`);
  }
}

module.exports = { checkLowStock };
