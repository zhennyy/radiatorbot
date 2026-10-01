// scenes/checkout.js
const { Scenes, Markup } = require('telegraf');
const db = require('../db');
const { getCart } = require('../cart');
const { t } = require('../i18n');

// ищем тариф доставки по городу (без учёта регистра); если города нет в списке —
// используем дефолтный тариф на "остальную Россию"
const pricing = require('../pricing');
const getDeliveryPrice = (city) => pricing.deliveryPrice(city);

function buildCityKeyboard(cityOptions, lang) {
  const cityButtons = cityOptions.map((opt, i) =>
    Markup.button.callback((lang === 'en' && opt.city_en) || opt.city, `deliv_city_${i}`)
  );
  const rows = [];
  for (let i = 0; i < cityButtons.length; i += 2) {
    rows.push(cityButtons.slice(i, i + 2));
  }
  rows.push([Markup.button.callback(t(lang, 'cityOtherButton'), 'deliv_other')]);
  if (db.getDeliverySettings().pickup) rows.push([Markup.button.callback(t(lang, 'pickupButton'), 'deliv_pickup')]);
  return Markup.inlineKeyboard(rows);
}

const checkoutScene = new Scenes.WizardScene(
  'checkout-wizard',
  // Шаг 1: проверяем корзину и остатки, показываем кнопки выбора города
  async (ctx) => {
    const lang = db.getLang(ctx.chat.id);
    const { items } = getCart(ctx.chat.id);
    if (!items.length) {
      await ctx.reply(t(lang, 'cartEmptyLeave'));
      return ctx.scene.leave();
    }

    for (const i of items) {
      const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(i.product_id);
      if (p.stock < i.quantity) {
        await ctx.reply(t(lang, 'insufficientStock', (lang === 'en' && i.name_en) || i.name, p.stock));
        return ctx.scene.leave();
      }
    }

    const cityOptions = db
      .prepare('SELECT city, city_en, price FROM delivery_rates WHERE active = 1 ORDER BY city')
      .all();
    ctx.wizard.state.cityOptions = cityOptions;

    await ctx.reply(t(lang, 'chooseDeliveryCity'), buildCityKeyboard(cityOptions, lang));
    return ctx.wizard.next();
  },
  // Шаг 2: ждём нажатия кнопки выбора города (обрабатывается action-хендлерами ниже)
  async (ctx) => {
    if (ctx.message) {
      const lang = db.getLang(ctx.chat.id);
      await ctx.reply(t(lang, 'pressButtonAbove'));
    }
  },
  // Шаг 3: город/название города введено вручную -> адрес
  async (ctx) => {
    const lang = db.getLang(ctx.chat.id);
    const text = (ctx.message?.text || '').trim();
    if (!text) {
      await ctx.reply(t(lang, 'sendAsText'));
      return;
    }

    if (ctx.wizard.state.awaitingCustomCityName) {
      ctx.wizard.state.awaitingCustomCityName = false;
      const known = pricing.findCity(text);
      ctx.wizard.state.deliveryCity = known ? known.city : text.slice(0, 80);
      ctx.wizard.state.deliveryCost = getDeliveryPrice(text);
      await ctx.reply(t(lang, 'enterExactAddress'));
      return;
    }

    ctx.wizard.state.address = `${ctx.wizard.state.deliveryCity}, ${text}`;
    ctx.wizard.selectStep(3);
    return checkoutScene.steps[3](ctx);
  },
  // Шаг 4: применяем промокод (если есть) и показываем итог с доставкой
  async (ctx) => {
    const lang = db.getLang(ctx.chat.id);
    // этот шаг вызывается либо напрямую (после ввода адреса/самовывоза),
    // либо как следующий шаг визарда после ввода промокода — различаем по флагу
    if (ctx.wizard.state.awaitingPromo) {
      ctx.wizard.state.awaitingPromo = false;
      const input = (ctx.message?.text || '').trim();
      const { total } = getCart(ctx.chat.id);

      let discountPercent = 0;
      let promoCode = null;

      if (input && input !== '-') {
        try {
          const promo = pricing.findPromo(input);
          discountPercent = promo.percent;
          promoCode = promo.code;
        } catch (e) {
          await ctx.reply(t(lang, e.kind === 'exhausted' ? 'promoExhausted' : 'promoNotFound'));
        }
      }

      // те же правила, что в витрине: скидка, тариф города, «бесплатно от суммы»
      const q = pricing.quote(total, discountPercent, ctx.wizard.state.deliveryCity ?? null);
      const discountedTotal = q.goods;
      const deliveryCost = q.delivery;
      ctx.wizard.state.deliveryCost = deliveryCost;
      const grandTotal = q.total;

      ctx.wizard.state.promoCode = promoCode;
      ctx.wizard.state.discountPercent = discountPercent;
      ctx.wizard.state.discountedTotal = discountedTotal;
      ctx.wizard.state.grandTotal = grandTotal;
      ctx.wizard.state.itemsTotal = total; // запоминаем сумму товаров — перед оплатой сверим с корзиной

      const { items } = getCart(ctx.chat.id);
      const buyerName = db.getName(ctx.chat.id);
      let summary = buyerName ? `${t(lang, 'summaryGreeting', buyerName)}\n\n` : '';
      summary += `${t(lang, 'summaryAddress', ctx.wizard.state.address)}\n\n${t(lang, 'summaryOrderHeader')}\n`;
      for (const i of items) summary += `${(lang === 'en' && i.name_en) || i.name} x${i.quantity}\n`;
      summary += t(lang, 'itemsSum', (total / 100).toFixed(0) + ' ₽');
      if (discountPercent > 0) {
        summary += `\n${t(lang, 'promoLine', promoCode, discountPercent)}`;
      }
      summary += t(
        lang,
        'deliverySummary',
        db.translateCity(ctx.wizard.state.deliveryCity, lang),
        deliveryCost > 0 ? (deliveryCost / 100).toFixed(0) + ' ₽' : t(lang, 'deliveryFree')
      );
      summary += t(lang, 'totalSummary', (grandTotal / 100).toFixed(0) + ' ₽');

      await ctx.reply(
        summary,
        Markup.inlineKeyboard([
          Markup.button.callback(t(lang, 'payButton'), 'pay_yookassa'),
          Markup.button.callback(t(lang, 'cancelButton'), 'checkout_cancel'),
        ])
      );
      return ctx.wizard.next();
    }

    // первый заход на этот шаг — спрашиваем промокод
    ctx.wizard.state.awaitingPromo = true;
    await ctx.reply(t(lang, 'promoPrompt'));
  },
  // Шаг 5: ждём нажатия кнопки оплаты (обрабатывается action ниже).
  // Всё остальное (вопрос в чат, команда) пропускаем дальше — бот не должен «зависать» в оформлении.
  async (ctx, next) => next()
);

// выбор города из списка кнопок
checkoutScene.action(/^deliv_city_(\d+)$/, async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  await ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1], 10);
  const opt = ctx.wizard.state.cityOptions?.[idx];
  if (!opt) {
    await ctx.reply(t(lang, 'cityListStale'));
    return ctx.scene.leave();
  }
  ctx.wizard.state.deliveryCity = opt.city;
  ctx.wizard.state.deliveryCost = opt.price;
  await ctx.reply(t(lang, 'cityLabel', (lang === 'en' && opt.city_en) || opt.city));
  ctx.wizard.selectStep(2);
});

// свой вариант города, не из списка
checkoutScene.action('deliv_other', async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  await ctx.answerCbQuery();
  ctx.wizard.state.awaitingCustomCityName = true;
  await ctx.reply(t(lang, 'enterCityName'));
  ctx.wizard.selectStep(2);
});

// самовывоз — доставка не нужна, сразу к промокоду и итогу
checkoutScene.action('deliv_pickup', async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  await ctx.answerCbQuery();
  if (!db.getDeliverySettings().pickup) return ctx.reply('Самовывоза сейчас нет — выберите город доставки 🙏');
  ctx.wizard.state.address = t(lang, 'pickupSet');
  ctx.wizard.state.deliveryCity = null;
  ctx.wizard.state.deliveryCost = 0;
  ctx.wizard.selectStep(3);
  return checkoutScene.steps[3](ctx);
});

checkoutScene.action('checkout_cancel', async (ctx) => {
  const lang = db.getLang(ctx.chat.id);
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'checkoutCancelled'));
  return ctx.scene.leave();
});

checkoutScene.action('pay_yookassa', async (ctx) => {
  const { createPayment } = require('../payments/yookassa');
  const lang = db.getLang(ctx.chat.id);
  await ctx.answerCbQuery();

  const address = ctx.wizard.state.address;
  const promoCode = ctx.wizard.state.promoCode || null;
  const discountPercent = ctx.wizard.state.discountPercent || 0;
  const deliveryCity = ctx.wizard.state.deliveryCity || null;
  const deliveryCost = ctx.wizard.state.deliveryCost || 0;
  // Защита: пока покупатель шёл по шагам, корзину могли изменить (например, в витрине).
  // Пересчитываем сумму по текущей корзине и сверяем — иначе можно было бы оплатить
  // старую, меньшую сумму за большее количество товаров.
  const { items: nowItems, total: nowTotal } = getCart(ctx.chat.id);
  if (!nowItems.length || nowTotal !== ctx.wizard.state.itemsTotal) {
    await ctx.scene.leave();
    return ctx.reply(t(lang, 'cartChanged'));
  }
  for (const i of nowItems) {
    if (i.stock < i.quantity) {
      await ctx.scene.leave();
      return ctx.reply(t(lang, 'insufficientStock', (lang === 'en' && i.name_en) || i.name, i.stock));
    }
  }
  const q = pricing.quote(nowTotal, discountPercent, deliveryCity);
  const finalTotal = q.total;

  const orderId = createPendingOrder(
    ctx.chat.id,
    address,
    'yookassa',
    finalTotal,
    promoCode,
    discountPercent,
    deliveryCity,
    q.delivery
  );
  // промокод засчитываем, когда придёт оплата (orders.markPaid)
  await ctx.scene.leave();

  try {
    const payment = await createPayment(orderId, finalTotal / 100, `Заказ #${orderId}`);
    db.prepare('UPDATE orders SET status = ?, payment_id = ? WHERE id = ?').run(
      `awaiting_payment:${payment.id}`,
      payment.id,
      orderId
    );
    db.prepare('DELETE FROM cart_items WHERE chat_id = ?').run(ctx.chat.id); // корзина превратилась в заказ
    const orderCode = db.prepare('SELECT order_code FROM orders WHERE id = ?').get(orderId)?.order_code;
    await ctx.reply(
      t(lang, 'payLinkText', orderCode || orderId),
      Markup.inlineKeyboard([
        Markup.button.url(t(lang, 'payUrlButton'), payment.confirmation.confirmation_url),
      ])
    );
  } catch (err) {
    console.error('Ошибка создания платежа ЮKassa:', err.response?.data || err.message);
    await ctx.reply(t(lang, 'paymentError'));
  }
});

// создаём заказ со статусом pending; total уже с учётом скидки по промокоду и доставки
function createPendingOrder(
  chatId,
  address,
  provider,
  total,
  promoCode = null,
  discountPercent = 0,
  deliveryCity = null,
  deliveryCost = 0
) {
  const { items } = getCart(chatId);
  const orderCode = db.generateOrderCode();
  const order = db
    .prepare(
      'INSERT INTO orders (chat_id, status, total, address, payment_provider, promo_code, discount_percent, delivery_city, delivery_cost, order_code) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    .run(chatId, 'pending', total, address, provider, promoCode, discountPercent, deliveryCity, deliveryCost, orderCode);
  const orderId = order.lastInsertRowid;
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?,?,?,?)'
  );
  for (const i of items) insertItem.run(orderId, i.product_id, i.quantity, i.price);
  return orderId;
}

module.exports = { checkoutScene, createPendingOrder, getDeliveryPrice };
