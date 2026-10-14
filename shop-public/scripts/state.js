// Общее состояние витрины: каталог, корзина, язык, фильтры, открытая вкладка, флаги владелицы.
// Один изменяемый объект: модули читают и меняют его поля, после изменений сами вызывают нужную перерисовку.

export const state = {
  language: 'ru', // 'ru' | 'en'
  products: [], // товары с сервера
  cart: {}, // id товара → количество

  // каталог
  selectedCategory: null, // null — «Все»
  searchQuery: '',
  openProductId: null, // товар в открытой шторке

  activeTab: 'catalog', // catalog | cart | checkout | orders | ai | admin
  orders: null, // заказы покупателя («Мои заказы»)

  isOwner: false, // владелица видит вкладку «Админка»
  startTabOpened: false, // вкладка из ссылки (?tab=…) открывается только при первой загрузке
};
