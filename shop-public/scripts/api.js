// Запросы к серверу магазина (/shop-api/...): подпись Telegram в заголовке, повтор при сбоях сети, понятные ошибки.
import { texts } from './i18n.js';
import { telegramInitData } from './telegram.js';

const API_PREFIX = '/shop-api';
const RETRY_DELAY_MS = 1200;

/** Заголовок с подписанными данными пользователя — по нему сервер узнаёт покупателя и владелицу */
export const authHeaders = () => ({ 'X-Init-Data': telegramInitData() });

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * GET (без body) или POST (с body) к API. Возвращает JSON ответа.
 * Ошибка с fatal=true не повторяется (401 вне Telegram, 4xx — ошибка в данных).
 */
export async function callApi(path, body, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(API_PREFIX + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw createApiError(texts().notInTelegram, true);
      if (!response.ok) throw createApiError(data.error || texts().loadError, response.status < 500);
      return data;
    } catch (error) {
      // сервер мог перезапускаться (обновление) — пробуем ещё пару раз
      if (error.fatal || attempt >= attempts - 1) throw error;
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

function createApiError(message, fatal) {
  const error = new Error(message);
  error.fatal = fatal;
  return error;
}
