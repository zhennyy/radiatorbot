// Проверка запросов админки товаров: форма товара и фото
const { ValidationError, createValidator, parsePositiveId, toKopecks, cleanText } = require('../../validation');

const MAX_PRODUCT_NAME = 120;
const MAX_DESCRIPTION = 1000;
const MAX_CATEGORY = 60;
const MIN_PHOTO_BYTES = 100;
const MAX_PHOTO_URL_LENGTH = 1000;

// Форма товара из админки → поля для базы
function productFromForm(form) {
  const product = {
    name: cleanText(form.name, MAX_PRODUCT_NAME),
    description: cleanText(form.description, MAX_DESCRIPTION),
    price: toKopecks(form.price),
    stock: Math.max(0, parseInt(form.stock, 10) || 0),
    category: cleanText(form.category, MAX_CATEGORY) || null,
    name_en: cleanText(form.name_en, MAX_PRODUCT_NAME) || null,
    description_en: cleanText(form.description_en, MAX_DESCRIPTION) || null,
    category_en: cleanText(form.category_en, MAX_CATEGORY) || null,
  };
  if (!product.name) throw new ValidationError('Укажите название');
  if (!(product.price > 0)) throw new ValidationError('Укажите цену');
  return product;
}

const productFormValidator = createValidator((request) => ({
  productId: parsePositiveId(request.params.id),
  productFields: productFromForm(request.body || {}),
}));

// Фото с телефона: пустой или слишком маленький файл — photoBuffer = null (маршрут ответит «Файл не получен»,
// но сначала проверит, что товар есть — как раньше)
const photoUploadValidator = createValidator((request) => ({
  productId: parsePositiveId(request.params.id),
  photoBuffer: Buffer.isBuffer(request.body) && request.body.length >= MIN_PHOTO_BYTES ? request.body : null,
  contentType: request.get('content-type') || '',
}));

const photoUrlValidator = createValidator((request) => {
  const photoUrl = String(request.body.url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(photoUrl) || photoUrl.length > MAX_PHOTO_URL_LENGTH)
    throw new ValidationError('Нужна ссылка, начинающаяся с https://');
  return { productId: parsePositiveId(request.params.id), photoUrl };
});

module.exports = { productFormValidator, photoUploadValidator, photoUrlValidator };
