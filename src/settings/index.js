// Настройки магазина (ключ → JSON), меняются в админке витрины
const { database } = require('../database');

const DEFAULT_DELIVERY_PRICE = 150000; // 1500 ₽ — для городов не из списка
const DELIVERY_DEFAULTS = { otherPrice: DEFAULT_DELIVERY_PRICE, freeFrom: 0, pickup: true, pickupAddress: '' };

async function getSetting(key, fallbackValue) {
  const setting = await database.setting.findUnique({ where: { key } });
  if (!setting) return fallbackValue;
  try {
    return JSON.parse(setting.value);
  } catch {
    return fallbackValue;
  }
}

async function setSetting(key, value) {
  const serializedValue = JSON.stringify(value);
  await database.setting.upsert({ where: { key }, create: { key, value: serializedValue }, update: { value: serializedValue } });
}

// Доставка: цена для городов не из списка, бесплатно от суммы, самовывоз
async function getDeliverySettings() {
  return { ...DELIVERY_DEFAULTS, ...(await getSetting('delivery', {})) };
}

module.exports = { getSetting, setSetting, getDeliverySettings, DEFAULT_DELIVERY_PRICE };
