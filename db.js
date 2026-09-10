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
`);

// миграция: добавляем колонки промокода к уже существующей таблице orders
// (на проде в базе уже есть заказы, поэтому CREATE TABLE их не тронет)
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderColumns.includes('promo_code')) {
  db.exec('ALTER TABLE orders ADD COLUMN promo_code TEXT');
}
if (!orderColumns.includes('discount_percent')) {
  db.exec('ALTER TABLE orders ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0');
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
