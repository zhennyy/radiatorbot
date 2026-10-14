// Админка: список заказов и смена статуса
const express = require('express');
const { database } = require('../../../database');
const orders = require('../../../orders');
const customers = require('../../../customers');
const { asyncHandler } = require('../../async-handler');
const { orderStatusValidator } = require('./validation');

const ADMIN_ORDERS_LIMIT = 150;

function createAdminOrdersRouter({ bot, ownerAuth }) {
  const router = express.Router();

  router.get('/orders', ...ownerAuth, asyncHandler(async (request, response) => {
    const recentOrders = await database.order.findMany({ orderBy: { id: 'desc' }, take: ADMIN_ORDERS_LIMIT });
    const itemsByOrderId = await orders.getItemsByOrderId(recentOrders.map((order) => order.id));
    const ordersForAdmin = [];
    for (const order of recentOrders) {
      ordersForAdmin.push({
        id: order.id, code: order.order_code || String(order.id), status: orders.baseStatus(order.status),
        total: order.total, delivery_cost: order.delivery_cost || 0, created_at: order.created_at,
        address: String(order.address || '').replace(/ · тел\..*$/, ''), phone: orders.phoneOf(order),
        pickup: !order.delivery_city, track: order.track || '', rating: order.rating || 0, was_paid: Boolean(order.paid_at),
        promo: order.promo_code || '', discount: order.discount_percent || 0,
        buyer: (await customers.getName(order.chat_id)) || '', chat_id: order.chat_id,
        items: itemsByOrderId.get(order.id).map((orderItem) => ({ name: orderItem.name || '—', qty: orderItem.quantity, price: orderItem.price })),
      });
    }
    response.json({ orders: ordersForAdmin });
  }));

  router.post('/orders/:id/status', ...ownerAuth, orderStatusValidator, asyncHandler(async (request, response) => {
    const { orderId, newStatus, statusOptions } = request.validated;
    try {
      const updatedOrder = await orders.changeStatus(bot, orderId, newStatus, statusOptions);
      return response.json({ ok: true, status: updatedOrder.base, track: updatedOrder.track || '' });
    } catch (statusError) {
      return response.status(400).json({ error: statusError.message });
    }
  }));

  return router;
}

module.exports = { createAdminOrdersRouter };
