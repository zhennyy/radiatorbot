// backup.js — резервная копия магазина одним ZIP-архивом (без сторонних библиотек).
// Внутри: каталог, заказы, промокоды, тарифы доставки (JSON и CSV для Excel) и все фото товаров.
const fs = require('fs');
const path = require('path');
const db = require('./db');

// ---- минимальный ZIP (метод «хранение»: фото и так сжаты) ----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); // utf-8 имена
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

const csv = (rows) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[+\-]?[\d\s().-]+$/.test(s)) s = "'" + s; // защита от формул в Excel (телефоны не трогаем)
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // «;» и BOM — чтобы Excel на Mac/Windows сразу открыл кириллицу по столбцам
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => cell(r[c])).join(';'))].join('\n');
};

function photoFile(url, dirs) {
  const m = String(url || '').match(/\/(uploads|photos)\/([^/?#]+)$/);
  if (!m) return null;
  const p = path.join(dirs[m[1]], m[2]);
  return fs.existsSync(p) ? { dir: m[1], file: m[2], path: p } : null;
}

function makeBackup({ uploadsDir, photosDir }) {
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all();
  const items = db.prepare('SELECT * FROM order_items ORDER BY order_id').all();
  const promos = db.prepare('SELECT * FROM promo_codes').all();
  const delivery = db.prepare('SELECT * FROM delivery_rates').all();
  const files = [];
  const dirs = { uploads: uploadsDir, photos: photosDir };
  for (const p of products) {
    const f = photoFile(p.photo_url, dirs);
    if (f) files.push({ name: `photos/${p.id}-${f.file}`, data: fs.readFileSync(f.path) });
  }
  const stamp = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  files.push(
    { name: 'catalog.json', data: JSON.stringify(products, null, 2) },
    { name: 'catalog.csv', data: csv(products.map((p) => ({ id: p.id, name: p.name, category: p.category, price_rub: p.price / 100, stock: p.stock, description: p.description }))) },
    { name: 'orders.json', data: JSON.stringify({ orders, items }, null, 2) },
    { name: 'orders.csv', data: csv(orders.map((o) => ({ id: o.id, code: o.order_code, created_at: o.created_at, status: String(o.status || '').split(':')[0], total_rub: o.total / 100, delivery_rub: (o.delivery_cost || 0) / 100, address: o.address, promo: o.promo_code, track: o.track, rating: o.rating }))) },
    { name: 'promo_codes.json', data: JSON.stringify(promos, null, 2) },
    { name: 'delivery_rates.json', data: JSON.stringify(delivery, null, 2) },
    { name: 'settings.json', data: JSON.stringify(db.prepare('SELECT * FROM settings').all(), null, 2) },
    { name: 'messages.json', data: JSON.stringify(db.prepare('SELECT * FROM messages ORDER BY id').all(), null, 2) },
    { name: 'README.txt', data: `Резервная копия RadiatorPro от ${stamp.replace('_', ' ')} (МСК).\n\ncatalog.csv и orders.csv открываются в Excel/Numbers.\nphotos/ — фото товаров (номер в начале — id товара).\n\nВ архиве есть адреса покупателей — храните его у себя и не выкладывайте на GitHub.\n` },
  );
  return { buffer: zip(files), filename: `radiatorpro-backup-${stamp}.zip`, photos: files.filter((f) => f.name.startsWith('photos/')).length };
}

module.exports = { makeBackup, zip };
