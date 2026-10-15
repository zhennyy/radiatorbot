// Вкладка «AI-подбор»: покупатель описывает комнату словами, сервер (Claude) советует и подбирает товары из каталога.
import { texts } from '../i18n.js';
import { callApi } from '../api.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { showToast } from '../utils/toast.js';
import { findProduct } from '../catalog/product-helpers.js';
import { productCardHtml } from '../catalog/product-card.js';

/** Подписи и подсказки на текущем языке */
export function renderAiTexts() {
  getElement('aiTitle').textContent = texts().aiTitle;
  getElement('aiQ').placeholder = texts().aiPlaceholder;
  getElement('aiGo').textContent = texts().aiFind;
  getElement('aiHints').innerHTML = texts()
    .aiHints.map(
      (hint) =>
        `<button class="chip" data-action="ask-ai-hint" data-hint="${escapeHtml(hint)}">${escapeHtml(hint)}</button>`,
    )
    .join('');
}

async function askAi() {
  const queryField = getElement('aiQ');
  const findButton = getElement('aiGo');
  const query = queryField.value.trim();
  if (!query) {
    queryField.focus();
    return;
  }
  findButton.disabled = true;
  findButton.innerHTML = `<span class="dots">${texts().aiWaiting}</span>`;
  getElement('aiAdvice').textContent = '';
  getElement('aiGrid').innerHTML = '';
  try {
    const answer = await callApi('/ai', { query }, 1); // ответ ИИ не повторяем: это долго и платно
    getElement('aiAdvice').textContent = answer.advice || '';
    const products = (answer.ids || []).map(findProduct).filter(Boolean);
    getElement('aiGrid').innerHTML = products.length
      ? products.map(productCardHtml).join('')
      : `<div class="empty">${texts().aiNothing}</div>`;
  } catch (error) {
    showToast(error.message);
  } finally {
    findButton.disabled = false;
    findButton.textContent = texts().aiFind;
  }
}

export function listenToAiButton() {
  getElement('aiGo').addEventListener('click', askAi);
}

export const aiActions = {
  'ask-ai-hint': (element) => {
    getElement('aiQ').value = element.dataset.hint;
    askAi();
  },
};
