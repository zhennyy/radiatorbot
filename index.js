// Точка входа RadiatorPro: проверяем настройки, готовим базу, запускаем бота, сервер витрины и фоновые задачи.
const { validateConfig } = require('./src/config');

validateConfig();

const { initializeDatabase } = require('./src/database/initialize');
const { disconnect } = require('./src/database');
const { bot, launchBot, showcaseHelpers } = require('./src/bot');
const { startWebhookServer } = require('./src/server');
const { startSchedulers } = require('./src/schedulers');

process.on('unhandledRejection', (rejectionReason) =>
  console.error('Необработанная ошибка:', rejectionReason?.message || rejectionReason),
);

async function start() {
  await initializeDatabase();
  await launchBot();
  startWebhookServer(bot, showcaseHelpers);
  const stopSchedulers = startSchedulers(bot);

  const shutdown = async (signal) => {
    stopSchedulers();
    bot.stop(signal);
    await disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((startError) => {
  console.error('Не удалось запустить магазин:', startError.message);
  process.exit(1);
});
