// Мелочи для работы с разметкой: поиск по id и экранирование текста для HTML-шаблонов.

export const getElement = (id) => document.getElementById(id);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Экранирует текст перед вставкой в HTML-шаблон (в атрибутах используем двойные кавычки) */
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
