// Точка входа мини-приложения: Telegram, язык, первая загрузка каталога, подключение обработчиков.
import { state } from './state.js';
import { texts } from './i18n.js';
import { callApi } from './api.js';
import { initTelegram } from './telegram.js';
import { getElement, escapeHtml } from './utils/dom.js';
import { registerClickActions, listenForClickActions } from './utils/actions.js';
import { switchTab, listenToTelegramButtons, navigationActions } from './navigation.js';
import { renderCatalog, listenToCatalogInputs, catalogActions, LOADING_GRID_HTML } from './catalog/catalog-view.js';
import { replaceBrokenPhotos } from './catalog/product-photo.js';
import { closeSheet, productSheetActions } from './catalog/product-sheet.js';
import { renderCart, cartActions } from './cart/cart-view.js';
import { checkoutActions } from './checkout/checkout-actions.js';
import { loadOrders } from './orders/orders-view.js';
import { orderActions } from './orders/order-actions.js';
import { renderAiTexts, listenToAiButton, aiActions } from './ai/ai-pick.js';
import { adminState, ADMIN_SECTIONS } from './admin/admin-state.js';
import { setUnreadCount, adminPageActions } from './admin/admin-page.js';
import { productEditorActions } from './admin/products/product-editor.js';
import { catalogFileActions } from './admin/products/catalog-files.js';
import { photoUploadActions, listenToPhotoFileInput } from './admin/products/photo-upload.js';
import { adminOrderActions } from './admin/orders/order-list.js';
import { statsActions } from './admin/stats/stats-view.js';
import { chatActions } from './admin/chats/chat-view.js';
import { settingsActions } from './admin/settings/settings-actions.js';

const BUYER_START_TABS = ['cart', 'orders', 'ai'];

/** Подписи статичной разметки на текущем языке */
function applyLanguage() {
  document.documentElement.lang = state.language;
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = texts()[element.dataset.i18n]; });
  document.querySelectorAll('#lang button').forEach((button) => button.classList.toggle('on', button.dataset.lang === state.language));
  getElement('q').placeholder = texts().search;
  renderAiTexts();
}

function switchLanguage(language) {
  if (language === state.language) return;
  state.language = language;
  applyLanguage();
  renderCatalog();
  renderCart();
  if (state.activeTab === 'orders') loadOrders();
  callApi('/lang', { lang: language }).catch(() => { /* язык запомнится в следующий раз */ });
}

/** Ссылка из бота может сразу открыть вкладку: ?tab=orders, а владелице — ?tab=admin&adm=chats&chat=123 */
function openStartTab() {
  const parameters = new URLSearchParams(window.location.search);
  const wantedTab = parameters.get('tab');
  if (state.isOwner && wantedTab === 'admin' && ADMIN_SECTIONS.some(([section]) => section === parameters.get('adm'))) {
    adminState.section = parameters.get('adm');
    adminState.openChatId = Number(parameters.get('chat')) || null;
  }
  const allowedTabs = state.isOwner ? [...BUYER_START_TABS, 'admin'] : BUYER_START_TABS;
  if (!state.startTabOpened && allowedTabs.includes(wantedTab)) switchTab(wantedTab);
  state.startTabOpened = true;
}

async function loadShop() {
  getElement('grid').innerHTML = LOADING_GRID_HTML;
  try {
    const catalog = await callApi('/catalog');
    state.language = catalog.lang === 'en' ? 'en' : 'ru';
    applyLanguage();
    state.products = catalog.products;
    state.cart = catalog.cart || {};
    state.isOwner = Boolean(catalog.isOwner);
    getElement('adminTab').hidden = !state.isOwner;
    getElement('tabs').classList.toggle('five', state.isOwner);
    if (state.isOwner) setUnreadCount(catalog.unread);
    renderCatalog();
    renderCart();
    openStartTab();
  } catch (error) {
    const retryButton = error.fatal ? '' : `<br><br><button class="btn ghost" data-action="retry-loading">${texts().retry}</button>`;
    getElement('grid').innerHTML = `<div class="empty"><b>😕</b>${escapeHtml(error.message)}${retryButton}</div>`;
  }
}

initTelegram();
replaceBrokenPhotos();
// каждый модуль отдаёт свои действия для data-action; совпадение имён registerClickActions не пропустит
[
  navigationActions, catalogActions, productSheetActions, cartActions, checkoutActions, orderActions, aiActions,
  adminPageActions, productEditorActions, catalogFileActions, photoUploadActions,
  adminOrderActions, statsActions, chatActions, settingsActions,
  { 'switch-language': (element) => switchLanguage(element.dataset.lang), 'retry-loading': () => loadShop() },
].forEach(registerClickActions);
listenForClickActions();
getElement('veil').addEventListener('click', closeSheet);
listenToCatalogInputs();
listenToAiButton();
listenToPhotoFileInput();
listenToTelegramButtons();
applyLanguage();
loadShop();
