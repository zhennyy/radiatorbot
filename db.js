// db.js
const Database = require('better-sqlite3');
const db = new Database('shop.db');

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
`);

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
