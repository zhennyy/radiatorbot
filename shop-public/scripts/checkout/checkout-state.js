// Данные формы оформления и расчёт стоимости: товары со скидкой, доставка, итог к оплате.
import { cartTotals } from '../cart/cart-model.js';

// введённое покупателем (сохраняется между открытиями оформления)
export const checkoutForm = {
  delivery: 'city', // city | pickup
  city: '', // город из списка или '__other'
  other: '', // свой город, если выбран «Другой город»
  address: '',
  phone: '',
  promo: '',
  promoPercent: 0,
  promoMessage: '',
  consent: false, // согласие на обработку персональных данных (152-ФЗ) — каждый раз отмечается заново, по умолчанию снято
};

export const OTHER_CITY = '__other';

export const checkout = {
  info: null, // условия доставки с сервера (/checkout-info)
  isPaying: false,
};

const discountFor = (sum) => (checkoutForm.promoPercent ? Math.round((sum * checkoutForm.promoPercent) / 100) : 0);

/** Сумма товаров со скидкой по промокоду */
export function goodsTotal() {
  const { sum } = cartTotals();
  return sum - discountFor(sum);
}

export const discountAmount = () => discountFor(cartTotals().sum);

export const isDeliveryFree = () =>
  Boolean(checkout.info && checkout.info.freeFrom > 0 && goodsTotal() >= checkout.info.freeFrom);

const normalizeCity = (city) =>
  String(city || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');

/** Стоимость доставки в копейках */
export function deliveryCost() {
  const info = checkout.info;
  if (checkoutForm.delivery === 'pickup' || !info || isDeliveryFree()) return 0;
  // «Другой город», но вписали город из списка (например «москва») — берём его тариф, как и сервер
  const wantedCity =
    checkoutForm.city === OTHER_CITY ? normalizeCity(checkoutForm.other) : normalizeCity(checkoutForm.city);
  const knownCity = info.cities.find(
    (city) => normalizeCity(city.city) === wantedCity || (city.city_en && normalizeCity(city.city_en) === wantedCity),
  );
  if (knownCity) return knownCity.price;
  return checkoutForm.city === OTHER_CITY ? info.otherPrice : 0;
}

/** Итого к оплате */
export const amountToPay = () => goodsTotal() + deliveryCost();
