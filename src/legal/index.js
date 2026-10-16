// Юридические страницы магазина (152-ФЗ): политика, согласие на обработку данных, оферта.
// Сами страницы — статические файлы в shop-public/legal/, сервер отдаёт их вместе с витриной (/shop/legal/…).
const { shopUrl } = require('../orders/messages');

const LEGAL_PAGES = { privacy: 'privacy.html', consent: 'consent.html', offer: 'offer.html' };

// Полный адрес страницы: от SHOP_URL, а если его нет — от PUBLIC_URL. Без адреса магазина — null.
function legalPageUrl(pageName) {
  const fileName = LEGAL_PAGES[pageName];
  if (!fileName) throw new Error('Неизвестная юридическая страница: ' + pageName);
  const shopAddress =
    shopUrl() || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') + '/shop/' : null);
  if (!shopAddress) return null;
  const shopBase = new URL(shopAddress);
  shopBase.search = '';
  if (!shopBase.pathname.endsWith('/')) shopBase.pathname += '/';
  return new URL('legal/' + fileName, shopBase).toString();
}

module.exports = { LEGAL_PAGES, legalPageUrl };
