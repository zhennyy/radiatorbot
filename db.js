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
  category TEXT
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
  price INTEGER NOT NULL, -- в копейках
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- язык интерфейса покупателя (ru/en) — выбирается кнопкой "🌐 Язык / Language"
CREATE TABLE IF NOT EXISTS user_settings (
  chat_id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'ru'
);
`);

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

// дефолтный тариф на доставку для городов, которых нет в списке delivery_rates
const DEFAULT_DELIVERY_PRICE = 150000; // 1500 ₽

// сидим стартовые тарифы, если таблица пуста
const deliveryCount = db.prepare('SELECT COUNT(*) AS c FROM delivery_rates').get().c;
if (deliveryCount === 0) {
  const insertRate = db.prepare('INSERT INTO delivery_rates (city, price) VALUES (?,?)');
  insertRate.run('Санкт-Петербург', 40000); // 400 ₽ — свой город
  insertRate.run('Москва', 70000); // 700 ₽
  insertRate.run('Великий Новгород', 70000);
  insertRate.run('Псков', 70000);
  insertRate.run('Петрозаводск', 70000);
  insertRate.run('Вологда', 70000);
}

// сидим тестовые товары, если каталог пуст
const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (count === 0) {
  const insert = db.prepare(
    'INSERT INTO products (name, description, price, photo_url, stock, category) VALUES (?,?,?,?,?,?)'
  );
  insert.run(
    'Радиатор Milano Bianco',
    'Дизайнерский вертикальный радиатор, белый, 180x40 см',
    1490000, // 14 900 ₽
    null,
    8,
    'Дизайнерские'
  );
  insert.run(
    'Радиатор Nova Grande',
    'Стальной панельный радиатор, антрацит, 60x100 см',
    890000, // 8 900 ₽
    null,
    15,
    'Стальные'
  );
  insert.run(
    'Полотенцесушитель Elegance',
    'Водяной полотенцесушитель, хром, лестница 50x80 см',
    650000, // 6 500 ₽
    null,
    20,
    'Полотенцесушители'
  );
  insert.run(
    'Радиатор Loft Black',
    'Трубчатый радиатор в стиле лофт, чёрный матовый, 200x60 см',
    2190000, // 21 900 ₽
    null,
    5,
    'Дизайнерские'
  );
  insert.run(
    'Радиатор Classic Alu',
    'Алюминиевый секционный радиатор, белый, 1 секция',
    120000, // 1 200 ₽ за секцию
    null,
    100,
    'Секционные'
  );
}

module.exports = db;
module.exports.DEFAULT_DELIVERY_PRICE = 150000; // 1500 ₽
module.exports.getLang = getLang;
module.exports.setLang = setLang;
