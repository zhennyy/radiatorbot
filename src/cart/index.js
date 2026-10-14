// Корзина покупателя: одна строка на товар (chat_id + product_id)
const { database } = require('../database');

const PRODUCT_FIELDS_FOR_CART = { id: true, name: true, name_en: true, price: true, stock: true };

// Позиции корзины вместе с данными товара и итог в копейках
async function getCart(chatId) {
  const cartRows = await database.cartItem.findMany({ where: { chat_id: Number(chatId) } });
  const products = await database.product.findMany({
    where: { id: { in: cartRows.map((cartRow) => cartRow.product_id) } },
    select: PRODUCT_FIELDS_FOR_CART,
  });
  const productById = new Map(products.map((product) => [product.id, product]));
  const items = cartRows
    .filter((cartRow) => productById.has(cartRow.product_id)) // товар могли удалить из каталога
    .map((cartRow) => {
      const { id: productId, ...product } = productById.get(cartRow.product_id);
      return { product_id: productId, quantity: cartRow.quantity, ...product };
    });
  const total = items.reduce((sum, cartItem) => sum + cartItem.price * cartItem.quantity, 0);
  return { items, total };
}

// { [id товара]: количество } — так корзину ждёт витрина
async function getCartQuantities(chatId) {
  const cartRows = await database.cartItem.findMany({ where: { chat_id: Number(chatId) } });
  return Object.fromEntries(cartRows.map((cartRow) => [cartRow.product_id, cartRow.quantity]));
}

async function getQuantityInCart(chatId, productId) {
  const cartRow = await database.cartItem.findUnique({ where: { chat_id_product_id: { chat_id: Number(chatId), product_id: productId } } });
  return cartRow ? cartRow.quantity : 0;
}

async function countCartUnits(chatId) {
  const result = await database.cartItem.aggregate({ where: { chat_id: Number(chatId) }, _sum: { quantity: true } });
  return result._sum.quantity || 0;
}

// Поставить точное количество; 0 — убрать товар из корзины
async function setCartQuantity(chatId, productId, quantity) {
  const key = { chat_id: Number(chatId), product_id: productId };
  if (quantity <= 0) {
    await database.cartItem.deleteMany({ where: key });
    return;
  }
  await database.cartItem.upsert({ where: { chat_id_product_id: key }, create: { ...key, quantity }, update: { quantity } });
}

async function changeCartQuantityBy(chatId, productId, change) {
  const currentQuantity = await getQuantityInCart(chatId, productId);
  await setCartQuantity(chatId, productId, currentQuantity + change);
}

const removeFromCart = (chatId, productId) => setCartQuantity(chatId, productId, 0);
const clearCart = (chatId) => database.cartItem.deleteMany({ where: { chat_id: Number(chatId) } });

module.exports = { getCart, getCartQuantities, getQuantityInCart, countCartUnits, setCartQuantity, changeCartQuantityBy, removeFromCart, clearCart };
