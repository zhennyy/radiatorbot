// Разовые правки каталога: каждая выполняется один раз — отметка «.done-<ключ>» лежит рядом с фото (папка uploads у базы).
// Запускаются при старте сервера, после фото из папки проекта (как раньше в webhook.js).
// Если правка упала, отметка не ставится и при следующем запуске она попробует ещё раз.
const fs = require('node:fs');
const path = require('node:path');
const { database, databasePath } = require('./index');

const markersDirectory = () => path.join(path.dirname(databasePath), 'uploads');

async function runOnce(key, work) {
  const markerFile = path.join(markersDirectory(), `.done-${key}`);
  if (fs.existsSync(markerFile)) return;
  try {
    await work();
    fs.mkdirSync(markersDirectory(), { recursive: true });
    fs.writeFileSync(markerFile, new Date().toISOString());
  } catch (fixError) {
    console.error('Разовая правка не прошла:', key, fixError.message);
  }
}

const LOFT_BLACK_PHOTO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_3HReZJSR0X0kuSZvadzwtcMlq6H/hf_20261001_131313_2e81d209-1a55-474f-890e-5aa4c5c66469.png';

async function applyOneTimeFixes() {
  await runOnce('2026-10-01-catalog', async () => {
    // убираем тестовый товар
    const testProduct = await database.product.findFirst({
      where: { name: 'Радиатор Test', description: 'Тестовое описание' },
      select: { id: true },
    });
    if (testProduct) {
      await database.cartItem.deleteMany({ where: { product_id: testProduct.id } });
      await database.product.delete({ where: { id: testProduct.id } });
      console.log('Тестовый товар удалён');
    }
    // новое фото для Loft Black (сгенерировано), сервер скачает его к себе
    await database.product.updateMany({
      where: { name: 'Радиатор Loft Black' },
      data: { photo_url: LOFT_BLACK_PHOTO_URL },
    });
  });
}

module.exports = { runOnce, applyOneTimeFixes };
