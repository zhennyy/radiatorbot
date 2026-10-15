// Команды владелицы в чате (тексты на русском — это внутренний инструмент)
const { database } = require('../../database');
const isOwner = require('../middleware/isOwner');
const orders = require('../../orders');
const { getDeliverySettings } = require('../../settings');
const { normalizeName } = require('../../pricing');
const { checkLowStock } = require('../../notifications');
const { formatPrice, escapeHtml } = require('../keyboards');

const RECENT_ORDERS_LIMIT = 20;
const ORDER_STATUS_LABELS = {
  pending: '⏳ ожидает оплаты',
  awaiting_payment: '⏳ ожидает оплаты',
  paid: '✅ оплачен',
  shipped: '🚚 отправлен',
  delivered: '📦 доставлен',
  cancelled: '❌ отменён',
};

const commandArguments = (context) => context.message.text.split(' ').slice(1);
const textAfterCommand = (context, command) => context.message.text.replace(command, '').trim();
const warnAboutLowStock = (bot) =>
  checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message));

function formatOwnerOrder(order) {
  let orderText = `<b>Заказ #${order.id}</b>\n`;
  orderText += `${ORDER_STATUS_LABELS[orders.baseStatus(order.status)] || orders.baseStatus(order.status)}\n\n`;
  if (order.discount_percent > 0)
    orderText += `Промокод «${escapeHtml(order.promo_code || '')}»: −${order.discount_percent}%\n`;
  if (order.delivery_cost > 0) {
    orderText += `🚚 Доставка${order.delivery_city ? ` (${escapeHtml(order.delivery_city)})` : ''}: ${formatPrice(order.delivery_cost)}\n`;
  } else if (order.delivery_city === null && (order.address === 'Самовывоз' || order.address === 'Pickup')) {
    orderText += '🚚 Самовывоз\n';
  }
  orderText += `💰 Сумма: <b>${formatPrice(order.total)}</b>\n`;
  orderText += `📍 ${escapeHtml(order.address || '—')}\n`;
  orderText += `🕐 ${(order.created_at || '').slice(0, 16).replace('T', ' ')}`;
  return orderText;
}

const isUniqueViolation = (databaseError) =>
  databaseError.code === 'P2002' || String(databaseError.message).includes('UNIQUE');

function registerOwnerCommands(bot) {
  bot.command('orders', isOwner, async (context) => {
    const recentOrders = await database.order.findMany({
      where: { status: { not: 'pending' } },
      orderBy: { created_at: 'desc' },
      take: RECENT_ORDERS_LIMIT,
    });
    if (!recentOrders.length) return context.reply('Заказов нет.');
    await context.reply(`📋 <b>Заказы</b> (последние ${recentOrders.length})`, { parse_mode: 'HTML' });
    for (const order of recentOrders) {
      await context
        .reply(formatOwnerOrder(order), { parse_mode: 'HTML' })
        .catch((sendError) => console.error('/orders:', sendError.message));
    }
  });

  // /addproduct Название | Описание | Цена | Остаток | Категория
  bot.command('addproduct', isOwner, async (context) => {
    const [name, description, priceRubles, stock, category] = textAfterCommand(context, '/addproduct')
      .split('|')
      .map((part) => part.trim());
    if (!name || !priceRubles)
      return context.reply('Формат: /addproduct Название | Описание | Цена | Остаток | Категория');
    await database.product.create({
      data: {
        name,
        description: description || '',
        price: Math.round(parseFloat(priceRubles) * 100),
        stock: parseInt(stock, 10) || 0,
        category: category || null,
      },
    });
    await context.reply(`Товар "${name}" добавлен.`);
  });

  // /addpromo КОД ПРОЦЕНТ [МАКС_ИСПОЛЬЗОВАНИЙ]
  bot.command('addpromo', isOwner, async (context) => {
    const [code, percentText, maxUsesText] = commandArguments(context).filter(Boolean);
    const percent = parseInt(percentText, 10);
    if (!code || !percent || percent <= 0 || percent >= 100) {
      return context.reply('Формат: /addpromo КОД ПРОЦЕНТ [МАКС_ИСПОЛЬЗОВАНИЙ]\nНапример: /addpromo SALE10 10 50');
    }
    const promoCode = code.toUpperCase();
    const maxUses = maxUsesText ? parseInt(maxUsesText, 10) : null;
    try {
      await database.promoCode.create({ data: { code: promoCode, discount_percent: percent, max_uses: maxUses } });
      await context.reply(
        `Промокод "${promoCode}" создан: скидка ${percent}%${maxUses ? `, лимит ${maxUses} использований` : ''}.`,
      );
    } catch (createError) {
      await context.reply(
        isUniqueViolation(createError)
          ? `Промокод "${promoCode}" уже существует.`
          : 'Не удалось создать промокод: ' + createError.message,
      );
    }
  });

  bot.command('promos', isOwner, async (context) => {
    const promoCodes = await database.promoCode.findMany({ orderBy: { created_at: 'desc' } });
    if (!promoCodes.length) return context.reply('Промокодов пока нет.');
    await context.reply(
      promoCodes
        .map((promoCode) => {
          const usage = `${promoCode.used_count}/${promoCode.max_uses || '∞'}`;
          return `${promoCode.code} — ${promoCode.discount_percent}% — ${promoCode.active ? 'активен' : 'выключен'} — использован ${usage}`;
        })
        .join('\n'),
    );
  });

  // /delpromo КОД
  bot.command('delpromo', isOwner, async (context) => {
    const [code] = commandArguments(context);
    if (!code) return context.reply('Формат: /delpromo КОД');
    const allPromoCodes = await database.promoCode.findMany({ select: { id: true, code: true } });
    const matchingIds = allPromoCodes
      .filter((promoCode) => promoCode.code.toUpperCase() === code.toUpperCase())
      .map((promoCode) => promoCode.id);
    const result = await database.promoCode.updateMany({ where: { id: { in: matchingIds } }, data: { active: 0 } });
    await context.reply(
      result.count ? `Промокод "${code.toUpperCase()}" выключен.` : `Промокод "${code.toUpperCase()}" не найден.`,
    );
  });

  // /adddelivery Город Цена (например: /adddelivery Казань 900)
  bot.command('adddelivery', isOwner, async (context) => {
    const words = textAfterCommand(context, '/adddelivery').split(' ');
    const priceRubles = words.pop();
    const city = words.join(' ').trim();
    const price = parseFloat(priceRubles);
    if (!city || !priceRubles || Number.isNaN(price) || price < 0)
      return context.reply('Формат: /adddelivery Город Цена\nНапример: /adddelivery Казань 900');
    const priceKopecks = Math.round(price * 100);
    await database.deliveryRate.upsert({
      where: { city },
      create: { city, price: priceKopecks },
      update: { price: priceKopecks, active: 1 },
    });
    await context.reply(`Тариф для города "${city}" установлен: ${Math.round(price)} ₽.`);
  });

  bot.command('deliveries', isOwner, async (context) => {
    const deliveryRates = await database.deliveryRate.findMany({ orderBy: { city: 'asc' } });
    if (!deliveryRates.length) return context.reply('Тарифы доставки пока не заданы.');
    const ratesText = deliveryRates
      .map((rate) => `${rate.city} — ${formatPrice(rate.price)}${rate.active ? '' : ' (выключен)'}`)
      .join('\n');
    const { otherPrice } = await getDeliverySettings();
    await context.reply(
      `${ratesText}\n\nДля городов не из списка действует тариф по умолчанию: ${formatPrice(otherPrice)}.`,
    );
  });

  // /deldelivery Город
  bot.command('deldelivery', isOwner, async (context) => {
    const city = textAfterCommand(context, '/deldelivery');
    if (!city) return context.reply('Формат: /deldelivery Город');
    // сравниваем в JS: COLLATE NOCASE в SQLite не понимает русские буквы («казань» ≠ «Казань»)
    const allRates = await database.deliveryRate.findMany({ select: { id: true, city: true } });
    const matchingIds = allRates
      .filter((rate) => normalizeName(rate.city) === normalizeName(city))
      .map((rate) => rate.id);
    const result = await database.deliveryRate.updateMany({ where: { id: { in: matchingIds } }, data: { active: 0 } });
    await context.reply(
      result.count ? `Тариф для города "${city}" выключен.` : `Город "${city}" не найден в списке тарифов.`,
    );
  });

  // /stock <id_товара> <новый_остаток>
  bot.command('stock', isOwner, async (context) => {
    const [productIdText, stockText] = commandArguments(context);
    if (!productIdText || !stockText) return context.reply('Формат: /stock <id_товара> <новый_остаток>');
    const newStock = parseInt(stockText, 10);
    const productId = parseInt(productIdText, 10);
    const isUpdated =
      newStock >= 0 &&
      productId > 0 &&
      (await database.product.updateMany({ where: { id: productId }, data: { stock: newStock } })).count > 0;
    if (!isUpdated) return context.reply('Не получилось: проверьте номер товара и число.');
    await context.reply(`Остаток товара #${productIdText} обновлён: ${newStock}`);
    warnAboutLowStock(bot);
  });

  // /markshipped <id_заказа>
  bot.command('markshipped', isOwner, async (context) => {
    const [orderIdText] = commandArguments(context);
    if (!orderIdText) return context.reply('Формат: /markshipped <id_заказа>');
    try {
      const shippedOrder = await orders.changeStatus(bot, parseInt(orderIdText, 10), 'shipped');
      await context.reply(`Заказ № ${shippedOrder.code} помечен как отправленный, покупателю написали.`);
    } catch (statusError) {
      await context.reply(statusError.message);
    }
  });
}

module.exports = { registerOwnerCommands };
