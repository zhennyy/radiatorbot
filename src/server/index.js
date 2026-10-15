// HTTP-сервер: витрина (мини-приложение Telegram), её API, админка и вебхук ЮKassa
const path = require('node:path');
const express = require('express');
const photos = require('./photos');
const { applyOneTimeFixes } = require('../database/one-time-fixes');
const { createRateLimiter, createAuthMiddlewares } = require('./auth');
const { createShopRouter } = require('./routes/shop');
const { createCheckoutRouter } = require('./routes/checkout');
const { createAdminProductsRouter } = require('./routes/admin-products');
const { createAdminOrdersRouter } = require('./routes/admin-orders');
const { createAdminSettingsRouter } = require('./routes/admin-settings');
const { createYookassaRouter } = require('./routes/yookassa');

const SHOP_STATIC_DIR = path.join(__dirname, '..', '..', 'shop-public');
const PHOTO_CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const FIRST_PHOTO_CHECK_DELAY_MS = 5000;

function createApp(bot, { showCartFor, aiPick } = {}) {
  const app = express();
  app.set('trust proxy', 'loopback'); // доверяем только своему nginx на этом же сервере
  app.use(express.json());

  app.use('/uploads', express.static(photos.uploadsDir)); // без авторизации — Telegram должен уметь их скачать
  app.use('/photos', express.static(photos.photosDir, { maxAge: '7d' }));
  // Покупатель открывает /shop внутри Telegram; Telegram не должен держать старую версию витрины
  app.use(
    '/shop',
    express.static(SHOP_STATIC_DIR, { setHeaders: (response) => response.set('Cache-Control', 'no-cache') }),
  );

  const isRequestAllowed = createRateLimiter();
  const { shopAuth, ownerAuth } = createAuthMiddlewares(isRequestAllowed);
  const showcasePhoto = photos.createShowcasePhotoRoute(bot);
  app.get('/shop-photo/:id', showcasePhoto.route);

  app.use('/shop-api', createShopRouter({ shopAuth, aiPick, showCartFor }));
  app.use('/shop-api', createCheckoutRouter({ bot, shopAuth, isRequestAllowed }));
  app.use(
    '/shop-api/admin',
    createAdminProductsRouter({ bot, ownerAuth, forgetShowcasePhoto: showcasePhoto.forgetPhoto }),
  );
  app.use('/shop-api/admin', createAdminOrdersRouter({ bot, ownerAuth }));
  app.use('/shop-api/admin', createAdminSettingsRouter({ bot, ownerAuth }));
  app.use(createYookassaRouter({ bot }));

  // Старая веб-админка (/admin, /api) отключена: вся админка теперь внутри магазина в Telegram
  app.all(['/admin', '/admin/*', '/api', '/api/*'], (request, response) => response.sendStatus(404));

  // Общий обработчик ошибок: наружу — короткий JSON, подробности — только в лог (без стека в браузере)
  app.use((serverError, request, response, next) => {
    console.error('Ошибка сервера:', request.method, request.path, serverError.message);
    if (response.headersSent) return next(serverError);
    const statusCode = serverError.statusCode || serverError.status || 500;
    return response.status(statusCode).json({ error: statusCode < 500 ? serverError.message : 'Ошибка сервера' });
  });
  return app;
}

function startWebhookServer(bot, showcaseHelpers = {}) {
  const app = createApp(bot, showcaseHelpers);
  // фото: разово ставим фото из папки проекта, затем разовые правки каталога (порядок как раньше);
  // при старте и раз в 6 часов скачиваем чужие ссылки к себе
  photos
    .assignProjectPhotos()
    .catch((photoError) => console.error('Фото из проекта:', photoError.message))
    .then(applyOneTimeFixes)
    .catch((fixError) => console.error('Разовые правки:', fixError.message));
  setTimeout(photos.localizeAllPhotos, FIRST_PHOTO_CHECK_DELAY_MS);
  setInterval(photos.localizeAllPhotos, PHOTO_CHECK_INTERVAL_MS);

  const port = process.env.WEBHOOK_PORT || 3001;
  return app.listen(port, process.env.HOST || '127.0.0.1', () =>
    console.log(`Вебхук ЮKassa и магазин слушают порт ${port}`),
  );
}

module.exports = { startWebhookServer, createApp, assertPublicUrl: photos.assertPublicUrl };
