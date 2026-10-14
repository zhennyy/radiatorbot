// Фото товаров. Храним у себя: папка uploads рядом с базой (на сервере /data/<бот>/uploads — переживает обновления)
// и фото из папки проекта photos/. Если у товара ссылка на чужой сайт — скачиваем картинку один раз и дальше показываем свою копию.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const crypto = require('node:crypto');
const axios = require('axios');
const { database, databasePath } = require('../database');
const { asyncHandler } = require('./async-handler');

const uploadsDir = path.join(path.dirname(databasePath), 'uploads');
const photosDir = path.join(__dirname, '..', '..', 'photos');
fs.mkdirSync(uploadsDir, { recursive: true });

const PUBLIC_BASE = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_SHOWCASE_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_CACHED_PHOTOS = 200;
const LOCAL_PHOTO_PATTERN = /\/(uploads|photos)\/([^/?#]+)$/;

// Путь к файлу, если ссылка ведёт на наше фото (/uploads/… или /photos/…) и файл на месте
function localPhotoPath(photoUrl) {
  const photoMatch = String(photoUrl || '').match(LOCAL_PHOTO_PATTERN);
  if (!photoMatch) return null;
  const filePath = path.join(photoMatch[1] === 'photos' ? photosDir : uploadsDir, photoMatch[2]);
  return fs.existsSync(filePath) ? filePath : null;
}
const isLocalPhoto = (photoUrl) => Boolean(localPhotoPath(photoUrl));

// Версия фото в ссылке — чтобы Telegram не показывал старую картинку после замены
const photoVersion = (photoUrl) => crypto.createHash('md5').update(photoUrl).digest('hex').slice(0, 8);
const showcasePhotoUrl = (productId, photoUrl) => (photoUrl ? `/shop-photo/${productId}?v=${photoVersion(photoUrl)}` : null);

// Защита от SSRF: не ходим по ссылкам во внутреннюю сеть (localhost, 10.x, 192.168.x, 169.254.x — метаданные облака и т.п.)
function isPrivateIp(ipAddress) {
  if (ipAddress.includes(':')) return /^(::1?|fe80|fc|fd|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ipAddress);
  const [firstOctet, secondOctet] = ipAddress.split('.').map(Number);
  return firstOctet === 0 || firstOctet === 10 || firstOctet === 127 || (firstOctet === 169 && secondOctet === 254)
    || (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) || (firstOctet === 192 && secondOctet === 168)
    || (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) || firstOctet >= 224;
}

async function assertPublicUrl(url) {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.promises.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((resolved) => isPrivateIp(resolved.address))) throw new Error('ссылка ведёт во внутреннюю сеть');
}

async function downloadImage(url, { maxBytes, timeoutMs }) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer', timeout: timeoutMs, maxContentLength: maxBytes, maxRedirects: 0,
    headers: { 'User-Agent': 'Mozilla/5.0 (RadiatorPro shop)', Accept: 'image/*' },
  });
  const contentType = String(response.headers['content-type'] || '');
  if (!contentType.startsWith('image/')) throw new Error('по ссылке не картинка (' + contentType + ')');
  return { contentType, buffer: Buffer.from(response.data) };
}

const extensionFor = (contentType) => (contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg');

// Скачать фото товара к себе и поменять ссылку. Возвращает true, если скачали.
async function localizePhoto(productId, photoUrl) {
  if (!photoUrl || isLocalPhoto(photoUrl) || !/^https?:\/\//i.test(photoUrl) || !PUBLIC_BASE) return false;
  await assertPublicUrl(photoUrl);
  const image = await downloadImage(photoUrl, { maxBytes: MAX_DOWNLOAD_BYTES, timeoutMs: 20000 });
  const fileName = `p${productId}-${Date.now()}${extensionFor(image.contentType)}`;
  fs.writeFileSync(path.join(uploadsDir, fileName), image.buffer);
  // ссылку меняем, только если её не успели заменить, пока скачивали
  await database.product.updateMany({ where: { id: productId, photo_url: photoUrl }, data: { photo_url: `${PUBLIC_BASE}/uploads/${fileName}` } });
  return true;
}

let localizingAll = null;
function localizeAllPhotos() {
  if (localizingAll) return localizingAll;
  localizingAll = (async () => {
    const productsWithPhotos = await database.product.findMany({ where: { photo_url: { not: null } }, select: { id: true, name: true, photo_url: true } });
    for (const product of productsWithPhotos) {
      try {
        if (await localizePhoto(product.id, product.photo_url)) console.log(`Фото «${product.name}» сохранено на сервере`);
      } catch (photoError) {
        console.warn(`Фото «${product.name}» не скачалось: ${photoError.message}`);
      }
    }
  })().finally(() => { localizingAll = null; });
  return localizingAll;
}

// Фото из папки проекта photos/: файл «<id товара>-название.jpg» один раз ставится товару.
// Если потом заменить фото в админке — при следующем запуске оно не перезапишется (отметка лежит рядом с фото).
async function assignProjectPhotos() {
  if (!fs.existsSync(photosDir) || !PUBLIC_BASE) return;
  for (const fileName of fs.readdirSync(photosDir)) {
    const fileMatch = fileName.match(/^(\d+)-[\w.-]+\.(jpe?g|png|webp)$/i);
    if (!fileMatch) continue;
    const doneMarker = path.join(uploadsDir, `.done-photo-${fileName}`);
    if (fs.existsSync(doneMarker)) continue;
    try {
      const updated = await database.product.updateMany({ where: { id: parseInt(fileMatch[1], 10) }, data: { photo_url: `${PUBLIC_BASE}/photos/${fileName}` } });
      if (updated.count) console.log(`Фото из проекта: ${fileName}`);
      fs.writeFileSync(doneMarker, new Date().toISOString());
    } catch (assignError) {
      console.error('Разовая правка не прошла:', `photo-${fileName}`, assignError.message);
    }
  }
}

// Фото товара для витрины — через наш сервер: часть сайтов-источников не показывает картинки внутри Telegram
function createShowcasePhotoRoute(bot) {
  const photoCache = new Map(); // id товара → { url, contentType, buffer }
  const route = asyncHandler(async (request, response) => {
    const product = await database.product.findUnique({ where: { id: parseInt(request.params.id, 10) || 0 }, select: { photo_url: true } });
    if (!product || !product.photo_url) return response.sendStatus(404);
    try {
      let cachedPhoto = photoCache.get(request.params.id);
      if (!cachedPhoto || cachedPhoto.url !== product.photo_url) {
        const filePath = localPhotoPath(product.photo_url);
        if (filePath) return response.set('Cache-Control', 'public, max-age=86400').sendFile(filePath);
        let downloadUrl = product.photo_url;
        if (!/^https?:\/\//i.test(downloadUrl)) downloadUrl = String(await bot.telegram.getFileLink(downloadUrl)); // file_id из Telegram
        else await assertPublicUrl(downloadUrl); // не даём ходить по внутренним адресам сервера
        const image = await downloadImage(downloadUrl, { maxBytes: MAX_SHOWCASE_PHOTO_BYTES, timeoutMs: 10000 });
        cachedPhoto = { url: product.photo_url, contentType: image.contentType, buffer: image.buffer };
        if (photoCache.size > MAX_CACHED_PHOTOS) photoCache.delete(photoCache.keys().next().value);
        photoCache.set(request.params.id, cachedPhoto);
      }
      return response.set({ 'Content-Type': cachedPhoto.contentType, 'Cache-Control': 'public, max-age=86400' }).send(cachedPhoto.buffer);
    } catch (photoError) {
      console.warn(`Витрина: фото товара #${request.params.id} не загрузилось —`, photoError.message);
      return response.sendStatus(404);
    }
  });
  return { route, forgetPhoto: (productId) => photoCache.delete(String(productId)) };
}

module.exports = {
  uploadsDir, photosDir, isLocalPhoto, showcasePhotoUrl, assertPublicUrl, localizePhoto, localizeAllPhotos, assignProjectPhotos,
  createShowcasePhotoRoute, extensionFor,
};
