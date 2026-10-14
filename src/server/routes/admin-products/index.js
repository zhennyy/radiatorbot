// Админка: товары, фото, резервная копия
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { database } = require('../../../database');
const { makeBackup } = require('../../../backup');
const { checkLowStock } = require('../../../notifications');
const photos = require('../../photos');
const { asyncHandler } = require('../../async-handler');
const { idParamValidator } = require('../../validation');
const { productFormValidator, photoUploadValidator, photoUrlValidator } = require('./validation');

function createAdminProductsRouter({ bot, ownerAuth, forgetShowcasePhoto }) {
  const router = express.Router();
  const warnAboutLowStock = () => checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message));

  router.get('/products', ...ownerAuth, asyncHandler(async (request, response) => {
    const products = await database.product.findMany({ orderBy: [{ category: 'asc' }, { id: 'asc' }] });
    response.json({
      products: products.map(({ photo_url: photoUrl, ...product }) => ({ ...product, has_photo: Boolean(photoUrl), photo: photos.showcasePhotoUrl(product.id, photoUrl) })),
    });
  }));

  router.post('/products', ...ownerAuth, productFormValidator, asyncHandler(async (request, response) => {
    const createdProduct = await database.product.create({ data: request.validated.productFields });
    response.json({ ok: true, id: createdProduct.id });
  }));

  router.post('/products/:id', ...ownerAuth, productFormValidator, asyncHandler(async (request, response) => {
    const { productId, productFields } = request.validated;
    const updated = await database.product.updateMany({ where: { id: productId }, data: productFields });
    if (!updated.count) return response.status(404).json({ error: 'Товар не найден' });
    if (productFields.stock > 0) warnAboutLowStock(); // пополнили склад — список «заканчивается» мог измениться
    return response.json({ ok: true });
  }));

  router.post('/products/:id/delete', ...ownerAuth, idParamValidator('productId'), asyncHandler(async (request, response) => {
    const { productId } = request.validated;
    await database.cartItem.deleteMany({ where: { product_id: productId } });
    await database.product.deleteMany({ where: { id: productId } });
    response.json({ ok: true });
  }));

  // Фото с телефона: приходит готовый JPEG (витрина сама уменьшает его до 1600 px)
  router.post('/products/:id/photo', ...ownerAuth, express.raw({ type: 'image/*', limit: '10mb' }), photoUploadValidator, asyncHandler(async (request, response) => {
    const { productId, photoBuffer, contentType } = request.validated;
    if (!(await database.product.findUnique({ where: { id: productId }, select: { id: true } }))) return response.status(404).json({ error: 'Товар не найден' });
    if (!photoBuffer) return response.status(400).json({ error: 'Файл не получен' });
    const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${photos.extensionFor(contentType)}`;
    fs.writeFileSync(path.join(photos.uploadsDir, fileName), photoBuffer);
    await database.product.update({ where: { id: productId }, data: { photo_url: `${request.protocol}://${request.get('host')}/uploads/${fileName}` } });
    forgetShowcasePhoto(productId);
    return response.json({ ok: true });
  }));

  // Фото по ссылке (https), например из генератора картинок — сервер сам скачает и покажет
  router.post('/products/:id/photo-url', ...ownerAuth, photoUrlValidator, asyncHandler(async (request, response) => {
    const { productId, photoUrl } = request.validated;
    const updated = await database.product.updateMany({ where: { id: productId }, data: { photo_url: photoUrl } });
    if (!updated.count) return response.status(404).json({ error: 'Товар не найден' });
    forgetShowcasePhoto(productId);
    try {
      await photos.localizeAllPhotos();
      const product = await database.product.findUnique({ where: { id: productId }, select: { photo_url: true } });
      return response.json({ ok: true, local: photos.isLocalPhoto(product?.photo_url) });
    } catch {
      return response.json({ ok: true, local: false });
    }
  }));

  // Резервная копия: бот присылает владелице ZIP в чат (каталог, заказы, промокоды, доставка, фото)
  router.post('/backup', ...ownerAuth, asyncHandler(async (request, response) => {
    try {
      const backup = await makeBackup({ uploadsDir: photos.uploadsDir, photosDir: photos.photosDir });
      await bot.telegram.sendDocument(request.chatId, { source: backup.buffer, filename: backup.filename },
        { caption: `📦 Резервная копия магазина\nФото: ${backup.photos} · заказы и каталог — в Excel-файлах внутри.\nХраните у себя: там адреса покупателей.` });
      response.json({ ok: true, size: backup.buffer.length });
    } catch (backupError) {
      console.error('Резервная копия:', backupError.message);
      response.status(500).json({ error: 'Не получилось собрать копию' });
    }
  }));

  return router;
}

module.exports = { createAdminProductsRouter };
