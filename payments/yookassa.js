// payments/yookassa.js
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const auth = {
  username: process.env.YOOKASSA_SHOP_ID,
  password: process.env.YOOKASSA_SECRET_KEY,
};

async function createPayment(orderId, amountRub, description) {
  const idempotenceKey = uuidv4();
  const res = await axios.post(
    'https://api.yookassa.ru/v3/payments',
    {
      amount: { value: amountRub.toFixed(2), currency: 'RUB' },
      confirmation: { type: 'redirect', return_url: `https://t.me/${process.env.BOT_USERNAME}` },
      capture: true,
      description,
      metadata: { order_id: orderId },
    },
    { auth, headers: { 'Idempotence-Key': idempotenceKey } }
  );
  return res.data; // содержит .confirmation.confirmation_url и .id
}

async function getPayment(paymentId) {
  const res = await axios.get(`https://api.yookassa.ru/v3/payments/${paymentId}`, { auth });
  return res.data;
}

module.exports = { createPayment, getPayment };
