// Каталог в чате (когда витрины нет): карусель товаров, категории, поиск, карточка товара
const { Markup } = require('telegraf');
const { database } = require('../../database');
const { translate } = require('../../i18n');
const cart = require('../../cart');
const { SHOP_URL, formatPrice, escapeHtml, languageOf, buildMainMenu, bothLanguages, redirectToShopIfAvailable, showShopHint } = require('../keyboards');

const SEARCH_RESULTS_LIMIT = 20;
const ALL_CATEGORIES = -1;
const localized = (product, field, language) => (language === 'en' && product[`${field}_en`]) || product[field];

async function renderProductCard(context, product, language) {
  const category = localized(product, 'category', language);
  const description = localized(product, 'description', language);
  const caption =
    `🔥 <b>${escapeHtml(localized(product, 'name', language))}</b>\n` +
    (description ? `<i>${escapeHtml(description)}</i>\n\n` : '\n') +
    `🏷 ${escapeHtml(category)}\n` +
    `${translate(language, 'priceLabel')} <b>${formatPrice(product.price)}</b>\n` +
    (product.stock > 0 ? translate(language, 'inStock', product.stock) : translate(language, 'outOfStock'));
  const extra = { parse_mode: 'HTML', ...Markup.inlineKeyboard([Markup.button.callback(translate(language, 'addToCart'), `add_${product.id}`)]) };
  if (product.photo_url) {
    await context.replyWithPhoto(product.photo_url, { caption, ...extra }).catch(() => context.reply(caption, extra));
  } else {
    await context.reply(caption, extra);
  }
}

// Категории каталога по алфавиту (их номера используются в кнопках)
function getCatalogCategories() {
  return database.product.findMany({
    where: { category: { not: null } }, distinct: ['category', 'category_en'], select: { category: true, category_en: true }, orderBy: { category: 'asc' },
  });
}

// Товары категории (или все); товары в наличии — первыми
async function getCarouselProducts(category) {
  const products = await database.product.findMany({
    where: category ? { category } : {},
    orderBy: { id: 'asc' },
  });
  return products.sort((first, second) => Number(first.stock === 0) - Number(second.stock === 0));
}

// Одна карточка товара, которая меняется на месте при листании ◀ ▶ — чат не засоряется десятками сообщений.
// categoryIndex — номер категории (-1 = все), productIndex — номер товара в списке
async function buildCarouselView(chatId, language, categoryIndex, productIndex) {
  const categories = await getCatalogCategories();
  const selectedCategory = categoryIndex >= 0 && categories[categoryIndex] ? categories[categoryIndex].category : null;
  const currentCategoryIndex = selectedCategory ? categoryIndex : ALL_CATEGORIES;
  const products = await getCarouselProducts(selectedCategory);
  if (!products.length) return null;

  const productCount = products.length;
  const currentIndex = ((productIndex % productCount) + productCount) % productCount; // листаем по кругу
  const product = products[currentIndex];
  const category = localized(product, 'category', language);
  const description = localized(product, 'description', language);
  const caption =
    (category ? `<i>${escapeHtml(category)}</i>\n` : '') +
    `<b>${escapeHtml(localized(product, 'name', language))}</b>\n` +
    (description ? `${escapeHtml(description)}\n` : '') +
    `\n💰 <b>${formatPrice(product.price)}</b>\n` +
    (product.stock > 0 ? translate(language, 'inStock', product.stock) : translate(language, 'outOfStock'));

  const callbackButton = Markup.button.callback;
  const keyboardRows = [];
  const quantityInCart = await cart.getQuantityInCart(chatId, product.id);
  if (product.stock > 0) {
    const addLabel = quantityInCart ? translate(language, 'inCartQty', quantityInCart) : `${translate(language, 'addToCart')} · ${formatPrice(product.price)}`;
    keyboardRows.push([callbackButton(addLabel, `ca:${currentCategoryIndex}:${currentIndex}:${product.id}`)]);
  } else {
    keyboardRows.push([callbackButton(translate(language, 'outOfStock'), 'cnoop')]);
  }
  if (productCount > 1) {
    keyboardRows.push([
      callbackButton('◀️', `cv:${currentCategoryIndex}:${currentIndex - 1}`),
      callbackButton(`${currentIndex + 1} / ${productCount}`, 'cnoop'),
      callbackButton('▶️', `cv:${currentCategoryIndex}:${currentIndex + 1}`),
    ]);
  }
  if (categories.length > 1) {
    const categoryChips = [{ label: translate(language, 'allCategories'), index: ALL_CATEGORIES }]
      .concat(categories.map((categoryRow, index) => ({ label: localized(categoryRow, 'category', language), index })));
    for (let chipIndex = 0; chipIndex < categoryChips.length; chipIndex += 2) {
      keyboardRows.push(categoryChips.slice(chipIndex, chipIndex + 2)
        .map((chip) => callbackButton(chip.index === currentCategoryIndex ? `• ${chip.label} •` : chip.label, `cv:${chip.index}:0`)));
    }
  }
  const unitsInCart = await cart.countCartUnits(chatId);
  if (unitsInCart > 0) keyboardRows.push([callbackButton(translate(language, 'cartShort', unitsInCart), 'copencart')]);
  return { product, caption, markup: Markup.inlineKeyboard(keyboardRows).reply_markup };
}

async function sendCarousel(context, categoryIndex = ALL_CATEGORIES, productIndex = 0) {
  const language = await languageOf(context);
  const carouselView = await buildCarouselView(context.chat.id, language, categoryIndex, productIndex);
  if (!carouselView) return context.reply(translate(language, 'noProducts'), buildMainMenu(language));
  const extra = { parse_mode: 'HTML', reply_markup: carouselView.markup };
  if (carouselView.product.photo_url) {
    return context.replyWithPhoto(carouselView.product.photo_url, { caption: carouselView.caption, ...extra }).catch(() => context.reply(carouselView.caption, extra));
  }
  return context.reply(carouselView.caption, extra);
}

// Перерисовать карусель в том же сообщении
async function updateCarousel(context, categoryIndex, productIndex) {
  const language = await languageOf(context);
  const carouselView = await buildCarouselView(context.chat.id, language, categoryIndex, productIndex);
  if (!carouselView) return;
  const isPhotoMessage = Boolean(context.callbackQuery.message && context.callbackQuery.message.photo);
  try {
    if (carouselView.product.photo_url && isPhotoMessage) {
      await context.editMessageMedia(
        { type: 'photo', media: carouselView.product.photo_url, caption: carouselView.caption, parse_mode: 'HTML' },
        { reply_markup: carouselView.markup },
      );
    } else if (!carouselView.product.photo_url && !isPhotoMessage) {
      await context.editMessageText(carouselView.caption, { parse_mode: 'HTML', reply_markup: carouselView.markup });
    } else {
      throw new Error('message type changed');
    }
  } catch (editError) {
    if (/not modified/i.test(editError.message)) return;
    // фото ↔ текст нельзя поменять правкой — заменяем сообщение новым
    await context.deleteMessage().catch(() => {});
    await sendCarousel(context, categoryIndex, productIndex);
  }
}

const answerQuietly = (context) => context.answerCbQuery().catch(() => {});

function registerCatalogHandlers(bot, { showCart }) {
  bot.hears(bothLanguages('btnCatalog'), async (context) => (SHOP_URL ? showShopHint(context) : sendCarousel(context, ALL_CATEGORIES, 0)));
  bot.command('catalog', (context) => sendCarousel(context, ALL_CATEGORIES, 0));

  bot.action(/^cv:(-?\d+):(-?\d+)$/, async (context) => {
    await answerQuietly(context);
    await updateCarousel(context, parseInt(context.match[1], 10), parseInt(context.match[2], 10));
  });

  // «В корзину» под карточкой карусели
  bot.action(/^ca:(-?\d+):(-?\d+):(\d+)$/, async (context) => {
    const language = await languageOf(context);
    const categoryIndex = parseInt(context.match[1], 10);
    const productIndex = parseInt(context.match[2], 10);
    const productId = parseInt(context.match[3], 10);
    const product = await database.product.findUnique({ where: { id: productId }, select: { stock: true } });
    const quantityInCart = await cart.getQuantityInCart(context.chat.id, productId);
    if (!product || product.stock <= quantityInCart) return context.answerCbQuery(translate(language, 'noMoreStock')).catch(() => {});
    await cart.setCartQuantity(context.chat.id, productId, quantityInCart + 1);
    await context.answerCbQuery(translate(language, 'addedToCart')).catch(() => {});
    const carouselView = await buildCarouselView(context.chat.id, language, categoryIndex, productIndex);
    if (carouselView) await context.editMessageReplyMarkup(carouselView.markup).catch(() => {});
  });

  // Кнопки из старых сообщений (сетка 2×2, карточка, «⬅️ ➡️») — открываем карусель
  bot.action(/^cg:(-?\d+):(-?\d+)$/, async (context) => {
    await answerQuietly(context);
    await updateCarousel(context, Number(context.match[1]), Number(context.match[2]) * 4);
  });
  bot.action(/^cd:(-?\d+):(-?\d+)$/, async (context) => {
    await answerQuietly(context);
    await updateCarousel(context, Number(context.match[1]), Number(context.match[2]));
  });
  bot.action(/^page_(\d+)(?:_c(\d+))?$/, (context) => {
    answerQuietly(context);
    return sendCarousel(context, ALL_CATEGORIES, 0);
  });

  bot.action('cnoop', answerQuietly);
  bot.action('copencart', async (context) => {
    await answerQuietly(context);
    await showCart(context);
  });

  // ── Категории ──
  bot.hears(bothLanguages('btnCategories'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnCategories'), async (context) => {
    const language = await languageOf(context);
    const categories = await getCatalogCategories();
    if (!categories.length) return context.reply(translate(language, 'noCategories'), buildMainMenu(language));
    const categoryButtons = categories.map((categoryRow, index) => [Markup.button.callback(localized(categoryRow, 'category', language), `cat_${index}`)]);
    await context.reply(translate(language, 'categoriesPrompt'), Markup.inlineKeyboard(categoryButtons));
  });
  // номера категорий совпадают с getCatalogCategories() — тот же запрос и порядок
  bot.action(/^cat_(\d+)$/, (context) => {
    answerQuietly(context);
    return sendCarousel(context, parseInt(context.match[1], 10), 0);
  });

  // ── Поиск по названию ──
  bot.hears(bothLanguages('btnSearch'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnSearch'), async (context) => {
    const language = await languageOf(context);
    context.session.awaitingSearch = true;
    await context.reply(translate(language, 'searchPrompt'), buildMainMenu(language));
  });
}

// Ответ на «Что ищем?»
async function handleSearchInput(context) {
  const language = await languageOf(context);
  context.session.awaitingSearch = false;
  const searchTerm = context.message.text.trim();
  if (!searchTerm) return;
  const foundProducts = await database.product.findMany({
    where: { OR: [{ name: { contains: searchTerm } }, { name_en: { contains: searchTerm } }] },
    orderBy: { name: 'asc' },
    take: SEARCH_RESULTS_LIMIT,
  });
  if (!foundProducts.length) return context.reply(translate(language, 'searchNoResults', searchTerm), buildMainMenu(language));
  for (const product of foundProducts) await renderProductCard(context, product, language);
}

module.exports = { registerCatalogHandlers, handleSearchInput, renderProductCard };
