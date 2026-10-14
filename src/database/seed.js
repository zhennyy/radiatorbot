// Стартовые данные для пустой базы: тарифы доставки и демо-товары RadiatorPro.
// Плюс разовые дозаполнения, которые раньше делал db.js при каждом запуске (на рабочей базе они уже ничего не меняют).
const { database } = require('./index');

const STARTER_DELIVERY_RATES = [
  { city: 'Санкт-Петербург', city_en: 'Saint Petersburg', price: 40000 }, // 400 ₽ — свой город
  { city: 'Москва', city_en: 'Moscow', price: 70000 },                     // 700 ₽
  { city: 'Великий Новгород', city_en: 'Veliky Novgorod', price: 70000 },
  { city: 'Псков', city_en: 'Pskov', price: 70000 },
  { city: 'Петрозаводск', city_en: 'Petrozavodsk', price: 70000 },
  { city: 'Вологда', city_en: 'Vologda', price: 70000 },
];

const STARTER_PRODUCTS = [
  {
    name: 'Радиатор Milano Bianco', description: 'Дизайнерский вертикальный радиатор, белый, 180x40 см',
    price: 1490000, stock: 8, category: 'Дизайнерские', // 14 900 ₽
    name_en: 'Milano Bianco Radiator', description_en: 'Designer vertical radiator, white, 180x40 cm', category_en: 'Designer',
  },
  {
    name: 'Радиатор Nova Grande', description: 'Стальной панельный радиатор, антрацит, 60x100 см',
    price: 890000, stock: 15, category: 'Стальные', // 8 900 ₽
    name_en: 'Nova Grande Radiator', description_en: 'Steel panel radiator, anthracite, 60x100 cm', category_en: 'Steel',
  },
  {
    name: 'Полотенцесушитель Elegance', description: 'Водяной полотенцесушитель, хром, лестница 50x80 см',
    price: 650000, stock: 20, category: 'Полотенцесушители', // 6 500 ₽
    name_en: 'Elegance Towel Warmer', description_en: 'Water-heated towel warmer, chrome, ladder-style 50x80 cm', category_en: 'Towel warmers',
  },
  {
    name: 'Радиатор Loft Black', description: 'Трубчатый радиатор в стиле лофт, чёрный матовый, 200x60 см',
    price: 2190000, stock: 5, category: 'Дизайнерские', // 21 900 ₽
    name_en: 'Loft Black Radiator', description_en: 'Tubular loft-style radiator, matte black, 200x60 cm', category_en: 'Designer',
  },
  {
    name: 'Радиатор Classic Alu', description: 'Алюминиевый секционный радиатор, белый, 1 секция',
    price: 120000, stock: 100, category: 'Секционные', // 1 200 ₽ за секцию
    name_en: 'Classic Alu Radiator', description_en: 'Aluminium sectional radiator, white, 1 section', category_en: 'Sectional',
  },
];

async function seedDeliveryRates() {
  if (await database.deliveryRate.count()) return;
  await database.deliveryRate.createMany({ data: STARTER_DELIVERY_RATES });
}

async function seedProducts() {
  if (await database.product.count()) return;
  await database.product.createMany({ data: STARTER_PRODUCTS.map((product) => ({ ...product, photo_url: null })) });
}

// Английские переводы стартовых товаров и городов, если база создана до двуязычности
async function backfillStarterTranslations() {
  for (const { name, name_en: nameEn, description_en: descriptionEn, category_en: categoryEn } of STARTER_PRODUCTS) {
    await database.product.updateMany({ where: { name, name_en: null }, data: { name_en: nameEn, description_en: descriptionEn, category_en: categoryEn } });
  }
  for (const { city, city_en: cityEn } of STARTER_DELIVERY_RATES) {
    // city в базе с COLLATE NOCASE — сравнение без учёта регистра, как раньше
    await database.deliveryRate.updateMany({ where: { city, city_en: null }, data: { city_en: cityEn } });
  }
}

// Короткие коды для заказов, созданных до появления кодов
async function backfillOrderCodes() {
  const ordersWithoutCode = await database.order.findMany({ where: { order_code: null }, select: { id: true } });
  if (!ordersWithoutCode.length) return;
  const { generateOrderCode } = require('../orders');
  for (const order of ordersWithoutCode) {
    await database.order.update({ where: { id: order.id }, data: { order_code: await generateOrderCode() } });
  }
}

async function seedDatabase() {
  await backfillStarterTranslations();
  await backfillOrderCodes();
  await seedDeliveryRates();
  await seedProducts();
}

module.exports = { seedDatabase, STARTER_PRODUCTS };
