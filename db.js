// db.js
const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || 'shop.db';
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL, -- в копейках, чтобы не было проблем с float
  photo_url TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  name_en TEXT,        -- необязательный английский перевод названия
  description_en TEXT, -- необязательный английский перевод описания
  category_en TEXT     -- необязательный английский перевод категории
);

CREATE TABLE IF NOT EXISTS cart_items (
  chat_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (chat_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  total INTEGER NOT NULL,
  address TEXT,
  payment_provider TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER, -- NULL = без ограничения
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city_en TEXT,
  price INTEGER NOT NULL, -- в копейках
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- язык интерфейса покупателя (ru/en) — выбирается кнопкой "🌐 Язык / Language";
-- name — имя покупателя, один раз спрашиваем при первом /start
CREATE TABLE IF NOT EXISTS user_settings (
  chat_id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'ru',
  name TEXT
);
`);

// миграция: имя покупателя (могло отсутствовать в базе, созданной до этой функции)
const userSettingsColumns = db.prepare('PRAGMA table_info(user_settings)').all().map((c) => c.name);
if (!userSettingsColumns.includes('name')) {
  db.exec('ALTER TABLE user_settings ADD COLUMN name TEXT');
}

// получить язык покупателя (по умолчанию — русский)
function getLang(chatId) {
  const row = db.prepare('SELECT lang FROM user_settings WHERE chat_id = ?').get(chatId);
  return row ? row.lang : 'ru';
}

// сохранить выбор языка покупателя
function setLang(chatId, lang) {
  db.prepare(
    `INSERT INTO user_settings (chat_id, lang) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET lang = excluded.lang`
  ).run(chatId, lang);
}

// получить сохранённое имя покупателя (null, если ещё не указано)
function getName(chatId) {
  const row = db.prepare('SELECT name FROM user_settings WHERE chat_id = ?').get(chatId);
  return row ? row.name : null;
}

// сохранить имя покупателя
function setName(chatId, name) {
  db.prepare(
    `INSERT INTO user_settings (chat_id, name) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET name = excluded.name`
  ).run(chatId, name);
}

// найти английское название города доставки по русскому (для истории заказов —
// orders.delivery_city хранит текст на момент заказа, а не ссылку на delivery_rates)
function getCityEn(city) {
  if (!city) return null;
  const row = db
    .prepare('SELECT city_en FROM delivery_rates WHERE city = ? COLLATE NOCASE')
    .get(city);
  return row ? row.city_en : null;
}

// перевести название города для отображения покупателю/в админке (с фоллбеком на русское)
function translateCity(city, lang) {
  if (!city) return city;
  if (lang !== 'en') return city;
  return getCityEn(city) || city;
}

// миграция: добавляем колонки промокода к уже существующей таблице orders
// (на проде в базе уже есть заказы, поэтому CREATE TABLE их не тронет)
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderColumns.includes('promo_code')) {
  db.exec('ALTER TABLE orders ADD COLUMN promo_code TEXT');
}
if (!orderColumns.includes('discount_percent')) {
  db.exec('ALTER TABLE orders ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0');
}
if (!orderColumns.includes('delivery_city')) {
  db.exec('ALTER TABLE orders ADD COLUMN delivery_city TEXT');
}
if (!orderColumns.includes('delivery_cost')) {
  db.exec('ALTER TABLE orders ADD COLUMN delivery_cost INTEGER NOT NULL DEFAULT 0');
}

// миграция: английские поля каталога (могли отсутствовать в базе, созданной до i18n)
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('name_en')) {
  db.exec('ALTER TABLE products ADD COLUMN name_en TEXT');
}
if (!productColumns.includes('description_en')) {
  db.exec('ALTER TABLE products ADD COLUMN description_en TEXT');
}
if (!productColumns.includes('category_en')) {
  db.exec('ALTER TABLE products ADD COLUMN category_en TEXT');
}

// одноразовый бэкфилл английских переводов для стартовых демо-товаров
// (если они уже есть в базе без name_en — например, база создана до появления двуязычности)
const seedTranslations = {
  'Радиатор Milano Bianco': {
    name_en: 'Milano Bianco Radiator',
    description_en: 'Designer vertical radiator, white, 180x40 cm',
    category_en: 'Designer',
  },
  'Радиатор Nova Grande': {
    name_en: 'Nova Grande Radiator',
    description_en: 'Steel panel radiator, anthracite, 60x100 cm',
    category_en: 'Steel',
  },
  'Полотенцесушитель Elegance': {
    name_en: 'Elegance Towel Warmer',
    description_en: 'Water-heated towel warmer, chrome, ladder-style 50x80 cm',
    category_en: 'Towel warmers',
  },
  'Радиатор Loft Black': {
    name_en: 'Loft Black Radiator',
    description_en: 'Tubular loft-style radiator, matte black, 200x60 cm',
    category_en: 'Designer',
  },
  'Радиатор Classic Alu': {
    name_en: 'Classic Alu Radiator',
    description_en: 'Aluminium sectional radiator, white, 1 section',
    category_en: 'Sectional',
  },
};
const backfillEn = db.prepare(
  'UPDATE products SET name_en = ?, description_en = ?, category_en = ? WHERE name = ? AND name_en IS NULL'
);
for (const [ruName, tr] of Object.entries(seedTranslations)) {
  backfillEn.run(tr.name_en, tr.description_en, tr.category_en, ruName);
}

// миграция: английское название города доставки (могло отсутствовать в базе, созданной до i18n)
const deliveryColumns = db.prepare('PRAGMA table_info(delivery_rates)').all().map((c) => c.name);
if (!deliveryColumns.includes('city_en')) {
  db.exec('ALTER TABLE delivery_rates ADD COLUMN city_en TEXT');
}

// одноразовый бэкфилл английских названий для стартовых городов доставки
const citySeedTranslations = {
  'Санкт-Петербург': 'Saint Petersburg',
  'Москва': 'Moscow',
  'Великий Новгород': 'Veliky Novgorod',
  'Псков': 'Pskov',
  'Петрозаводск': 'Petrozavodsk',
  'Вологда': 'Vologda',
};
const backfillCityEn = db.prepare(
  'UPDATE delivery_rates SET city_en = ? WHERE city = ? COLLATE NOCASE AND city_en IS NULL'
);
for (const [ruCity, cityEn] of Object.entries(citySeedTranslations)) {
  backfillCityEn.run(cityEn, ruCity);
}

// дефолтный тариф на доставку для городов, которых нет в списке delivery_rates
const DEFAULT_DELIVERY_PRICE = 150000; // 1500 ₽

// сидим стартовые тарифы, если таблица пуста
const deliveryCount = db.prepare('SELECT COUNT(*) AS c FROM delivery_rates').get().c;
if (deliveryCount === 0) {
  const insertRate = db.prepare('INSERT INTO delivery_rates (city, city_en, price) VALUES (?,?,?)');
  insertRate.run('Санкт-Петербург', 'Saint Petersburg', 40000); // 400 ₽ — свой город
  insertRate.run('Москва', 'Moscow', 70000); // 700 ₽
  insertRate.run('Великий Новгород', 'Veliky Novgorod', 70000);
  insertRate.run('Псков', 'Pskov', 70000);
  insertRate.run('Петрозаводск', 'Petrozavodsk', 70000);
  insertRate.run('Вологда', 'Vologda', 70000);
}

// сидим тестовые товары, если каталог пуст
const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (count === 0) {
  const insert = db.prepare(
    'INSERT INTO products (name, description, price, photo_url, stock, category, name_en, description_en, category_en) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insert.run(
    'Радиатор Milano Bianco',
    'Дизайнерский вертикальный радиатор, белый, 180x40 см',
    1490000, // 14 900 ₽
    null,
    8,
    'Дизайнерские',
    'Milano Bianco Radiator',
    'Designer vertical radiator, white, 180x40 cm',
    'Designer'
  );
  insert.run(
    'Радиатор Nova Grande',
    'Стальной панельный радиатор, антрацит, 60x100 см',
    890000, // 8 900 ₽
    null,
    15,
    'Стальные',
    'Nova Grande Radiator',
    'Steel panel radiator, anthracite, 60x100 cm',
    'Steel'
  );
  insert.run(
    'Полотенцесушитель Elegance',
    'Водяной полотенцесушитель, хром, лестница 50x80 см',
    650000, // 6 500 ₽
    null,
    20,
    'Полотенцесушители',
    'Elegance Towel Warmer',
    'Water-heated towel warmer, chrome, ladder-style 50x80 cm',
    'Towel warmers'
  );
  insert.run(
    'Радиатор Loft Black',
    'Трубчатый радиатор в стиле лофт, чёрный матовый, 200x60 см',
    2190000, // 21 900 ₽
    null,
    5,
    'Дизайнерские',
    'Loft Black Radiator',
    'Tubular loft-style radiator, matte black, 200x60 cm',
    'Designer'
  );
  insert.run(
    'Радиатор Classic Alu',
    'Алюминиевый секционный радиатор, белый, 1 секция',
    120000, // 1 200 ₽ за секцию
    null,
    100,
    'Секционные',
    'Classic Alu Radiator',
    'Aluminium sectional radiator, white, 1 section',
    'Sectional'
  );
}

module.exports = db;
module.exports.DEFAULT_DELIVERY_PRICE = 150000; // 1500 ₽
module.exports.getLang = getLang;
module.exports.setLang = setLang;
module.exports.getName = getName;
module.exports.setName = setName;
module.exports.getCityEn = getCityEn;
module.exports.translateCity = translateCity;
