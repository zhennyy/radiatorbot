// Общие форматтеры для сообщений в Telegram
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
const formatRubles = (kopecks) => Math.round(kopecks / 100).toLocaleString('ru-RU') + ' ₽';

module.exports = { escapeHtml, formatRubles };
