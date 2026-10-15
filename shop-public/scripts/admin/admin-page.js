// Вкладка «Админка» (только владелица): меню разделов и загрузка выбранного раздела.
import { callApi } from '../api.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { adminState, ADMIN_SECTIONS } from './admin-state.js';
import { renderAdminProducts } from './products/product-list.js';
import { renderAdminOrders } from './orders/order-list.js';
import { loadStats } from './stats/stats-view.js';
import { loadChats, openChat, stopChatPolling } from './chats/chat-view.js';
import { renderSettings } from './settings/settings-view.js';
import { openProductEditor } from './products/product-editor.js';

function sectionsMenuHtml() {
  return `<div class="chips adm">${ADMIN_SECTIONS.map(([section, label]) => `<button class="chip ${adminState.section === section ? 'on' : ''}" data-action="open-admin-section" data-section="${section}">${label}${section === 'chats' ? `<em>${adminState.unreadCount || ''}</em>` : ''}</button>`).join('')}</div>`;
}

/** Число непрочитанных — на вкладке «Админка» и на кнопке «Чаты» */
export function setUnreadCount(count) {
  adminState.unreadCount = count || 0;
  const tabBadge = getElement('admBadge');
  if (tabBadge) tabBadge.textContent = adminState.unreadCount || '';
  const chatsBadge = document.querySelector('[data-section="chats"] em');
  if (chatsBadge) chatsBadge.textContent = adminState.unreadCount || '';
}

export async function loadAdmin() {
  stopChatPolling();
  getElement('v-admin').innerHTML =
    `<h1>Админка</h1>${sectionsMenuHtml()}<div id="admBody"><div class="skel" style="aspect-ratio:3/1"></div></div>`;
  document.querySelector('.chips.adm .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  try {
    switch (adminState.section) {
      case 'products':
        adminState.products = (await callApi('/admin/products')).products;
        renderAdminProducts();
        break;
      case 'orders':
        adminState.orders = (await callApi('/admin/orders')).orders;
        renderAdminOrders();
        break;
      case 'stats':
        await loadStats();
        break;
      case 'chats':
        if (adminState.openChatId) await openChat(adminState.openChatId);
        else await loadChats();
        break;
      case 'settings':
        adminState.settings = await callApi('/admin/settings');
        renderSettings();
        break;
    }
  } catch (error) {
    getElement('admBody').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

/** Кнопка «Назад» в админке: из открытого чата — к списку. true, если обработали. */
export function goBackInAdmin() {
  if (adminState.section !== 'chats' || !adminState.openChatId) return false;
  adminState.openChatId = null;
  loadAdmin();
  return true;
}

/** Открыть раздел админки (и дождаться загрузки) */
async function openSection(section) {
  adminState.section = section;
  await loadAdmin();
}

// переходы между разделами: из заказа — в чат с покупателем, из чата — к заказу, из статистики — к товару
async function showOrder(orderId) {
  adminState.orderFilter = 'all';
  await openSection('orders');
  const orderCard = getElement('ord-' + orderId);
  if (!orderCard) return;
  orderCard.scrollIntoView({ block: 'center' });
  orderCard.classList.add('flash');
}

export const adminPageActions = {
  'open-admin-section': (element) => {
    if (element.dataset.section === 'chats') adminState.openChatId = null;
    openSection(element.dataset.section);
  },
  'chat-with-buyer': (element) => {
    adminState.openChatId = Number(element.dataset.chatId);
    openSection('chats');
  },
  'go-to-order': (element) => showOrder(element.dataset.orderId),
  'open-low-stock-product': async (element) => {
    await openSection('products');
    openProductEditor(Number(element.dataset.productId));
  },
};
