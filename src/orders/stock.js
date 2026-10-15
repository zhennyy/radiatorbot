// Склад для заказа: списать при оплате, вернуть при отмене — ровно столько, сколько списали.
const { database } = require('../database');

// Списываем не больше, чем есть, и запоминаем, сколько взяли. Возвращает список нехватки.
// Вызывается внутри runInTransaction — остаток читаем и меняем в той же транзакции.
async function takeStockForOrder(order) {
  const shortages = [];
  for (const orderItem of order.items) {
    const neededQuantity = orderItem.quantity - (orderItem.stock_taken || 0);
    if (neededQuantity <= 0) continue;
    const product = await database.product.findUnique({ where: { id: orderItem.product_id }, select: { stock: true } });
    const takenQuantity = Math.max(0, Math.min(product?.stock ?? 0, neededQuantity));
    if (takenQuantity)
      await database.product.update({
        where: { id: orderItem.product_id },
        data: { stock: { decrement: takenQuantity } },
      });
    await database.orderItem.update({
      where: { id: orderItem.id },
      data: { stock_taken: { increment: takenQuantity } },
    });
    if (takenQuantity < neededQuantity)
      shortages.push(`${orderItem.name || 'товар'} — не хватило ${neededQuantity - takenQuantity} шт.`);
  }
  return shortages;
}

// Возвращаем на склад ровно то, что списали (товар могли удалить из каталога — тогда возвращать некуда)
async function returnStockForOrder(order) {
  for (const orderItem of order.items) {
    if (!orderItem.stock_taken) continue;
    await database.product.updateMany({
      where: { id: orderItem.product_id },
      data: { stock: { increment: orderItem.stock_taken } },
    });
    await database.orderItem.update({ where: { id: orderItem.id }, data: { stock_taken: 0 } });
  }
}

module.exports = { takeStockForOrder, returnStockForOrder };
