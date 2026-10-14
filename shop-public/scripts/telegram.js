// Обёртка над Telegram WebApp SDK: тема, вибрация, подтверждения, ссылки на оплату.
// Вне Telegram (обычный браузер) SDK может не быть — тогда все вызовы молча пропускаются.

export const telegram = window.Telegram && window.Telegram.WebApp;

/** Открыто ли приложение внутри Telegram (есть подписанные данные пользователя) */
export const isInsideTelegram = Boolean(telegram && telegram.initData);

/** Подписанные данные пользователя для заголовка X-Init-Data */
export const telegramInitData = () => telegram?.initData || '';

export function initTelegram() {
  if (!telegram) return;
  telegram.ready();
  telegram.expand();
  document.documentElement.dataset.theme = telegram.colorScheme === 'dark' ? 'dark' : 'light';
}

/** Лёгкая вибрация: 'light' | 'medium' | 'heavy' */
export function vibrate(strength) {
  try { telegram?.HapticFeedback?.impactOccurred(strength || 'light'); } catch { /* старые клиенты Telegram */ }
}

/** Вопрос «да/нет»: в Telegram — родное окно, в браузере — confirm() */
export function confirmAction(question) {
  return new Promise((resolve) => (telegram?.showConfirm ? telegram.showConfirm(question, resolve) : resolve(window.confirm(question))));
}

export function openPaymentLink(url) {
  if (telegram?.openLink) telegram.openLink(url);
  else window.open(url, '_blank');
}
