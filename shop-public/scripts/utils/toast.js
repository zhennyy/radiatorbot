// Всплывающее сообщение сверху экрана (исчезает само через пару секунд).
import { getElement } from './dom.js';

const TOAST_DURATION_MS = 1800;
let hideTimer = null;

export function showToast(message) {
  const toast = getElement('toast');
  toast.textContent = message;
  toast.classList.add('on');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove('on'), TOAST_DURATION_MS);
}
