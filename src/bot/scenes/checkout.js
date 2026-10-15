// Оформление заказа в чате: город → адрес → промокод → итог → оплата
const { Scenes, Markup } = require('telegraf');
const { database } = require('../../database');
const { getCart, clearCart } = require('../../cart');
const { translate } = require('../../i18n');
const pricing = require('../../pricing');
const customers = require('../../customers');
const orders = require('../../orders');
const { getDeliverySettings } = require('../../settings');
const { startPayment } = require('../../payments/start');

const SUMMARY_STEP_INDEX = 3;
const formatRublesShort = (kopecks) => (kopecks / 100).toFixed(0) + ' ₽';
const languageOf = (context) => customers.getLanguage(context.chat.id);

async function buildCityKeyboard(cityOptions, language) {
  const cityButtons = cityOptions.map((cityOption, optionIndex) =>
    Markup.button.callback((language === 'en' && cityOption.city_en) || cityOption.city, `deliv_city_${optionIndex}`),
  );
  const keyboardRows = [];
  for (let buttonIndex = 0; buttonIndex < cityButtons.length; buttonIndex += 2)
    keyboardRows.push(cityButtons.slice(buttonIndex, buttonIndex + 2));
  keyboardRows.push([Markup.button.callback(translate(language, 'cityOtherButton'), 'deliv_other')]);
  if ((await getDeliverySettings()).pickup)
    keyboardRows.push([Markup.button.callback(translate(language, 'pickupButton'), 'deliv_pickup')]);
  return Markup.inlineKeyboard(keyboardRows);
}

// Шаг 1: проверяем корзину и остатки, показываем кнопки выбора города
async function startCheckout(context) {
  const language = await languageOf(context);
  const { items } = await getCart(context.chat.id);
  if (!items.length) {
    await context.reply(translate(language, 'cartEmptyLeave'));
    return context.scene.leave();
  }
  for (const cartItem of items) {
    if (cartItem.stock < cartItem.quantity) {
      await context.reply(
        translate(
          language,
          'insufficientStock',
          (language === 'en' && cartItem.name_en) || cartItem.name,
          cartItem.stock,
        ),
      );
      return context.scene.leave();
    }
  }
  const cityOptions = await database.deliveryRate.findMany({
    where: { active: 1 },
    select: { city: true, city_en: true, price: true },
    orderBy: { city: 'asc' },
  });
  context.wizard.state.cityOptions = cityOptions;
  await context.reply(translate(language, 'chooseDeliveryCity'), await buildCityKeyboard(cityOptions, language));
  return context.wizard.next();
}

// Шаг 2: ждём нажатия кнопки города (обрабатывают action-хендлеры ниже)
async function waitForCityButton(context) {
  if (context.message) await context.reply(translate(await languageOf(context), 'pressButtonAbove'));
}

// Шаг 3: название города (если «другой город») или адрес
async function readCityOrAddress(context) {
  const language = await languageOf(context);
  const text = (context.message?.text || '').trim();
  if (!text) {
    await context.reply(translate(language, 'sendAsText'));
    return;
  }
  const wizardState = context.wizard.state;
  if (wizardState.awaitingCustomCityName) {
    wizardState.awaitingCustomCityName = false;
    const knownCity = await pricing.findCity(text);
    wizardState.deliveryCity = knownCity ? knownCity.city : text.slice(0, 80);
    wizardState.deliveryCost = await pricing.getDeliveryPrice(text);
    await context.reply(translate(language, 'enterExactAddress'));
    return;
  }
  wizardState.address = `${wizardState.deliveryCity}, ${text}`;
  context.wizard.selectStep(SUMMARY_STEP_INDEX);
  return showPromoOrSummary(context);
}

// Шаг 4: первый заход — спрашиваем промокод; второй (после ответа) — показываем итог с доставкой
async function showPromoOrSummary(context) {
  const language = await languageOf(context);
  const wizardState = context.wizard.state;
  if (!wizardState.awaitingPromo) {
    wizardState.awaitingPromo = true;
    await context.reply(translate(language, 'promoPrompt'));
    return;
  }
  wizardState.awaitingPromo = false;
  const promoInput = (context.message?.text || '').trim();
  const { items, total } = await getCart(context.chat.id);

  let discountPercent = 0;
  let promoCode = null;
  if (promoInput && promoInput !== '-') {
    try {
      const promo = await pricing.findPromo(promoInput);
      discountPercent = promo.percent;
      promoCode = promo.code;
    } catch (promoError) {
      await context.reply(translate(language, promoError.kind === 'exhausted' ? 'promoExhausted' : 'promoNotFound'));
    }
  }

  // те же правила, что в витрине: скидка, тариф города, «бесплатно от суммы»
  const priceQuote = await pricing.quote(total, discountPercent, wizardState.deliveryCity ?? null);
  Object.assign(wizardState, {
    deliveryCost: priceQuote.delivery,
    promoCode,
    discountPercent,
    discountedTotal: priceQuote.goods,
    grandTotal: priceQuote.total,
    itemsTotal: total, // сумму товаров сверим с корзиной перед оплатой
  });

  const buyerName = await customers.getName(context.chat.id);
  let summary = buyerName ? `${translate(language, 'summaryGreeting', buyerName)}\n\n` : '';
  summary += `${translate(language, 'summaryAddress', wizardState.address)}\n\n${translate(language, 'summaryOrderHeader')}\n`;
  for (const cartItem of items)
    summary += `${(language === 'en' && cartItem.name_en) || cartItem.name} x${cartItem.quantity}\n`;
  summary += translate(language, 'itemsSum', formatRublesShort(total));
  if (discountPercent > 0) summary += `\n${translate(language, 'promoLine', promoCode, discountPercent)}`;
  summary += translate(
    language,
    'deliverySummary',
    await pricing.translateCity(wizardState.deliveryCity, language),
    priceQuote.delivery > 0 ? formatRublesShort(priceQuote.delivery) : translate(language, 'deliveryFree'),
  );
  summary += translate(language, 'totalSummary', formatRublesShort(priceQuote.total));

  await context.reply(
    summary,
    Markup.inlineKeyboard([
      Markup.button.callback(translate(language, 'payButton'), 'pay_yookassa'),
      Markup.button.callback(translate(language, 'cancelButton'), 'checkout_cancel'),
    ]),
  );
  return context.wizard.next();
}

const checkoutScene = new Scenes.WizardScene(
  'checkout-wizard',
  startCheckout,
  waitForCityButton,
  readCityOrAddress,
  showPromoOrSummary,
  // Шаг 5: ждём кнопку оплаты. Всё остальное (вопрос в чат, команда) пропускаем дальше — бот не должен «зависать» в оформлении.
  async (_context, next) => next(),
);

// Выбор города из списка кнопок
checkoutScene.action(/^deliv_city_(\d+)$/, async (context) => {
  const language = await languageOf(context);
  await context.answerCbQuery();
  const cityOption = context.wizard.state.cityOptions?.[parseInt(context.match[1], 10)];
  if (!cityOption) {
    await context.reply(translate(language, 'cityListStale'));
    return context.scene.leave();
  }
  context.wizard.state.deliveryCity = cityOption.city;
  context.wizard.state.deliveryCost = cityOption.price;
  await context.reply(translate(language, 'cityLabel', (language === 'en' && cityOption.city_en) || cityOption.city));
  context.wizard.selectStep(2);
});

// Свой город, не из списка
checkoutScene.action('deliv_other', async (context) => {
  const language = await languageOf(context);
  await context.answerCbQuery();
  context.wizard.state.awaitingCustomCityName = true;
  await context.reply(translate(language, 'enterCityName'));
  context.wizard.selectStep(2);
});

// Самовывоз — доставка не нужна, сразу к промокоду и итогу
checkoutScene.action('deliv_pickup', async (context) => {
  const language = await languageOf(context);
  await context.answerCbQuery();
  if (!(await getDeliverySettings()).pickup) return context.reply('Самовывоза сейчас нет — выберите город доставки 🙏');
  Object.assign(context.wizard.state, {
    address: translate(language, 'pickupSet'),
    deliveryCity: null,
    deliveryCost: 0,
  });
  context.wizard.selectStep(SUMMARY_STEP_INDEX);
  return showPromoOrSummary(context);
});

checkoutScene.action('checkout_cancel', async (context) => {
  const language = await languageOf(context);
  await context.answerCbQuery();
  await context.reply(translate(language, 'checkoutCancelled'));
  return context.scene.leave();
});

checkoutScene.action('pay_yookassa', async (context) => {
  const language = await languageOf(context);
  const chatId = context.chat.id;
  await context.answerCbQuery();

  const wizardState = context.wizard.state;
  const deliveryCity = wizardState.deliveryCity || null;
  // Пока покупатель шёл по шагам, корзину могли изменить (например, в витрине).
  // Пересчитываем сумму по текущей корзине и сверяем — иначе можно было бы оплатить старую, меньшую сумму.
  const { items: currentItems, total: currentTotal } = await getCart(chatId);
  if (!currentItems.length || currentTotal !== wizardState.itemsTotal) {
    await context.scene.leave();
    return context.reply(translate(language, 'cartChanged'));
  }
  for (const cartItem of currentItems) {
    if (cartItem.stock < cartItem.quantity) {
      await context.scene.leave();
      return context.reply(
        translate(
          language,
          'insufficientStock',
          (language === 'en' && cartItem.name_en) || cartItem.name,
          cartItem.stock,
        ),
      );
    }
  }
  const priceQuote = await pricing.quote(currentTotal, wizardState.discountPercent || 0, deliveryCity);
  const orderId = await orders.createPendingOrder({
    chatId,
    address: wizardState.address,
    total: priceQuote.total,
    items: currentItems,
    promoCode: wizardState.promoCode || null,
    discountPercent: wizardState.discountPercent || 0,
    deliveryCity,
    deliveryCost: priceQuote.delivery,
  });
  // промокод засчитываем, когда придёт оплата (orders.markPaid)
  await context.scene.leave();

  try {
    const payment = await startPayment(orderId);
    await clearCart(chatId); // корзина превратилась в заказ
    const createdOrder = await database.order.findUnique({ where: { id: orderId }, select: { order_code: true } });
    await context.reply(
      translate(language, 'payLinkText', createdOrder?.order_code || orderId),
      Markup.inlineKeyboard([
        Markup.button.url(translate(language, 'payUrlButton'), payment.confirmation.confirmation_url),
      ]),
    );
  } catch (paymentError) {
    console.error('Ошибка создания платежа ЮKassa:', paymentError.response?.data || paymentError.message);
    await orders.cancelIfNotPaid(orderId); // оплата не создалась — заказ не висит
    await context.reply(translate(language, 'paymentError'));
  }
});

module.exports = { checkoutScene };
