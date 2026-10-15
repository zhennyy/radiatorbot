// Предупреждение владелице, что товар заканчивается. Пишем только когда список изменился, а не каждый час одно и то же.
const { database } = require('../database');
const { getSetting, setSetting } = require('../settings');

const LOW_STOCK_PIECES = 3; // когда осталось не больше 3 шт.
const SIGNATURE_SETTING_KEY = 'low_stock_sig';

async function checkLowStock(bot, piecesThreshold = LOW_STOCK_PIECES) {
  const ownerChatId = process.env.OWNER_CHAT_ID;
  if (!ownerChatId) return;
  const lowStockProducts = await database.product.findMany({
    where: { stock: { lte: piecesThreshold } },
    select: { id: true, name: true, stock: true },
    orderBy: [{ stock: 'asc' }, { name: 'asc' }],
  });
  const signature = lowStockProducts.map((product) => `${product.id}:${product.stock}`).join(',');
  if (signature === (await getSetting(SIGNATURE_SETTING_KEY, ''))) return;
  await setSetting(SIGNATURE_SETTING_KEY, signature);
  if (!lowStockProducts.length) return;

  const text = lowStockProducts
    .map((product) =>
      product.stock <= 0 ? `⛔️ ${product.name} — закончился` : `⚠️ ${product.name} — осталось ${product.stock} шт.`,
    )
    .join('\n');
  const { shopUrl } = require('../orders');
  const productsAdminUrl = shopUrl({ tab: 'admin', adm: 'products' });
  await bot.telegram
    .sendMessage(
      ownerChatId,
      `📦 Заканчивается на складе:\n${text}`,
      productsAdminUrl
        ? { reply_markup: { inline_keyboard: [[{ text: '⚙️ Обновить остатки', web_app: { url: productsAdminUrl } }]] } }
        : {},
    )
    .catch((sendError) => console.error('Склад: не получилось предупредить владелицу', sendError.message));
}

module.exports = { checkLowStock };
