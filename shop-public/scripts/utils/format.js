// Форматирование: цены (сервер присылает копейки), даты, звёзды оценки.
import { isEnglish } from '../i18n.js';

const KOPECKS_IN_RUBLE = 100;

/** 125000 → «1 250 ₽» */
export const formatRubles = (kopecks) => Math.round(kopecks / KOPECKS_IN_RUBLE).toLocaleString('ru-RU') + ' ₽';

/** Дата из базы (UTC, «2026-10-01 12:30:00») → «1 окт., 15:30» в часовом поясе покупателя */
export function formatDateTime(databaseDate) {
  if (!databaseDate) return '';
  const date = new Date(String(databaseDate).replace(' ', 'T') + 'Z');
  if (isNaN(date)) return '';
  return date.toLocaleString(isEnglish() ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «★★★★☆» по оценке 1–5 */
export const formatStars = (rating) => '★'.repeat(rating) + '☆'.repeat(5 - rating);
