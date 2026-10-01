// orders.js — жизнь заказа после оформления: статусы, уведомления покупателю и владелице, склад, оценки.
// Используется и сервером витрины (webhook.js), и ботом (кнопки под уведомлением владелице).
const db = require('./db');

// Порядок статусов. «Деньги получены» — это всё, что начиная с paid (кроме отмены).
const FLOW = ['paid', 'assembling', 'shipped', 'delivered'];
const PAID = new Set(FLOW);
const ALL = new Set([...FLOW, 'cancelled']); // вручную в «ждёт оплату» не возвращаем

const LABEL = {
  ru: { awaiting_payment: '⏳ Ждёт оплату', pending: '⏳ Ждёт оплату', paid: '🆕 Оплачен', assembling: '📦 Собираем',
        shipped: '🚚 Отправлен', delivered: '✅ Доставлен', cancelled: '❌ Отменён' },
  en: { awaiting_payment: '⏳ Awaiting payment', pending: '⏳ Awaiting payment', paid: '🆕 Paid', assembling: '📦 Packing',
        shipped: '🚚 Shipped', delivered: '✅ Delivered', cancelled: '❌ Cancelled' },
};
const PICKUP_SHIPPED = { ru: '🏠 Готов к выдаче', en: '🏠 Ready for pickup' };

const base = (s) => String(s || '').split(':')[0];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rub = (k) => Math.round(k / 100).toLocaleString('ru-RU') + ' ₽';
const isPickup = (o) => !o.delivery_city;

function shopUrl(params = {}) {
  const raw = process.env.SHOP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/shop/` : '');
  if (!raw) return null;
  const u = new URL(raw);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
const ownerId = () => process.env.OWNER_CHAT_ID;

function getOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  o.base = base(o.status);
  o.code = o.order_code || String(o.id);
  o.items = db.prepare(`SELECT oi.rowid AS rid, oi.product_id, oi.quantity, oi.price, oi.stock_taken, p.name, p.name_en FROM order_items oi
                        LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(id);
  return o;
}

function statusLabel(o, lang = 'ru') {
  if (o.base === 'shipped' && isPickup(o)) return PICKUP_SHIPPED[lang] || PICKUP_SHIPPED.ru;
  return (LABEL[lang] || LABEL.ru)[o.base] || o.base;
}

// Полоска прогресса: ✅ Оплачен → 📦 Собираем → ▫️ Отправлен → ▫️ Доставлен
function tracker(o, lang) {
  const names = lang === 'en'
    ? ['Paid', 'Packing', isPickup(o) ? 'Ready' : 'Shipped', isPickup(o) ? 'Picked up' : 'Delivered']
    : ['Оплачен', 'Собираем', isPickup(o) ? 'Готов' : 'Отправлен', isPickup(o) ? 'Получен' : 'Доставлен'];
  const at = FLOW.indexOf(o.base);
  return names.map((n, i) => (i < at ? '✅ ' : i === at ? '🔸 <b>' : '▫️ ') + n + (i === at ? '</b>' : '')).join('  →  ');
}

function itemsText(o, lang) {
  const lines = o.items.map((i) => `${esc((lang === 'en' && i.name_en) || i.name || '—')} × ${i.quantity} — ${rub(i.price * i.quantity)}`);
  if (o.discount_percent) lines.push(`${lang === 'en' ? 'Promo' : 'Промокод'} ${esc(o.promo_code || '')} −${o.discount_percent}%`);
  if (!isPickup(o)) lines.push(`${lang === 'en' ? 'Delivery' : 'Доставка'} — ${o.delivery_cost ? rub(o.delivery_cost) : (lang === 'en' ? 'free' : 'бесплатно')}`);
  lines.push(`<b>${lang === 'en' ? 'Total' : 'Итого'} ${rub(o.total)}</b>`);
  return lines.join('\n');
}

// Текст для покупателя — что происходит с заказом сейчас
function buyerText(o, lang = 'ru') {
  const name = db.getName(o.chat_id);
  const hi = name ? `${esc(name)}, ` : '';
  const ds = db.getDeliverySettings();
  const en = lang === 'en';
  const head = {
    paid: en ? `${hi}payment received — order <b>№ ${o.code}</b> is in the works ✅` : `${hi}оплата получена — заказ <b>№ ${o.code}</b> принят в работу ✅`,
    assembling: en ? `Packing your order <b>№ ${o.code}</b> 📦\nChecking everything and wrapping it carefully.` : `Собираем ваш заказ <b>№ ${o.code}</b> 📦\nПроверяем комплектность и бережно упаковываем.`,
    shipped: isPickup(o)
      ? (en ? `Order <b>№ ${o.code}</b> is ready for pickup 🏠` : `Заказ <b>№ ${o.code}</b> готов — можно забирать 🏠`)
      : (en ? `Order <b>№ ${o.code}</b> is on its way 🚚` : `Заказ <b>№ ${o.code}</b> отправлен 🚚`),
    delivered: en ? `Order <b>№ ${o.code}</b> delivered ✅\nThank you for choosing RadiatorPro! How did we do?` : `Заказ <b>№ ${o.code}</b> доставлен ✅\nСпасибо, что выбрали RadiatorPro! Оцените, пожалуйста, как всё прошло:`,
    cancelled: en ? `Order <b>№ ${o.code}</b> was cancelled.\nIf you already paid, the money will be returned to your card within a few days. Questions? Just write here 💬`
                  : `Заказ <b>№ ${o.code}</b> отменён.\nЕсли оплата уже прошла — деньги вернутся на карту в течение нескольких дней. Вопросы — просто напишите сюда 💬`,
  }[o.base] || `${en ? 'Order' : 'Заказ'} № ${o.code}: ${statusLabel(o, lang)}`;

  const parts = [head];
  if (PAID.has(o.base)) parts.push(tracker(o, lang));
  if (o.base !== 'cancelled') parts.push(itemsText(o, lang));
  if (o.base === 'shipped' && o.track) parts.push(`${en ? 'Tracking number' : 'Трек-номер'}: <code>${esc(o.track)}</code>`);
  if (isPickup(o) && ds.pickupAddress && ['paid', 'assembling', 'shipped'].includes(o.base)) parts.push(`📍 ${en ? 'Pickup' : 'Самовывоз'}: ${esc(ds.pickupAddress)}`);
  else if (!isPickup(o) && o.base !== 'cancelled' && o.base !== 'delivered') parts.push(`📍 ${esc(o.address || '')}`);
  return parts.join('\n\n');
}

function buyerKeyboard(o, lang = 'ru') {
  const rows = [];
  if (o.base === 'delivered' && !o.rating) {
    rows.push([1, 2, 3, 4, 5].map((n) => ({ text: `${n} ⭐`, callback_data: `rate:${o.id}:${n}` })));
  }
  const url = shopUrl({ tab: 'orders' });
  if (url) rows.push([{ text: lang === 'en' ? '📦 My orders' : '📦 Мои заказы', web_app: { url } }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Сообщение покупателю о статусе. Прошлое такое сообщение удаляем — в чате остаётся только актуальное.
async function notifyBuyer(bot, o) {
  const lang = db.getLang(o.chat_id);
  if (o.status_msg_id) await bot.telegram.deleteMessage(o.chat_id, o.status_msg_id).catch(() => {});
  const msg = await bot.telegram
    .sendMessage(o.chat_id, buyerText(o, lang), { parse_mode: 'HTML', reply_markup: buyerKeyboard(o, lang) })
    .catch((e) => console.error(`Не получилось написать покупателю (заказ ${o.code}):`, e.message));
  if (msg) db.prepare('UPDATE orders SET status_msg_id = ? WHERE id = ?').run(msg.message_id, o.id);
}

// ===== Владелице =====
function phoneOf(o) {
  const m = String(o.address || '').match(/тел\.\s*([+\d][\d\s()-]{8,})/);
  return m ? m[1].trim() : '';
}
function ownerText(o) {
  const name = db.getName(o.chat_id) || 'Покупатель';
  const lines = [
    `${o.base === 'paid' ? '🆕 <b>Новый заказ</b>' : '<b>Заказ</b>'} № ${o.code} · ${rub(o.total)}`,
    `👤 <a href="tg://user?id=${o.chat_id}">${esc(name)}</a>${phoneOf(o) ? ' · ' + esc(phoneOf(o)) : ''}`,
    '',
    itemsText(o, 'ru'),
    '',
    isPickup(o) ? '🏠 Самовывоз' : `📍 ${esc(String(o.address || '').replace(/ · тел\..*$/, ''))}`,
  ];
  if (o.track) lines.push(`🚚 Трек: <code>${esc(o.track)}</code>`);
  if (o.rating) lines.push(`⭐ Оценка: ${o.rating}/5`);
  lines.push('', `Статус: <b>${statusLabel(o, 'ru')}</b>`);
  return lines.join('\n');
}
function ownerKeyboard(o) {
  const b = (st, text) => ({ text: (o.base === st ? '• ' : '') + text, callback_data: `ost:${o.id}:${st}` });
  const rows = [];
  if (o.base === 'cancelled') rows.push([b('paid', o.paid_at ? '↩️ Вернуть в работу' : '✅ Оплачен (вручную)')]);
  else {
    rows.push([b('assembling', '📦 Собираем'), b('shipped', isPickup(o) ? '🏠 Готов к выдаче' : '🚚 Отправлен')]);
    rows.push([b('delivered', '✅ Доставлен'), b('cancelled', '❌ Отменить')]);
  }
  rows.push([{ text: '💬 Написать покупателю', callback_data: `reply:${o.chat_id}` }]);
  const url = shopUrl({ tab: 'admin' });
  if (url) rows.push([{ text: '⚙️ Открыть админку', web_app: { url } }]);
  return { inline_keyboard: rows };
}
async function notifyOwnerNew(bot, o) {
  if (!ownerId()) return;
  await bot.telegram.sendMessage(ownerId(), ownerText(o), { parse_mode: 'HTML', reply_markup: ownerKeyboard(o), disable_web_page_preview: true })
    .catch((e) => console.error('Не получилось уведомить владелицу:', e.message));
}

// ===== Склад =====
// Списываем не больше, чем есть, и запоминаем, сколько взяли. Возвращает нехватку.
function takeStock(o) {
  const short = [];
  for (const i of o.items) {
    const need = i.quantity - (i.stock_taken || 0);
    if (need <= 0) continue;
    const have = db.prepare('SELECT stock FROM products WHERE id = ?').get(i.product_id)?.stock ?? 0;
    const take = Math.max(0, Math.min(have, need));
    if (take) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(take, i.product_id);
    db.prepare('UPDATE order_items SET stock_taken = stock_taken + ? WHERE rowid = ?').run(take, i.rid);
    if (take < need) short.push(`${i.name || 'товар'} — не хватило ${need - take} шт.`);
  }
  return short;
}
// Возвращаем ровно то, что списали
function returnStock(o) {
  for (const i of o.items) {
    if (!i.stock_taken) continue;
    db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(i.stock_taken, i.product_id);
    db.prepare('UPDATE order_items SET stock_taken = 0 WHERE rowid = ?').run(i.rid);
  }
}
async function warnShortage(bot, o, short) {
  if (!short.length || !ownerId()) return;
  await bot.telegram.sendMessage(ownerId(), `⚠️ Заказ № ${o.code} оплачен, но на складе не хватило:\n${short.join('\n')}\n\nСвяжитесь с покупателем: дозаказать товар или вернуть часть денег.`).catch(() => {});
}

// Сменить статус заказа (из админки или кнопкой в Telegram)
async function changeStatus(bot, id, status, { track } = {}) {
  if (!ALL.has(status)) throw new Error('Неизвестный статус');
  const o = getOrder(id);
  if (!o) throw new Error('Заказ не найден');
  const wasPaid = PAID.has(o.base);
  const nowPaid = PAID.has(status);
  const newTrack = track === undefined ? o.track : String(track || '').trim().slice(0, 60) || null;
  if (o.base === status && newTrack === o.track) return o;

  let short = [];
  db.transaction(() => {
    if (wasPaid && status === 'cancelled') returnStock(o);         // вернули товар на склад
    if (!wasPaid && nowPaid) short = takeStock(o);                  // вернули в работу / оплачен вручную
    db.prepare(`UPDATE orders SET status = ?, track = ?, status_at = datetime('now'),
                paid_at = CASE WHEN ? THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END WHERE id = ?`)
      .run(status, newTrack, nowPaid ? 1 : 0, id);
  })();
  const updated = getOrder(id);
  await notifyBuyer(bot, updated);
  await warnShortage(bot, updated, short);
  return updated;
}

// Оплата пришла (вебхук ЮKassa). Засчитываем платёж только один раз и только «свой»:
// повтор уведомления после возврата денег или чужой платёж заказ не «оживят».
async function markPaid(bot, orderId, paymentId) {
  let o = getOrder(orderId);
  if (!o || o.paid_at || PAID.has(o.base)) return false;       // деньги по заказу уже засчитаны
  const own = o.payment_id || (String(o.status).startsWith('awaiting_payment:') ? String(o.status).slice(17) : null);
  if (!paymentId || own !== paymentId) return false;           // это не платёж этого заказа
  const wasCancelled = o.base === 'cancelled';
  let short = [];
  const done = db.transaction(() => {
    o = getOrder(orderId);                                       // перечитали внутри транзакции
    if (o.paid_at) return false;
    short = takeStock(o);
    db.prepare("UPDATE orders SET status = 'paid', status_at = datetime('now'), paid_at = datetime('now') WHERE id = ?").run(orderId);
    if (o.promo_code) db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?').run(o.promo_code);
    return true;
  })();
  if (!done) return false;
  const paid = getOrder(orderId);
  await notifyBuyer(bot, paid);
  await notifyOwnerNew(bot, paid);
  await warnShortage(bot, paid, short);
  if (wasCancelled && ownerId()) {
    await bot.telegram.sendMessage(ownerId(), `⚠️ Заказ № ${paid.code} был отменён, но покупатель всё-таки оплатил — вернула его в работу.`).catch(() => {});
  }
  return true;
}

// Оценка после доставки
async function rate(bot, chatId, orderId, stars) {
  const o = getOrder(orderId);
  if (!o || String(o.chat_id) !== String(chatId) || o.base !== 'delivered') return null;
  if (o.rating) return o;
  db.prepare('UPDATE orders SET rating = ? WHERE id = ?').run(stars, orderId);
  if (ownerId()) {
    const name = db.getName(chatId) || 'Покупатель';
    await bot.telegram.sendMessage(ownerId(), `${'⭐'.repeat(stars)} ${esc(name)} оценил(а) заказ № ${o.code} на ${stars}/5`, { parse_mode: 'HTML' }).catch(() => {});
  }
  return getOrder(orderId);
}

module.exports = { FLOW, PAID, ALL, LABEL, base, getOrder, statusLabel, buyerText, buyerKeyboard, notifyBuyer,
  ownerText, ownerKeyboard, notifyOwnerNew, changeStatus, markPaid, rate, shopUrl, phoneOf, isPickup, esc, rub };
