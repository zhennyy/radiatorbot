-- Базовая схема: таблицы RadiatorPro в том виде, в каком они были до перехода на Prisma
-- (CREATE TABLE из db.js плюс все колонки, которые добавлялись ALTER-ами).
-- На уже работающей базе ничего не меняет (CREATE ... IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  photo_url TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  name_en TEXT,
  description_en TEXT,
  category_en TEXT
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
  order_code TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  promo_code TEXT,
  discount_percent INTEGER NOT NULL DEFAULT 0,
  delivery_city TEXT,
  delivery_cost INTEGER NOT NULL DEFAULT 0,
  track TEXT,
  rating INTEGER,
  status_at TEXT,
  status_msg_id INTEGER,
  payment_id TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  stock_taken INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city_en TEXT,
  price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  chat_id INTEGER PRIMARY KEY,
  lang TEXT NOT NULL DEFAULT 'ru',
  name TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  from_owner INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  photo TEXT,
  owner_msg_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
