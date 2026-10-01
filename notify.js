// notify.js — предупреждение владелице, что товар заканчивается.
// Пишем только когда список изменился, а не каждый час одно и то же.
const db = require('./db');

function checkLowStock(bot, threshold = 3) {
  const owner = process.env.OWNER_CHAT_ID;
  if (!owner) return;
  const low = db.prepare('SELECT id, name, stock FROM products WHERE stock <= ? ORDER BY stock, name').all(threshold);
  const sig = low.map((p) => `${p.id}:${p.stock}`).join(',');
  if (sig === db.getSetting('low_stock_sig', '')) return;
  db.setSetting('low_stock_sig', sig);
  if (!low.length) return;
  const text = low.map((p) => (p.stock <= 0 ? `⛔️ ${p.name} — закончился` : `⚠️ ${p.name} — осталось ${p.stock} шт.`)).join('\n');
  const { shopUrl } = require('./orders');
  const url = shopUrl({ tab: 'admin', adm: 'products' });
  bot.telegram.sendMessage(owner, `📦 Заканчивается на складе:\n${text}`,
    url ? { reply_markup: { inline_keyboard: [[{ text: '⚙️ Обновить остатки', web_app: { url } }]] } } : {})
    .catch((e) => console.error('Склад: не получилось предупредить владелицу', e.message));
}

module.exports = { checkLowStock };
