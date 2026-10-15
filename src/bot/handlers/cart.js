// Корзина и история заказов в чате (когда витрины нет)
const { Markup } = require('telegraf');
const { database } = require('../../database');
const { translate } = require('../../i18n');
const cart = require('../../cart');
const orders = require('../../orders');
const pricing = require('../../pricing');
const {
  formatPrice,
  escapeHtml,
  languageOf,
  buildMainMenu,
  bothLanguages,
  redirectToShopIfAvailable,
} = require('../keyboards');

const ORDER_HISTORY_LIMIT = 10;

async function showCart(context) {
  const language = await languageOf(context);
  const { items, total } = await cart.getCart(context.chat.id);
  if (!items.length) return context.reply(translate(language, 'cartEmpty'), buildMainMenu(language));

  let cartText = translate(language, 'cartTitle');
  const keyboardRows = [];
  for (const cartItem of items) {
    const displayName = (language === 'en' && cartItem.name_en) || cartItem.name;
    cartText += `${displayName} x${cartItem.quantity} — ${formatPrice(cartItem.price * cartItem.quantity)}\n`;
    keyboardRows.push([
      Markup.button.callback(`➖ ${displayName}`, `dec_${cartItem.product_id}`),
      Markup.button.callback('❌', `rm_${cartItem.product_id}`),
    ]);
  }
  cartText += translate(language, 'cartTotal', formatPrice(total));
  keyboardRows.push([Markup.button.callback(translate(language, 'checkoutButton'), 'checkout_start')]);
  await context.reply(cartText, Markup.inlineKeyboard(keyboardRows));
}

async function showMyOrders(context) {
  const language = await languageOf(context);
  const recentOrders = await database.order.findMany({
    where: { chat_id: context.chat.id },
    orderBy: { created_at: 'desc' },
    take: ORDER_HISTORY_LIMIT,
  });
  if (!recentOrders.length) return context.reply(translate(language, 'ordersEmpty'), buildMainMenu(language));

  const itemsByOrderId = await orders.getItemsByOrderId(recentOrders.map((order) => order.id));
  await context.reply(translate(language, 'ordersTitle', recentOrders.length), { parse_mode: 'HTML' });
  for (const order of recentOrders) {
    const statusKey = orders.baseStatus(order.status);
    const itemLines = itemsByOrderId
      .get(order.id)
      .filter((orderItem) => orderItem.name !== null) // как раньше: позиции удалённых товаров не показываем
      .map(
        (orderItem) =>
          `• ${escapeHtml((language === 'en' && orderItem.name_en) || orderItem.name)} ×${orderItem.quantity}`,
      )
      .join('\n');
    const cityName = await pricing.translateCity(order.delivery_city, language);

    let orderText = `<b>${translate(language, 'orderNumber', order.order_code || order.id)}</b>\n`;
    orderText += `${translate(language, 'orderStatus')[statusKey] || statusKey}\n\n`;
    orderText += `${itemLines}\n\n`;
    if (order.discount_percent > 0)
      orderText += `${translate(language, 'promoLine', escapeHtml(order.promo_code || ''), order.discount_percent)}\n`;
    if (order.delivery_cost > 0) {
      orderText += `${translate(language, 'deliveryLine', escapeHtml(cityName || ''), formatPrice(order.delivery_cost))}\n`;
    } else if (order.delivery_city === null && (order.address === 'Самовывоз' || order.address === 'Pickup')) {
      orderText += `${translate(language, 'pickupLine')}\n`;
    }
    orderText += `${translate(language, 'sumLabel')} <b>${formatPrice(order.total)}</b>\n`;
    orderText += `${translate(language, 'addressLabel')} ${escapeHtml(order.address || '—')}\n`;
    orderText += `🕐 ${(order.created_at || '').slice(0, 16).replace('T', ' ')}`;
    await context.reply(orderText, { parse_mode: 'HTML' });
  }
}

function registerCartHandlers(bot) {
  // «В корзину» под карточкой товара (поиск, AI-подбор)
  bot.action(/add_(\d+)/, async (context) => {
    const language = await languageOf(context);
    await cart.changeCartQuantityBy(context.chat.id, parseInt(context.match[1], 10), 1);
    await context.answerCbQuery(translate(language, 'addedToCart'));
  });

  bot.hears(bothLanguages('btnCart'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnCart'), showCart);
  bot.command('cart', showCart);

  bot.action(/dec_(\d+)/, async (context) => {
    await cart.changeCartQuantityBy(context.chat.id, parseInt(context.match[1], 10), -1);
    await context.answerCbQuery();
    await showCart(context);
  });

  bot.action(/rm_(\d+)/, async (context) => {
    const language = await languageOf(context);
    await cart.removeFromCart(context.chat.id, parseInt(context.match[1], 10));
    await context.answerCbQuery(translate(language, 'removed'));
    await showCart(context);
  });

  bot.hears(bothLanguages('btnMyOrders'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnMyOrders'), showMyOrders);
  bot.command('myorders', showMyOrders);

  bot.action('checkout_start', async (context) => {
    await context.answerCbQuery();
    await context.scene.enter('checkout-wizard');
  });
}

module.exports = { registerCartHandlers, showCart };
