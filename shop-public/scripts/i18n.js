// Тексты интерфейса на русском и английском. Оформление и админка — только на русском, как и раньше.
import { state } from './state.js';

const TEXTS = {
  ru: {
    tabCatalog: 'Каталог', tabCart: 'Корзина', tabOrders: 'Заказы', tabAi: 'AI-подбор', tabAdmin: 'Админка',
    all: 'Все', search: 'Поиск радиаторов',
    inStock: (count) => `В наличии ${count} шт.`, lowStock: (count) => `Осталось ${count}`, outOfStock: 'Нет в наличии', nothingFound: 'Ничего не нашлось',
    checkout: (sum) => `Оформить · ${sum}`, noMoreInStock: 'Больше нет в наличии', addToCart: 'В корзину', total: 'Итого',
    loadError: 'Не получилось загрузить. Проверьте интернет и попробуйте ещё раз.', retry: 'Обновить',
    notInTelegram: 'Откройте магазин из Telegram — кнопка «🛍 Магазин» в чате с ботом.',
    cartTitle: 'Корзина', cartEmpty: 'Корзина пока пуста', toCatalog: 'Перейти в каталог',
    checkoutNote: 'Оплата картой или СБП через ЮKassa — безопасно.',
    ordersTitle: 'Мои заказы', ordersEmpty: 'Заказов пока нет', delivery: 'Доставка',
    aiTitle: 'Подберём радиатор', aiPlaceholder: 'Опишите комнату: площадь, где стоит, стиль, бюджет…', aiFind: 'Подобрать', aiWaiting: 'Подбираю',
    aiHints: ['Ванная 5 м², хром, до 10 000 ₽', 'Гостиная 25 м², белый, вертикальный', 'Лофт, чёрный, большой'],
    aiNothing: 'Под запрос ничего не нашлось — попробуйте описать иначе',
  },
  en: {
    tabCatalog: 'Catalog', tabCart: 'Cart', tabOrders: 'Orders', tabAi: 'AI pick', tabAdmin: 'Admin',
    all: 'All', search: 'Search radiators',
    inStock: (count) => `In stock: ${count}`, lowStock: (count) => `Only ${count} left`, outOfStock: 'Out of stock', nothingFound: 'Nothing found',
    checkout: (sum) => `Checkout · ${sum}`, noMoreInStock: 'No more in stock', addToCart: 'Add to cart', total: 'Total',
    loadError: 'Could not load. Check your connection and try again.', retry: 'Retry',
    notInTelegram: 'Open the shop from Telegram — the «🛍 Магазин» button in the bot chat.',
    cartTitle: 'Cart', cartEmpty: 'Your cart is empty', toCatalog: 'Go to catalog',
    checkoutNote: 'Pay by card or SBP via ЮKassa — secure.',
    ordersTitle: 'My orders', ordersEmpty: 'No orders yet', delivery: 'Delivery',
    aiTitle: 'Find the right radiator', aiPlaceholder: 'Describe the room: size, placement, style, budget…', aiFind: 'Find', aiWaiting: 'Thinking',
    aiHints: ['Bathroom 5 m², chrome, under 10 000 ₽', 'Living room 25 m², white, vertical', 'Loft, black, large'],
    aiNothing: 'Nothing matched — try describing it differently',
  },
};

/** Тексты на текущем языке */
export const texts = () => TEXTS[state.language];

export const isEnglish = () => state.language === 'en';

/** Короткая фраза на текущем языке: inLanguage('Трек-номер', 'Tracking') */
export const inLanguage = (russianText, englishText) => (isEnglish() ? englishText : russianText);
