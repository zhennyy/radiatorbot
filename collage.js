// collage.js — склеивает фото 4 товаров в одну картинку 2×2 с номерами 1–4.
// Текст на картинке не рисуем (на сервере может не быть шрифтов) —
// цифры в кружках нарисованы линиями, а названия и цены идут в подписи.
const sharp = require('sharp');
const axios = require('axios');

const TILE = 600;
const GAP = 12;
const SIZE = TILE * 2 + GAP;

// Цифры 1–4 линиями (координаты относительно центра кружка)
const DIGITS = {
  1: 'M -4 -9 L 2 -14 L 2 14',
  2: 'M -9 -6 Q -8 -14 0 -14 Q 9 -14 9 -6 Q 9 0 -9 14 L 10 14',
  3: 'M -9 -14 L 9 -14 L -1 -2 Q 10 -2 10 6 Q 10 15 0 15 Q -7 15 -10 10',
  4: 'M 5 14 L 5 -14 L -10 5 L 10 5',
};
const badge = (n, dim) => Buffer.from(
  `<svg width="76" height="76" xmlns="http://www.w3.org/2000/svg">
     <circle cx="38" cy="38" r="32" fill="${dim ? '#8a8a8a' : '#e8590c'}" stroke="#fff" stroke-width="4"/>
     <path d="${DIGITS[n]}" transform="translate(38 38)" fill="none" stroke="#fff" stroke-width="5"
           stroke-linecap="round" stroke-linejoin="round"/>
   </svg>`);

async function tile(url, outOfStock) {
  let img;
  try {
    if (!url) throw new Error('no photo');
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    img = sharp(Buffer.from(res.data))
      .resize(TILE - 40, TILE - 40, { fit: 'contain', background: '#ffffff' })
      .extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#ffffff' });
  } catch {
    // нет фото — светло-серая плитка с иконкой-радиатором
    img = sharp(Buffer.from(
      `<svg width="${TILE}" height="${TILE}" xmlns="http://www.w3.org/2000/svg">
         <rect width="100%" height="100%" fill="#f1f3f5"/>
         <g fill="none" stroke="#adb5bd" stroke-width="10" stroke-linecap="round">
           ${[0, 1, 2, 3, 4].map((i) => `<rect x="${170 + i * 55}" y="200" width="40" height="200" rx="18"/>`).join('')}
         </g></svg>`));
  }
  let buf = await img.flatten({ background: '#ffffff' }).png().toBuffer();
  if (outOfStock) {
    buf = await sharp(buf).composite([{ input: Buffer.from(
      `<svg width="${TILE}" height="${TILE}"><rect width="100%" height="100%" fill="#ffffff" fill-opacity="0.6"/></svg>`) }])
      .png().toBuffer();
  }
  return buf;
}

// items: [{ photo_url, stock }] (до 4 штук) → JPEG-буфер
async function makeCollage(items) {
  const tiles = await Promise.all(items.map((p) => tile(p.photo_url, p.stock <= 0)));
  const layers = [];
  tiles.forEach((buf, i) => {
    const x = (i % 2) * (TILE + GAP);
    const y = Math.floor(i / 2) * (TILE + GAP);
    layers.push({ input: buf, left: x, top: y });
    layers.push({ input: badge(i + 1, items[i].stock <= 0), left: x + 16, top: y + 16 });
  });
  return sharp({ create: { width: SIZE, height: items.length > 2 ? SIZE : TILE, channels: 3, background: '#e9ecef' } })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = { makeCollage };
