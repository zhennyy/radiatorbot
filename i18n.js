// i18n.js — двуязычные тексты бота для покупателя (RU/EN)
// bilingual buyer-facing bot strings (RU/EN)
//
// Владельческие команды (/orders, /addproduct и т.п.) остаются на русском —
// это внутренний инструмент, язык покупателя на них не влияет.
// Owner-only commands stay in Russian — internal tooling, unaffected by buyer language.

const STRINGS = {
  ru: {
    welcome: 'Добро пожаловать в магазин RadiatorPro 🔥\nВыберите раздел:',
    menuPrompt: 'Меню 👇',

    btnCatalog: '📦 Каталог',
    btnSearch: '🔍 Поиск',
    btnCategories: '📂 Категории',
    btnCart: '🛒 Корзина',
    btnMyOrders: '📋 Мои заказы',
    btnAiPick: '🤖 AI-подбор',
    btnLanguage: '🌐 Язык / Language',

    noProducts: 'Товаров не найдено.',
    inStock: (n) => `📦 В наличии: ${n} шт.`,
    outOfStock: '⛔️ Нет в наличии',
    priceLabel: '💰 Цена:',
    addToCart: '➕ В корзину',
    addedToCart: 'Добавлено в корзину ✅',
    inCartQty: (n) => `✅ В корзине: ${n} · ещё +1`,
    allCategories: 'Все',
    cartShort: (n) => `🛒 Корзина · ${n}`,
    noMoreStock: 'Больше нет в наличии',
    openShopText: 'Весь каталог — в нашей витрине 👇',
    menuUpdated: 'Обновили меню ✨ Нажмите «📦 Каталог» ещё раз — откроется витрина',
    openShopBtn: '🛍 Открыть витрину',
    pageNav: 'Листать:',

    categoriesPrompt: 'Выберите категорию:',
    noCategories: 'Категории пока не заданы.',
    categoriesStale: 'Список категорий устарел, откройте его заново: 📂 Категории',

    searchPrompt: 'Введите название товара (или часть названия) для поиска:',
    searchNoResults: (term) => `Ничего не найдено по запросу «${term}».`,

    aiPickPrompt:
      'Опишите, что вам нужно: площадь и тип помещения, тип отопления, бюджет, желаемый стиль — и я подберу подходящие товары из каталога 🤖',
    aiThinking: '🤖 Подбираю варианты...',
    aiNoRecommendation: 'Не удалось сформировать рекомендацию.',
    aiError: 'Не удалось получить рекомендацию от AI-консультанта. Попробуйте ещё раз чуть позже.',
    aiHere: 'Вот что подходит по вашему запросу:',
    aiNoMatch: 'Не получилось подобрать точный вариант — уточните запрос (площадь, тип отопления, бюджет).',

    cartEmpty: 'Корзина пуста.',
    cartTitle: 'Ваша корзина:\n\n',
    cartTotal: (total) => `\nИтого: ${total}`,
    checkoutButton: '✅ Оформить заказ',
    removed: 'Удалено',

    ordersEmpty: 'У вас пока нет заказов.',
    ordersTitle: (n) => `📋 <b>Ваши заказы</b> (последние ${n})`,
    orderNumber: (id) => `Заказ #${id}`,
    promoLine: (code, pct) => `Промокод «${code}»: −${pct}%`,
    deliveryLine: (city, price) => `🚚 Доставка${city ? ` (${city})` : ''}: ${price}`,
    pickupLine: '🚚 Самовывоз',
    sumLabel: '💰 Сумма:',
    addressLabel: '📍',

    orderStatus: {
      pending: '⏳ ожидает оплаты',
      awaiting_payment: '⏳ ожидает оплаты',
      paid: '✅ оплачен',
      shipped: '🚚 отправлен',
      delivered: '📦 доставлен',
      cancelled: '❌ отменён',
    },

    // === оформление заказа / checkout ===
    cartEmptyLeave: 'Корзина пуста.',
    insufficientStock: (name, stock) => `Недостаточно на складе: ${name} (осталось ${stock})`,
    chooseDeliveryCity: 'Выберите город доставки:',
    pressButtonAbove: 'Пожалуйста, выберите вариант на кнопках выше 👆',
    sendAsText: 'Введите текст сообщением.',
    enterExactAddress: 'Введите точный адрес (улица, дом, квартира):',
    cityOtherButton: '📍 Другой город',
    pickupButton: '🏠 Самовывоз',
    enterCityName: 'Введите название города:',
    cityLabel: (city) => `Город: ${city}\nВведите точный адрес (улица, дом, квартира):`,
    pickupSet: 'Самовывоз',
    cityListStale: 'Список городов устарел, начните оформление заново: 🛒 Корзина → ✅ Оформить заказ',

    promoPrompt: 'Есть промокод? Введите код или отправьте «-», чтобы пропустить.',
    promoNotFound: 'Промокод не найден или больше не действует. Продолжаем без скидки.',
    promoExhausted: 'Промокод исчерпан. Продолжаем без скидки.',

    summaryAddress: (address) => `Адрес: ${address}`,
    summaryOrderHeader: 'Заказ:',
    summaryGreeting: (name) => `${name}, спасибо за заказ!`,
    itemsSum: (sum) => `\nСумма товаров: ${sum}`,
    deliveryFree: 'бесплатно',
    deliverySummary: (city, cost) => `\nДоставка${city ? ` (${city})` : ' (самовывоз)'}: ${cost}`,
    totalSummary: (total) => `\nИтого: ${total}`,

    payButton: '💳 Оплатить через ЮKassa',
    cancelButton: 'Отмена',
    checkoutCancelled: 'Оформление отменено.',
    payLinkText: (code) => `Ссылка для оплаты заказа ${code}:`,
    payUrlButton: 'Оплатить',
    paymentError: 'Не удалось создать платёж. Проверьте настройки ЮKassa в .env и попробуйте снова.',

    // === уведомления оплаты / доставки (payment & shipping notifications) ===
    paymentReceived: (name, id) => `${name ? name + ', ' : ''}оплата получена! Заказ #${id} принят в работу. ✅`,
    orderShipped: (name, id) => `${name ? name + ', ' : ''}ваш заказ #${id} отправлен! 🚚`,

    // === выбор языка / language switch ===
    chooseLanguage: 'Выберите язык интерфейса:',
    languageSet: 'Язык переключён на русский ✅',

    // === имя покупателя / buyer name ===
    askName: 'Как вас зовут? Буду обращаться к вам по имени 🙂',
    nameSaved: (name) => `Приятно познакомиться, ${name}! 👋`,
    welcomeBack: (name) => `С возвращением, ${name}! 🔥\nВыберите раздел:`,
  },

  en: {
    welcome: 'Welcome to the RadiatorPro shop 🔥\nChoose a section:',
    menuPrompt: 'Menu 👇',

    btnCatalog: '📦 Catalog',
    btnSearch: '🔍 Search',
    btnCategories: '📂 Categories',
    btnCart: '🛒 Cart',
    btnMyOrders: '📋 My orders',
    btnAiPick: '🤖 AI pick',
    btnLanguage: '🌐 Язык / Language',

    noProducts: 'No products found.',
    inStock: (n) => `📦 In stock: ${n} pcs.`,
    outOfStock: '⛔️ Out of stock',
    priceLabel: '💰 Price:',
    addToCart: '➕ Add to cart',
    addedToCart: 'Added to cart ✅',
    inCartQty: (n) => `✅ In cart: ${n} · add +1`,
    allCategories: 'All',
    cartShort: (n) => `🛒 Cart · ${n}`,
    noMoreStock: 'No more in stock',
    openShopText: 'The whole catalog is in our shop 👇',
    menuUpdated: 'Menu updated ✨ Tap «📦 Catalog» again to open the shop',
    openShopBtn: '🛍 Open the shop',
    pageNav: 'Browse:',

    categoriesPrompt: 'Choose a category:',
    noCategories: 'No categories set up yet.',
    categoriesStale: 'This category list is outdated, open it again: 📂 Categories',

    searchPrompt: 'Enter a product name (or part of it) to search:',
    searchNoResults: (term) => `Nothing found for "${term}".`,

    aiPickPrompt:
      "Describe what you need: room size and type, heating type, budget, preferred style — and I'll pick matching products from the catalog 🤖",
    aiThinking: '🤖 Picking options...',
    aiNoRecommendation: 'Could not put together a recommendation.',
    aiError: 'Could not get a recommendation from the AI consultant. Please try again in a bit.',
    aiHere: 'Here is what matches your request:',
    aiNoMatch: 'Could not find an exact match — please clarify your request (room size, heating type, budget).',

    cartEmpty: 'Your cart is empty.',
    cartTitle: 'Your cart:\n\n',
    cartTotal: (total) => `\nTotal: ${total}`,
    checkoutButton: '✅ Checkout',
    removed: 'Removed',

    ordersEmpty: "You don't have any orders yet.",
    ordersTitle: (n) => `📋 <b>Your orders</b> (last ${n})`,
    orderNumber: (id) => `Order #${id}`,
    promoLine: (code, pct) => `Promo code "${code}": −${pct}%`,
    deliveryLine: (city, price) => `🚚 Delivery${city ? ` (${city})` : ''}: ${price}`,
    pickupLine: '🚚 Pickup',
    sumLabel: '💰 Total:',
    addressLabel: '📍',

    orderStatus: {
      pending: '⏳ awaiting payment',
      awaiting_payment: '⏳ awaiting payment',
      paid: '✅ paid',
      shipped: '🚚 shipped',
      delivered: '📦 delivered',
      cancelled: '❌ cancelled',
    },

    // === checkout ===
    cartEmptyLeave: 'Your cart is empty.',
    insufficientStock: (name, stock) => `Not enough in stock: ${name} (${stock} left)`,
    chooseDeliveryCity: 'Choose a delivery city:',
    pressButtonAbove: 'Please choose an option using the buttons above 👆',
    sendAsText: 'Please send this as a text message.',
    enterExactAddress: 'Enter the exact address (street, building, apartment):',
    cityOtherButton: '📍 Other city',
    pickupButton: '🏠 Pickup',
    enterCityName: 'Enter the city name:',
    cityLabel: (city) => `City: ${city}\nEnter the exact address (street, building, apartment):`,
    pickupSet: 'Pickup',
    cityListStale: 'This city list is outdated, start checkout again: 🛒 Cart → ✅ Checkout',

    promoPrompt: 'Have a promo code? Enter it, or send "-" to skip.',
    promoNotFound: "This promo code wasn't found or is no longer active. Continuing without a discount.",
    promoExhausted: 'This promo code has been used up. Continuing without a discount.',

    summaryAddress: (address) => `Address: ${address}`,
    summaryOrderHeader: 'Order:',
    summaryGreeting: (name) => `${name}, thank you for your order!`,
    itemsSum: (sum) => `\nItems total: ${sum}`,
    deliveryFree: 'free',
    deliverySummary: (city, cost) => `\nDelivery${city ? ` (${city})` : ' (pickup)'}: ${cost}`,
    totalSummary: (total) => `\nTotal: ${total}`,

    payButton: '💳 Pay via ЮKassa',
    cancelButton: 'Cancel',
    checkoutCancelled: 'Checkout cancelled.',
    payLinkText: (code) => `Payment link for order ${code}:`,
    payUrlButton: 'Pay',
    paymentError: 'Could not create a payment. Check the ЮKassa settings in .env and try again.',

    // === payment & shipping notifications ===
    paymentReceived: (name, id) => `${name ? name + ', y' : 'Y'}our payment has been received! Order #${id} is now being processed. ✅`,
    orderShipped: (name, id) => `${name ? name + ', y' : 'Y'}our order #${id} has shipped! 🚚`,

    // === language switch ===
    chooseLanguage: 'Choose your interface language:',
    languageSet: 'Language switched to English ✅',

    // === buyer name ===
    askName: "What's your name? I'll use it to address you 🙂",
    nameSaved: (name) => `Nice to meet you, ${name}! 👋`,
    welcomeBack: (name) => `Welcome back, ${name}! 🔥\nChoose a section:`,
  },
};

function t(lang, key, ...args) {
  const dict = STRINGS[lang] || STRINGS.ru;
  let entry = dict[key];
  if (entry === undefined) entry = STRINGS.ru[key];
  if (typeof entry === 'function') return entry(...args);
  return entry;
}

module.exports = { t, STRINGS };
