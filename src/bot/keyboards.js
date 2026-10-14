// Клавиатуры и общие помощники бота
const { Markup } = require('telegraf');
const { translate } = require('../i18n');
const customers = require('../customers');

// Адрес витрины: SHOP_URL из .env (на сервере — https://<бот>.botforall.ru/shop/); RAILWAY_PUBLIC_DOMAIN — запасной вариант для облачных хостингов
const SHOP_URL = process.env.SHOP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/shop/` : null);

const formatPrice = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';
const escapeHtml = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const languageOf = (context) => customers.getLanguage(context.chat.id);

// Постоянная клавиатура снизу — только если витрины нет.
// Есть витрина — нижнего меню нет: всё внутри мини-приложения (кнопка «🛍 Магазин» слева от поля ввода).
function buildMainMenu(language) {
  if (SHOP_URL) return Markup.removeKeyboard();
  return Markup.keyboard([
    [translate(language, 'btnCatalog'), translate(language, 'btnSearch'), translate(language, 'btnCart')],
    [translate(language, 'btnCategories'), translate(language, 'btnMyOrders'), translate(language, 'btnAiPick')],
    [translate(language, 'btnLanguage')],
  ]).resize();
}

function shopTabUrl(tab) {
  if (!tab) return SHOP_URL;
  return SHOP_URL + (SHOP_URL.includes('?') ? '&' : '?') + 'tab=' + tab;
}

// Крупные кнопки магазина под приветствием — чтобы не искать маленькую кнопку у поля ввода
function shopKeyboard(language) {
  return Markup.inlineKeyboard([
    [Markup.button.webApp(translate(language, 'openShopBtn'), shopTabUrl())],
    [Markup.button.webApp(translate(language, 'myOrdersBtn'), shopTabUrl('orders')), Markup.button.webApp(translate(language, 'aiPickBtn'), shopTabUrl('ai'))],
  ]);
}

// Убрать старую нижнюю клавиатуру (один раз за сессию)
async function dropOldKeyboard(context) {
  if (context.session.kbRemoved) return;
  context.session.kbRemoved = true;
  const placeholderMessage = await context.reply('✨', Markup.removeKeyboard()).catch(() => null);
  if (placeholderMessage) context.deleteMessage(placeholderMessage.message_id).catch(() => {});
}

// Всё теперь внутри витрины: на старые кнопки отвечаем подсказкой и кнопкой «Открыть магазин»
async function showShopHint(context) {
  const language = await languageOf(context);
  await context.reply(translate(language, 'shopMoved'), shopKeyboard(language));
  await dropOldKeyboard(context);
}

// Кнопка нижнего меню на обоих языках
const bothLanguages = (key) => [translate('ru', key), translate('en', key)];

// Если есть витрина — вместо старой кнопки показываем подсказку, иначе передаём дальше
const redirectToShopIfAvailable = (context, next) => (SHOP_URL ? showShopHint(context) : next());

module.exports = { SHOP_URL, formatPrice, escapeHtml, languageOf, buildMainMenu, shopKeyboard, dropOldKeyboard, showShopHint, bothLanguages, redirectToShopIfAvailable };
