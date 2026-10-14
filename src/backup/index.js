// Резервная копия магазина одним ZIP-архивом (без сторонних библиотек).
// Внутри: каталог, заказы, промокоды, тарифы доставки (JSON и CSV для Excel) и все фото товаров.
const fs = require('node:fs');
const path = require('node:path');
const { database } = require('../database');

// ---- минимальный ZIP (метод «хранение»: фото и так сжаты) ----
const CRC_TABLE = new Uint32Array(256).map((_, tableIndex) => {
  let crcValue = tableIndex;
  for (let bit = 0; bit < 8; bit++) crcValue = crcValue & 1 ? 0xedb88320 ^ (crcValue >>> 1) : crcValue >>> 1;
  return crcValue >>> 0;
});

function crc32(buffer) {
  let crcValue = 0xffffffff;
  for (const byte of buffer) crcValue = CRC_TABLE[(crcValue ^ byte) & 255] ^ (crcValue >>> 8);
  return (crcValue ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralDirectory = [];
  let offset = 0;
  for (const file of files) {
    const fileName = Buffer.from(file.name, 'utf8');
    const fileData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const checksum = crc32(fileData);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); localHeader.writeUInt16LE(20, 4); localHeader.writeUInt16LE(0x0800, 6); // utf-8 имена
    localHeader.writeUInt32LE(checksum, 14); localHeader.writeUInt32LE(fileData.length, 18); localHeader.writeUInt32LE(fileData.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    localParts.push(localHeader, fileName, fileData);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6); centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt32LE(checksum, 16); centralHeader.writeUInt32LE(fileData.length, 20); centralHeader.writeUInt32LE(fileData.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28); centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, fileName);
    offset += localHeader.length + fileName.length + fileData.length;
  }
  const centralDirectoryBuffer = Buffer.concat(centralDirectory);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); endRecord.writeUInt16LE(files.length, 8); endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectoryBuffer.length, 12); endRecord.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectoryBuffer, endRecord]);
}

// CSV для Excel: «;» и BOM — чтобы Excel на Mac/Windows сразу открыл кириллицу по столбцам
function toCsv(rows) {
  if (!rows.length) return '';
  const columnNames = Object.keys(rows[0]);
  const formatCell = (value) => {
    let cellText = value == null ? '' : String(value);
    const looksLikeFormula = typeof value === 'string' && /^[=+\-@\t\r]/.test(cellText) && !/^[+\-]?[\d\s().-]+$/.test(cellText); // телефоны не трогаем
    if (looksLikeFormula) cellText = "'" + cellText;
    return /[";\n]/.test(cellText) ? `"${cellText.replace(/"/g, '""')}"` : cellText;
  };
  return '﻿' + [columnNames.join(';'), ...rows.map((row) => columnNames.map((columnName) => formatCell(row[columnName])).join(';'))].join('\n');
}

function findPhotoFile(photoUrl, directories) {
  const photoMatch = String(photoUrl || '').match(/\/(uploads|photos)\/([^/?#]+)$/);
  if (!photoMatch) return null;
  const filePath = path.join(directories[photoMatch[1]], photoMatch[2]);
  return fs.existsSync(filePath) ? { fileName: photoMatch[2], filePath } : null;
}

async function makeBackup({ uploadsDir, photosDir }) {
  const products = await database.product.findMany({ orderBy: { id: 'asc' } });
  const allOrders = await database.order.findMany({ orderBy: { id: 'asc' } });
  const orderItems = await database.orderItem.findMany({ orderBy: [{ order_id: 'asc' }, { id: 'asc' }] });
  const promoCodes = await database.promoCode.findMany();
  const deliveryRates = await database.deliveryRate.findMany();
  const settings = await database.setting.findMany();
  const messages = await database.message.findMany({ orderBy: { id: 'asc' } });

  const archiveFiles = [];
  const photoDirectories = { uploads: uploadsDir, photos: photosDir };
  for (const product of products) {
    const photoFile = findPhotoFile(product.photo_url, photoDirectories);
    if (photoFile) archiveFiles.push({ name: `photos/${product.id}-${photoFile.fileName}`, data: fs.readFileSync(photoFile.filePath) });
  }
  const timestamp = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  const catalogRows = products.map((product) => ({
    id: product.id, name: product.name, category: product.category,
    price_rub: product.price / 100,
    stock: product.stock, description: product.description,
  }));
  const orderRows = allOrders.map((order) => ({
    id: order.id, code: order.order_code, created_at: order.created_at, status: String(order.status || '').split(':')[0],
    total_rub: order.total / 100, delivery_rub: (order.delivery_cost || 0) / 100, address: order.address,
    promo: order.promo_code, track: order.track, rating: order.rating,
  }));
  archiveFiles.push(
    { name: 'catalog.json', data: JSON.stringify(products, null, 2) },
    { name: 'catalog.csv', data: toCsv(catalogRows) },
    { name: 'orders.json', data: JSON.stringify({ orders: allOrders, items: orderItems }, null, 2) },
    { name: 'orders.csv', data: toCsv(orderRows) },
    { name: 'promo_codes.json', data: JSON.stringify(promoCodes, null, 2) },
    { name: 'delivery_rates.json', data: JSON.stringify(deliveryRates, null, 2) },
    { name: 'settings.json', data: JSON.stringify(settings, null, 2) },
    { name: 'messages.json', data: JSON.stringify(messages, null, 2) },
    { name: 'README.txt', data: `Резервная копия RadiatorPro от ${timestamp.replace('_', ' ')} (МСК).\n\ncatalog.csv и orders.csv открываются в Excel/Numbers.\nphotos/ — фото товаров (номер в начале — id товара).\n\nВ архиве есть адреса покупателей — храните его у себя и не выкладывайте на GitHub.\n` },
  );
  return {
    buffer: createZip(archiveFiles),
    filename: `radiatorpro-backup-${timestamp}.zip`,
    photos: archiveFiles.filter((archiveFile) => archiveFile.name.startsWith('photos/')).length,
  };
}

module.exports = { makeBackup, createZip };
