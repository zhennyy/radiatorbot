-- Prisma нужен первичный ключ у каждой таблицы: даём позициям заказа свой id (берём прежний скрытый rowid).
CREATE TABLE order_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  stock_taken INTEGER NOT NULL DEFAULT 0
);
INSERT INTO order_items_new (id, order_id, product_id, quantity, price, stock_taken)
  SELECT rowid, order_id, product_id, quantity, price, stock_taken FROM order_items;
DROP TABLE order_items;
ALTER TABLE order_items_new RENAME TO order_items;
CREATE INDEX order_items_order ON order_items (order_id);
