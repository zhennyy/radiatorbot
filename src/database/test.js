// База: миграции поверх старой базы (созданной до Prisma), стартовые данные, разовые правки каталога
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const testHelpers = require('../server/test-helpers');
const { runMigrations } = require('./migrations');

// Схема в том виде, в каком её оставлял старый db.js на проде (CREATE TABLE + ALTER-ы)
const OLD_SCHEMA_SQL = `
CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, price INTEGER NOT NULL, photo_url TEXT,
  stock INTEGER NOT NULL DEFAULT 0, category TEXT, name_en TEXT, description_en TEXT, category_en TEXT);
CREATE TABLE cart_items (chat_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (chat_id, product_id));
CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', total INTEGER NOT NULL,
  address TEXT, payment_provider TEXT, order_code TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE orders ADD COLUMN promo_code TEXT;
ALTER TABLE orders ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_city TEXT;
ALTER TABLE orders ADD COLUMN delivery_cost INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN track TEXT;
ALTER TABLE orders ADD COLUMN rating INTEGER;
ALTER TABLE orders ADD COLUMN status_at TEXT;
ALTER TABLE orders ADD COLUMN status_msg_id INTEGER;
ALTER TABLE orders ADD COLUMN payment_id TEXT;
ALTER TABLE orders ADD COLUMN paid_at TEXT;
CREATE TABLE order_items (order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL);
ALTER TABLE order_items ADD COLUMN stock_taken INTEGER NOT NULL DEFAULT 0;
CREATE TABLE promo_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, discount_percent INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER, used_count INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE delivery_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL UNIQUE COLLATE NOCASE, city_en TEXT, price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE user_settings (chat_id INTEGER PRIMARY KEY, lang TEXT NOT NULL DEFAULT 'ru', name TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, from_owner INTEGER NOT NULL DEFAULT 0, text TEXT, photo TEXT,
  owner_msg_id INTEGER, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX messages_chat ON messages (chat_id, id);
`;

let shop;
before(async () => {
  shop = await testHelpers.start();
});

const columnsOf = (connection, tableName) =>
  connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);

test('старая база: миграции дают позициям заказа id = прежний rowid, добавляют consent_at, данные на месте, второй запуск ничего не меняет', () => {
  const oldDatabasePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radiatorbot-old-')), 'shop.db');
  const oldConnection = new Database(oldDatabasePath);
  oldConnection.exec(OLD_SCHEMA_SQL);
  oldConnection
    .prepare(
      "INSERT INTO orders (chat_id, status, total, order_code, paid_at) VALUES (111, 'paid', 3000, 'AB12', '2026-10-01 10:00:00')",
    )
    .run();
  const insertItem = oldConnection.prepare(
    'INSERT INTO order_items (order_id, product_id, quantity, price, stock_taken) VALUES (?, ?, ?, ?, ?)',
  );
  insertItem.run(1, 1, 1, 1000, 1);
  insertItem.run(1, 5, 2, 1000, 2);
  oldConnection.prepare('DELETE FROM order_items WHERE product_id = 1').run(); // «дыра» в rowid — id должны сохраниться как есть
  insertItem.run(1, 3, 1, 0, 0);
  const rowidsBefore = oldConnection.prepare('SELECT rowid, product_id FROM order_items ORDER BY rowid').all();
  oldConnection.close();

  runMigrations(oldDatabasePath);
  runMigrations(oldDatabasePath);

  const migrated = new Database(oldDatabasePath);
  assert.deepEqual(
    migrated
      .prepare('SELECT name FROM _app_migrations ORDER BY name')
      .all()
      .map((row) => row.name),
    ['001_baseline.sql', '002_order_items_id.sql', '003_order_consent.sql'],
  );
  assert.deepEqual(migrated.prepare('SELECT id AS rowid, product_id FROM order_items ORDER BY id').all(), rowidsBefore);
  assert.deepEqual(columnsOf(migrated, 'order_items'), [
    'id',
    'order_id',
    'product_id',
    'quantity',
    'price',
    'stock_taken',
  ]);
  assert.equal(migrated.prepare('SELECT order_code FROM orders WHERE id = 1').get().order_code, 'AB12');
  // 003: колонка согласия (152-ФЗ) добавлена в конец, у старого заказа она пустая, остальные поля на месте
  assert.equal(columnsOf(migrated, 'orders').at(-1), 'consent_at');
  assert.deepEqual(migrated.prepare('SELECT status, total, paid_at, consent_at FROM orders WHERE id = 1').get(), {
    status: 'paid',
    total: 3000,
    paid_at: '2026-10-01 10:00:00',
    consent_at: null,
  });
  migrated.close();
});

test('схема Prisma совпадает с базой: ни одной колонки кофейни, ни одной лишней таблицы', () => {
  const connection = new Database(process.env.DB_PATH, { readonly: true });
  const tableNames = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tableNames, [
    '_app_migrations',
    'cart_items',
    'delivery_rates',
    'messages',
    'order_items',
    'orders',
    'products',
    'promo_codes',
    'settings',
    'user_settings',
  ]);
  assert.deepEqual(columnsOf(connection, 'products'), [
    'id',
    'name',
    'description',
    'price',
    'photo_url',
    'stock',
    'category',
    'name_en',
    'description_en',
    'category_en',
  ]);
  assert.deepEqual(columnsOf(connection, 'user_settings'), ['chat_id', 'lang', 'name']);
  for (const coffeeColumn of ['delivery_method', 'contact', 'carrier', 'addr_raw'])
    assert.ok(!columnsOf(connection, 'orders').includes(coffeeColumn), coffeeColumn);
  connection.close();
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  for (const coffeeField of [
    'unit',
    'step',
    'min_qty',
    'group_key',
    'option_label',
    'is_addon',
    'addon_for',
    'contact',
    'delivery_method',
    'Subscription',
    'BundleItem',
    'StockLogEntry',
  ]) {
    assert.doesNotMatch(schema, new RegExp(`\\b${coffeeField}\\b`), coffeeField);
  }
});

test('пустая база: стартовые радиаторы и тарифы ровно один раз', async () => {
  const { seedDatabase } = require('./seed');
  assert.equal(
    await shop.database.product.count({
      where: { category: { in: ['Дизайнерские', 'Стальные', 'Полотенцесушители', 'Секционные'] } },
    }),
    5,
  );
  assert.equal((await shop.database.deliveryRate.findUnique({ where: { city: 'Санкт-Петербург' } })).price, 40000);
  const productsBefore = await shop.database.product.count();
  await seedDatabase();
  assert.equal(await shop.database.product.count(), productsBefore);
  assert.equal(await shop.database.deliveryRate.count(), 6);
});

test('разовая правка каталога 2026-10-01: убирает тестовый товар, ставит фото Loft Black, второй раз не выполняется', async () => {
  const { runOnce, applyOneTimeFixes } = require('./one-time-fixes');
  const markerFile = path.join(path.dirname(process.env.DB_PATH), 'uploads', '.done-2026-10-01-catalog');
  assert.ok(fs.existsSync(markerFile), 'правка выполнилась при старте сервера');
  assert.match(
    (await shop.database.product.findFirst({ where: { name: 'Радиатор Loft Black' } })).photo_url,
    /cloudfront\.net\/.+\.png$/,
  );
  fs.unlinkSync(markerFile);
  const testProduct = await shop.database.product.create({
    data: { name: 'Радиатор Test', description: 'Тестовое описание', price: 100, stock: 1 },
  });
  await shop.database.cartItem.create({ data: { chat_id: 9301, product_id: testProduct.id, quantity: 1 } });
  await applyOneTimeFixes();
  assert.equal(await shop.database.product.findUnique({ where: { id: testProduct.id } }), null);
  assert.equal(await shop.database.cartItem.count({ where: { product_id: testProduct.id } }), 0);
  let runs = 0;
  await runOnce('test-key', async () => {
    runs++;
  });
  await runOnce('test-key', async () => {
    runs++;
  });
  await runOnce('broken-key', async () => {
    throw new Error('сломалось');
  });
  assert.equal(runs, 1);
  assert.ok(
    !fs.existsSync(path.join(path.dirname(process.env.DB_PATH), 'uploads', '.done-broken-key')),
    'упавшая правка повторится',
  );
});
