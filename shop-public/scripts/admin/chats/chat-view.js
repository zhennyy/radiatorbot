// Админка → «Чаты»: список переписок с покупателями и открытый чат (обновляется раз в 5 секунд).
import { state } from '../../state.js';
import { callApi, authHeaders } from '../../api.js';
import { vibrate } from '../../telegram.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { formatDateTime } from '../../utils/format.js';
import { showToast } from '../../utils/toast.js';
import { adminState, statusLabel } from '../admin-state.js';
import { setUnreadCount } from '../admin-page.js';

const POLL_INTERVAL_MS = 5000;
const PREVIEW_LENGTH = 70;
const MAX_REPLY_HEIGHT = 140;

let pollTimer = null;
let shownMessagesSignature = ''; // id показанных сообщений — не перерисовываем чат без новых
const photoUrlCache = new Map(); // file_id → ссылка на уже скачанную картинку

export function stopChatPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function chatRowHtml(chat) {
  const last = chat.last;
  const preview = last?.photo && !last?.text ? '📷 Фото' : escapeHtml((last?.text || '').slice(0, PREVIEW_LENGTH));
  return `
    <div class="aline" data-action="open-chat" data-chat-id="${chat.chat_id}">
      <div class="ava">${escapeHtml((chat.name || '?').slice(0, 1).toUpperCase())}</div>
      <div class="mid"><div class="t">${escapeHtml(chat.name || 'Покупатель')}</div>
        <div class="s">${last?.from_owner ? 'Вы: ' : ''}${preview}</div></div>
      <div class="cr"><small>${escapeHtml(formatDateTime(last?.created_at))}</small>${chat.unread ? `<b class="badge">${chat.unread}</b>` : ''}</div>
    </div>`;
}

export async function loadChats() {
  adminState.openChatId = null;
  stopChatPolling();
  const data = await callApi('/admin/chats');
  setUnreadCount(data.unread);
  getElement('admBody').innerHTML = data.chats.length
    ? data.chats.map(chatRowHtml).join('')
    : '<div class="empty"><b>💬</b>Сообщений пока нет.<br>Когда покупатель напишет боту — переписка появится здесь, а уведомление придёт вам в Telegram.</div>';
}

/** Фото из Telegram отдаются только владелице — скачиваем с заголовком авторизации */
async function loadProtectedPhoto(image) {
  const fileId = image.dataset.fileId;
  try {
    let url = photoUrlCache.get(fileId);
    if (!url) {
      const response = await fetch('/shop-api/admin/photo/' + encodeURIComponent(fileId), { headers: authHeaders() });
      if (!response.ok) throw new Error('фото недоступно');
      url = URL.createObjectURL(await response.blob());
      photoUrlCache.set(fileId, url);
    }
    image.src = url;
  } catch {
    image.replaceWith(Object.assign(document.createElement('span'), { textContent: '📷 фото' }));
  }
}

const messageHtml = (message) => `
    <div class="msg ${message.from_owner ? 'me' : ''}">${message.photo ? `<img data-file-id="${escapeHtml(message.photo)}" alt="">` : ''}${message.text ? `<div>${escapeHtml(message.text)}</div>` : ''}<small>${escapeHtml(formatDateTime(message.created_at))}</small></div>`;

/** keepIfUnchanged — при опросе не трогаем экран, если новых сообщений нет */
function renderChat(chat, keepIfUnchanged) {
  const signature = chat.messages.map((message) => message.id).join(',');
  if (keepIfUnchanged && signature === shownMessagesSignature) return;
  shownMessagesSignature = signature;
  const messages = chat.messages.map(messageHtml).join('');
  const orderChips = chat.orders.length
    ? `<div class="chips small">${chat.orders.map((order) => `<button class="chip" data-action="go-to-order" data-order-id="${order.id}">№ ${escapeHtml(order.code)} · ${escapeHtml(statusLabel(order.status))}</button>`).join('')}</div>`
    : '';
  getElement('admBody').innerHTML = `
    <div class="chathead"><button class="mini" data-action="open-admin-section" data-section="chats">← Чаты</button><b>${escapeHtml(chat.name || 'Покупатель')}</b></div>
    ${orderChips}
    <div class="msgs" id="msgs">${messages || '<div class="note">Сообщений пока нет — напишите первым</div>'}</div>
    <div class="composer"><textarea id="reply" rows="1" placeholder="Ответ покупателю…"></textarea><button class="btn" id="sendReply">➤</button></div>`;
  document.querySelectorAll('#msgs img[data-file-id]').forEach(loadProtectedPhoto);
  window.scrollTo(0, document.body.scrollHeight);
  const replyField = getElement('reply');
  replyField.addEventListener('input', () => {
    replyField.style.height = 'auto';
    replyField.style.height = Math.min(MAX_REPLY_HEIGHT, replyField.scrollHeight) + 'px';
  });
  getElement('sendReply').addEventListener('click', sendReply);
}

export async function openChat(chatId) {
  adminState.openChatId = chatId;
  shownMessagesSignature = '';
  const chat = await callApi('/admin/chats/' + chatId);
  setUnreadCount(chat.unread);
  renderChat(chat);
  stopChatPolling();
  pollTimer = setInterval(async () => {
    if (
      state.activeTab !== 'admin' ||
      adminState.section !== 'chats' ||
      adminState.openChatId !== chatId ||
      document.hidden
    )
      return;
    const replyField = getElement('reply');
    if (document.activeElement === replyField && replyField.value) return; // не мешаем печатать
    try {
      renderChat(await callApi('/admin/chats/' + chatId, null, 1), true);
    } catch {
      /* попробуем при следующем опросе */
    }
  }, POLL_INTERVAL_MS);
}

async function sendReply() {
  const replyField = getElement('reply');
  const text = replyField.value.trim();
  if (!text || !adminState.openChatId) return;
  getElement('sendReply').disabled = true;
  try {
    const sent = await callApi('/admin/chats/' + adminState.openChatId, { text }, 1);
    replyField.value = '';
    shownMessagesSignature = '';
    renderChat({ ...(await callApi('/admin/chats/' + adminState.openChatId)), messages: sent.messages });
    vibrate('light');
  } catch (error) {
    showToast(error.message);
  } finally {
    const sendButton = getElement('sendReply');
    if (sendButton) sendButton.disabled = false;
  }
}

export const chatActions = {
  'open-chat': (element) => openChat(Number(element.dataset.chatId)).catch((error) => showToast(error.message)),
};
