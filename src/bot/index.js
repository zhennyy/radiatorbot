// Telegram-бот: собирает обработчики из папки handlers в правильном порядке и запускает бота
const { Telegraf, Scenes, session } = require('telegraf');
const { checkoutScene } = require('./scenes/checkout');
const { SHOP_URL } = require('./keyboards');
const chat = require('../chat');
const { registerStartHandlers, handleNameInput } = require('./handlers/start');
const { registerCatalogHandlers, handleSearchInput } = require('./handlers/catalog');
const { registerCartHandlers, showCart } = require('./handlers/cart');
const { registerAiConsultantHandlers, handleAiConsultInput, getAiRecommendation } = require('./handlers/ai-consultant');
const { registerOwnerCommands } = require('./handlers/owner-commands');

const CHECKOUT_SESSION_TTL_SECONDS = 30 * 60; // брошенное оформление само забывается через 30 минут

// TELEGRAM_API_ROOT — посредник для Telegram (нужен, если сервер в России)
const telegramOptions = process.env.TELEGRAM_API_ROOT ? { telegram: { apiRoot: process.env.TELEGRAM_API_ROOT.replace(/\/*$/, '/') } } : {};
const bot = new Telegraf(process.env.BOT_TOKEN, telegramOptions);

bot.use(session());
// Любая команда (/start, /cart…) во время оформления в чате — выходим из оформления, а не «глотаем» её
bot.use((context, next) => {
  if (context.session?.__scenes?.current && context.message?.text?.startsWith('/')) delete context.session.__scenes;
  return next();
});
// Кнопки статусов, ответы покупателям и оценки работают всегда — даже посреди оформления
chat.setupActions(bot);
bot.use(new Scenes.Stage([checkoutScene], { ttl: CHECKOUT_SESSION_TTL_SECONDS }).middleware());

registerStartHandlers(bot);
registerCatalogHandlers(bot, { showCart });

// Ответы на вопросы бота: имя, поисковый запрос, запрос к AI-консультанту
bot.on('text', async (context, next) => {
  if (context.session?.awaitingName) return handleNameInput(context, next);
  if (context.session?.awaitingSearch) return handleSearchInput(context);
  if (context.session?.awaitingAiConsult) return handleAiConsultInput(context);
  return next();
});

registerAiConsultantHandlers(bot);
registerCartHandlers(bot);
registerOwnerCommands(bot);
// Переписка с покупателями — последней, после всех кнопок и сценариев
chat.setupRelay(bot);

// Ошибка в одном обработчике не должна ронять бота целиком
bot.catch((handlerError, context) => console.error('Ошибка бота:', context?.updateType, handlerError?.message || handlerError));

// Запуск бота; кнопка «🛍 Магазин» у поля ввода открывает витрину
async function launchBot() {
  bot.launch().catch((launchError) => {
    console.error('Бот не запустился:', launchError.message);
    process.exit(1);
  });
  console.log('Бот запущен');
  if (SHOP_URL) {
    await bot.telegram
      .setChatMenuButton({ menuButton: { type: 'web_app', text: '🛍 Магазин', web_app: { url: SHOP_URL } } })
      .catch((menuError) => console.error('Не удалось поставить кнопку «Магазин»:', menuError.message));
  }
}

// Витрине нужны две вещи из бота: AI-подбор и показ корзины в чате
const showcaseHelpers = {
  aiPick: (query, language, userId) => getAiRecommendation(query, language, userId),
  showCartFor: (chatId) => showCart({ chat: { id: chatId }, reply: (text, extra) => bot.telegram.sendMessage(chatId, text, extra) }),
};

module.exports = { bot, launchBot, showcaseHelpers };
