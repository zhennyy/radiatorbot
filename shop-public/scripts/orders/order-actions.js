// Действия покупателя с заказами: оплатить неоплаченный заказ (сервер выдаёт ссылку ЮKassa).
import { callApi } from '../api.js';
import { openPaymentLink } from '../telegram.js';
import { showToast } from '../utils/toast.js';

async function payExistingOrder(orderId) {
  try {
    const payment = await callApi(`/orders/${orderId}/pay`, {}, 1);
    openPaymentLink(payment.pay_url);
  } catch (error) { showToast(error.message); }
}

export const orderActions = {
  'pay-existing-order': (element) => payExistingOrder(Number(element.dataset.orderId)),
};
