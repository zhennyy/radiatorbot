// chat.js — живое общение в Telegram:
//  • покупатель пишет боту → сообщение уходит владелице и в «Чаты» админки;
//  • владелица отвечает реплаем, кнопкой «💬 Написать» или из админки → ответ приходит покупателю;
//  • кнопки статусов под уведомлением о новом заказе;
//  • оценка ⭐ после доставки.
const db = require('./db');
const orders = require('./orders');

const isOwnerId = (id) => Boolean(process.env.OWNER_CHAT_ID) && String(id) === String(process.env.OWNER_CHAT_ID);
const esc = orders.esc;

// Владелица отвечает покупателю (из Telegram или из админки)
async function sendToBuyer(bot, chatId, { text, photo }) {
  const lang = db.getLang(chatId);
  const head = lang === 'en' ? '💬 <b>RadiatorPro</b>' : '💬 <b>Магазин RadiatorPro</b>';
  const url = orders.shopUrl();
  const reply_markup = url ? { inline_keyboard: [[{ text: lang === 'en' ? '🛍 Open the shop' : '🛍 Открыть магазин', web_app: { url } }]] } : undefined;
  if (photo) {
    await bot.telegram.sendPhoto(chatId, photo, { caption: text ? `${head}\n${escFit(text, 950)}` : head, parse_mode: 'HTML', reply_markup });
  } else {
    await bot.telegram.sendMessage(chatId, `${head}\n${escFit(text, 4000)}`, { parse_mode: 'HTML', reply_markup });
  }
  db.addMessage({ chatId, fromOwner: true, text: text || null, photo: photo || null });
}

const replyTo = new Map(); // владелица нажала «💬 Написать» → следующий её текст уйдёт этому покупателю
const acked = new Map();   // кому уже сказали «передали менеджеру» (не чаще раза в 30 минут)
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// Экранируем и укладываемся в лимит Telegram (после экранирования «&» превращается в «&amp;»)
function escFit(text, max) {
  let t = String(text || '');
  while (t && esc(t).length > max) t = cut(t, Math.floor(t.length * 0.8));
  return esc(t);
}

// Кнопки (статусы, ответ, оценка) — регистрируются ДО сценария оформления, чтобы работали всегда
function setupActions(bot) {
  // ── Кнопки статусов под уведомлением владелице ──
  bot.action(/^ost:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwnerId(ctx.from.id)) return ctx.answerCbQuery('Только для владелицы');
    const [, id, status] = ctx.match;
    try {
      if (status === 'cancelled') {
        const o = orders.getOrder(Number(id));
        if (o && o.base !== 'cancelled') {
          // отмену переспрашиваем — заменяем кнопки на «Да / Нет»
          await ctx.editMessageReplyMarkup({ inline_keyboard: [[
            { text: '❌ Да, отменить', callback_data: `ocx:${id}` },
            { text: '← Назад', callback_data: `oback:${id}` },
          ]] });
          return ctx.answerCbQuery('Точно отменить?');
        }
      }
      const o = await orders.changeStatus(bot, Number(id), status);
      await ctx.editMessageText(orders.ownerText(o), { parse_mode: 'HTML', reply_markup: orders.ownerKeyboard(o), disable_web_page_preview: true }).catch(() => {});
      await ctx.answerCbQuery(`${orders.statusLabel(o, 'ru')} — покупателю отправлено уведомление`);
    } catch (e) { await ctx.answerCbQuery(e.message); }
  });
  bot.action(/^ocx:(\d+)$/, async (ctx) => {
    if (!isOwnerId(ctx.from.id)) return ctx.answerCbQuery();
    try {
      const before = orders.getOrder(Number(ctx.match[1]));
      const o = await orders.changeStatus(bot, Number(ctx.match[1]), 'cancelled');
      await ctx.editMessageText(orders.ownerText(o), { parse_mode: 'HTML', reply_markup: orders.ownerKeyboard(o), disable_web_page_preview: true }).catch(() => {});
      await ctx.answerCbQuery(before && orders.PAID.has(before.base) ? 'Заказ отменён, товар вернулся на склад' : 'Заказ отменён');
      if (before && orders.PAID.has(before.base) && o.payment_provider === 'yookassa') {
        await ctx.reply(`Если заказ № ${o.code} был оплачен — верните деньги в личном кабинете ЮKassa (Платежи → нужный платёж → «Вернуть»).`).catch(() => {});
      }
    } catch (e) { await ctx.answerCbQuery(e.message); }
  });
  bot.action(/^oback:(\d+)$/, async (ctx) => {
    if (!isOwnerId(ctx.from.id)) return ctx.answerCbQuery();
    const o = orders.getOrder(Number(ctx.match[1]));
    if (o) await ctx.editMessageReplyMarkup(orders.ownerKeyboard(o)).catch(() => {});
    await ctx.answerCbQuery();
  });

  // ── «💬 Написать покупателю» ──
  bot.action(/^reply:(\d+)$/, async (ctx) => {
    if (!isOwnerId(ctx.from.id)) return ctx.answerCbQuery();
    const chatId = Number(ctx.match[1]);
    replyTo.set(String(ctx.from.id), { chatId, until: Date.now() + 15 * 60_000 });
    await ctx.answerCbQuery();
    await ctx.reply(`✍️ Напишите ответ для ${db.getName(chatId) || 'покупателя'} — следующее сообщение уйдёт ему.\nПередумали — /cancel`);
  });

  // ── Оценка после доставки ──
  bot.action(/^rate:(\d+):([1-5])$/, async (ctx) => {
    const o = await orders.rate(bot, ctx.from.id, Number(ctx.match[1]), Number(ctx.match[2]));
    if (!o) return ctx.answerCbQuery();
    const lang = db.getLang(ctx.from.id);
    await ctx.answerCbQuery(lang === 'en' ? 'Thank you! 🙏' : 'Спасибо за оценку! 🙏');
    await ctx.editMessageReplyMarkup(orders.buyerKeyboard(o, lang)).catch(() => {});
    if (o.rating <= 3) {
      await ctx.reply(lang === 'en' ? 'Sorry it wasn’t perfect 😔 Tell us what went wrong — just write here, we read every message.'
        : 'Жаль, что не всё прошло идеально 😔 Расскажите, что не так — просто напишите сюда, мы читаем каждое сообщение.').catch(() => {});
    }
  });

  bot.command('cancel', async (ctx, next) => {
    if (isOwnerId(ctx.from.id) && replyTo.delete(String(ctx.from.id))) return ctx.reply('Хорошо, ответ отменён.');
    return next();
  });

}

// Свободные сообщения — регистрируется последним, после всех кнопок и сценариев
function setupRelay(bot) {
  // Голосовые, файлы, видео, стикеры — пересылаем владелице копией
  const MEDIA = { voice: '🎤 Голосовое', audio: '🎵 Аудио', document: '📎 Файл', video: '🎬 Видео', video_note: '⭕️ Видеосообщение', sticker: 'Стикер' };
  bot.on(Object.keys(MEDIA), async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const kind = Object.keys(MEDIA).find((k) => ctx.message[k]);
    const owner = process.env.OWNER_CHAT_ID;
    if (isOwnerId(ctx.from.id)) {
      const r = ctx.message.reply_to_message;
      const w = replyTo.get(String(ctx.from.id));
      const target = (r && db.chatByOwnerMsg(r.message_id)) || (w && w.until > Date.now() ? w.chatId : null);
      if (!target || String(target) === String(ctx.from.id)) return next();
      try {
        await bot.telegram.copyMessage(target, ctx.chat.id, ctx.message.message_id);
        db.addMessage({ chatId: target, fromOwner: true, text: `[${MEDIA[kind]}]` });
        replyTo.delete(String(ctx.from.id));
        return ctx.reply(`✓ Отправлено: ${db.getName(target) || 'покупателю'}`);
      } catch (e) { return ctx.reply('Telegram не доставил: ' + e.message); }
    }
    const chatId = ctx.from.id;
    const caption = (ctx.message.caption || '').trim();
    const msgId = db.addMessage({ chatId, text: `[${MEDIA[kind]}]${caption ? ' ' + cut(caption, 3500) : ''}` });
    if (owner) {
      const name = db.getName(chatId) || ctx.from.first_name || 'Покупатель';
      await bot.telegram.sendMessage(owner, `💬 <a href="tg://user?id=${chatId}">${esc(name)}</a> прислал(а): ${MEDIA[kind]}`, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${chatId}` }]] },
      }).catch(() => null);
      const m = await bot.telegram.copyMessage(owner, ctx.chat.id, ctx.message.message_id).catch((e) => console.error('Чат: не переслала медиа', e.message));
      if (m) db.setOwnerMsgId(msgId, m.message_id);
    }
    if (Date.now() - (acked.get(chatId) || 0) > 30 * 60_000) {
      acked.set(chatId, Date.now());
      await ctx.reply(db.getLang(chatId) === 'en' ? 'Got it! Passed to our manager — we\u2019ll reply right here 💬' : 'Получили! Передали менеджеру — ответим прямо здесь 💬');
    }
  });

  bot.on(['text', 'photo'], async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const text = ctx.message.text ?? ctx.message.caption ?? '';
    if (ctx.message.text && text.startsWith('/')) return next();
    const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : null;

    // Владелица: ответ покупателю
    if (isOwnerId(ctx.from.id)) {
      let target = null;
      const r = ctx.message.reply_to_message;
      if (r) target = db.chatByOwnerMsg(r.message_id);
      const w = replyTo.get(String(ctx.from.id));
      if (!target && w && w.until > Date.now()) target = w.chatId;
      if (!target) {
        return ctx.reply('Это вы 🙂 Чтобы ответить покупателю — смахните его сообщение влево (ответить) или нажмите «💬 Написать покупателю». Все переписки — в магазине: ⚙️ Админка → 💬 Чаты.');
      }
      if (String(target) === String(ctx.from.id)) {
        replyTo.delete(String(ctx.from.id));
        return ctx.reply('Это ваше собственное сообщение (вы же и покупатель в тесте) 🙂');
      }
      try {
        await sendToBuyer(bot, target, { text, photo });
        replyTo.delete(String(ctx.from.id));
        return ctx.reply(`✓ Отправлено: ${db.getName(target) || 'покупателю'}`);
      } catch (e) {
        return ctx.reply('Telegram не доставил сообщение: ' + e.message);
      }
    }

    // Покупатель: пересылаем владелице и сохраняем для админки
    const chatId = ctx.from.id;
    if (!text.trim() && !photo) return next();
    const msgId = db.addMessage({ chatId, text: text.trim().slice(0, 4000) || null, photo });
    const owner = process.env.OWNER_CHAT_ID;
    if (owner) {
      const name = db.getName(chatId) || ctx.from.first_name || 'Покупатель';
      const last = db.prepare('SELECT order_code, id, status FROM orders WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);
      const about = last ? ` · заказ № ${last.order_code || last.id} (${orders.statusLabel({ base: orders.base(last.status), delivery_city: 1 }, 'ru')})` : '';
      const head = `💬 <a href="tg://user?id=${chatId}">${esc(name)}</a>${ctx.from.username ? ' @' + esc(ctx.from.username) : ''}${about}`;
      const url = orders.shopUrl({ tab: 'admin', adm: 'chats', chat: chatId });
      const reply_markup = { inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${chatId}` }].concat(url ? [{ text: '💬 Все чаты', web_app: { url } }] : [])] };
      // Лимиты Telegram: 4096 символов в сообщении и 1024 в подписи к фото (после экранирования)
      const m = photo
        ? await bot.telegram.sendPhoto(owner, photo, { caption: `${head}${text ? '\n' + escFit(text, 800) : ''}`, parse_mode: 'HTML', reply_markup })
          .catch((e) => console.error('Чат: не переслала фото владелице', e.message))
        : await bot.telegram.sendMessage(owner, `${head}\n${escFit(text, 3800)}`, { parse_mode: 'HTML', reply_markup })
          .catch((e) => console.error('Чат: не переслала сообщение владелице', e.message));
      if (m) db.setOwnerMsgId(msgId, m.message_id);
    }
    if (Date.now() - (acked.get(chatId) || 0) > 30 * 60_000) {
      acked.set(chatId, Date.now());
      const lang = db.getLang(chatId);
      await ctx.reply(lang === 'en' ? 'Got it! Passed to our manager — we’ll reply right here 💬' : 'Получили! Передали менеджеру — ответим прямо здесь 💬');
    }
  });
}

module.exports = { setupActions, setupRelay, sendToBuyer };
