// Живое общение в Telegram:
//  • покупатель пишет боту → сообщение уходит владелице и в «Чаты» админки;
//  • владелица отвечает реплаем, кнопкой «💬 Написать» или из админки → ответ приходит покупателю;
//  • кнопки статусов под уведомлением о новом заказе;
//  • оценка ⭐ после доставки.
const { database } = require('../database');
const orders = require('../orders');
const customers = require('../customers');
const messages = require('./messages');

const REPLY_WINDOW_MS = 15 * 60_000; // после «💬 Написать» следующее сообщение владелицы уйдёт покупателю
const ACKNOWLEDGE_INTERVAL_MS = 30 * 60_000; // «передали менеджеру» — не чаще раза в 30 минут
const TELEGRAM_TEXT_LIMIT = 4000;
const TELEGRAM_CAPTION_LIMIT = 950;
const MEDIA_LABELS = {
  voice: '🎤 Голосовое',
  audio: '🎵 Аудио',
  document: '📎 Файл',
  video: '🎬 Видео',
  video_note: '⭕️ Видеосообщение',
  sticker: 'Стикер',
};

const isOwnerChat = (chatId) =>
  Boolean(process.env.OWNER_CHAT_ID) && String(chatId) === String(process.env.OWNER_CHAT_ID);
const escapeHtml = orders.escapeHtml;
const truncate = (text, maxLength) => (text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text);

// Экранируем и укладываемся в лимит Telegram (после экранирования «&» превращается в «&amp;»)
function escapeToFit(text, maxLength) {
  let fittingText = String(text || '');
  while (fittingText && escapeHtml(fittingText).length > maxLength)
    fittingText = truncate(fittingText, Math.floor(fittingText.length * 0.8));
  return escapeHtml(fittingText);
}

// Имя покупателя в сообщениях владелице — только имя из профиля Telegram (данные самого Telegram), не то, что он ввёл у нас (152-ФЗ)
const telegramFirstName = (context) => context.from.first_name || 'Покупатель';

const replyTargets = new Map(); // id владелицы → { chatId, until }
const acknowledgedAt = new Map(); // id покупателя → когда сказали «передали менеджеру»

// Владелица отвечает покупателю (из Telegram или из админки)
async function sendToBuyer(bot, chatId, { text, photo }) {
  const language = await customers.getLanguage(chatId);
  const header = language === 'en' ? '💬 <b>RadiatorPro</b>' : '💬 <b>Магазин RadiatorPro</b>';
  const shopLink = orders.shopUrl();
  const replyMarkup = shopLink
    ? {
        inline_keyboard: [
          [{ text: language === 'en' ? '🛍 Open the shop' : '🛍 Открыть магазин', web_app: { url: shopLink } }],
        ],
      }
    : undefined;
  if (photo) {
    const caption = text ? `${header}\n${escapeToFit(text, TELEGRAM_CAPTION_LIMIT)}` : header;
    await bot.telegram.sendPhoto(chatId, photo, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
  } else {
    await bot.telegram.sendMessage(chatId, `${header}\n${escapeToFit(text, TELEGRAM_TEXT_LIMIT)}`, {
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }
  await messages.saveMessage({ chatId, fromOwner: true, text: text || null, photo: photo || null });
}

// Кому сейчас адресован ответ владелицы: реплай на копию сообщения или недавнее «💬 Написать»
async function findReplyTarget(ownerId, replyToMessage) {
  if (replyToMessage) {
    const repliedChatId = await messages.findChatByOwnerMessage(replyToMessage.message_id);
    if (repliedChatId) return repliedChatId;
  }
  const pendingReply = replyTargets.get(String(ownerId));
  return pendingReply && pendingReply.until > Date.now() ? pendingReply.chatId : null;
}

async function acknowledgeOnce(context, chatId) {
  if (Date.now() - (acknowledgedAt.get(chatId) || 0) <= ACKNOWLEDGE_INTERVAL_MS) return;
  acknowledgedAt.set(chatId, Date.now());
  const language = await customers.getLanguage(chatId);
  await context.reply(
    language === 'en'
      ? 'Got it! Passed to our manager — we’ll reply right here 💬'
      : 'Получили! Передали менеджеру — ответим прямо здесь 💬',
  );
}

async function refreshOwnerMessage(context, order) {
  await context
    .editMessageText(await orders.ownerText(order), {
      parse_mode: 'HTML',
      reply_markup: orders.ownerKeyboard(order),
      disable_web_page_preview: true,
    })
    .catch(() => {});
}

// Кнопки (статусы, ответ, оценка) — регистрируются ДО сценария оформления, чтобы работали всегда
function setupActions(bot) {
  // ── Кнопки статусов под уведомлением владелице ──
  bot.action(/^ost:(\d+):(\w+)$/, async (context) => {
    if (!isOwnerChat(context.from.id)) return context.answerCbQuery('Только для владелицы');
    const orderId = Number(context.match[1]);
    const newStatus = context.match[2];
    try {
      if (newStatus === 'cancelled') {
        const order = await orders.getOrder(orderId);
        if (order && order.base !== 'cancelled') {
          // отмену переспрашиваем — заменяем кнопки на «Да / Нет»
          await context.editMessageReplyMarkup({
            inline_keyboard: [
              [
                { text: '❌ Да, отменить', callback_data: `ocx:${orderId}` },
                { text: '← Назад', callback_data: `oback:${orderId}` },
              ],
            ],
          });
          return context.answerCbQuery('Точно отменить?');
        }
      }
      const updatedOrder = await orders.changeStatus(bot, orderId, newStatus);
      await refreshOwnerMessage(context, updatedOrder);
      await context.answerCbQuery(`${orders.statusLabel(updatedOrder, 'ru')} — покупателю отправлено уведомление`);
    } catch (statusError) {
      await context.answerCbQuery(statusError.message);
    }
  });

  bot.action(/^ocx:(\d+)$/, async (context) => {
    if (!isOwnerChat(context.from.id)) return context.answerCbQuery();
    const orderId = Number(context.match[1]);
    try {
      const orderBefore = await orders.getOrder(orderId);
      const wasPaid = Boolean(orderBefore) && orders.PAID_STATUSES.has(orderBefore.base);
      const cancelledOrder = await orders.changeStatus(bot, orderId, 'cancelled');
      await refreshOwnerMessage(context, cancelledOrder);
      await context.answerCbQuery(wasPaid ? 'Заказ отменён, товар вернулся на склад' : 'Заказ отменён');
      if (wasPaid && cancelledOrder.payment_provider === 'yookassa') {
        await context
          .reply(
            `Если заказ № ${cancelledOrder.code} был оплачен — верните деньги в личном кабинете ЮKassa (Платежи → нужный платёж → «Вернуть»).`,
          )
          .catch(() => {});
      }
    } catch (cancelError) {
      await context.answerCbQuery(cancelError.message);
    }
  });

  bot.action(/^oback:(\d+)$/, async (context) => {
    if (!isOwnerChat(context.from.id)) return context.answerCbQuery();
    const order = await orders.getOrder(Number(context.match[1]));
    if (order) await context.editMessageReplyMarkup(orders.ownerKeyboard(order)).catch(() => {});
    await context.answerCbQuery();
  });

  // ── «💬 Написать покупателю» ──
  bot.action(/^reply:(\d+)$/, async (context) => {
    if (!isOwnerChat(context.from.id)) return context.answerCbQuery();
    const buyerChatId = Number(context.match[1]);
    replyTargets.set(String(context.from.id), { chatId: buyerChatId, until: Date.now() + REPLY_WINDOW_MS });
    await context.answerCbQuery();
    await context.reply('✍️ Напишите ответ покупателю — следующее сообщение уйдёт ему.\nПередумали — /cancel');
  });

  // ── Оценка после доставки ──
  bot.action(/^rate:(\d+):([1-5])$/, async (context) => {
    const ratedOrder = await orders.rateOrder(bot, context.from.id, Number(context.match[1]), Number(context.match[2]));
    if (!ratedOrder) return context.answerCbQuery();
    const language = await customers.getLanguage(context.from.id);
    await context.answerCbQuery(language === 'en' ? 'Thank you! 🙏' : 'Спасибо за оценку! 🙏');
    await context.editMessageReplyMarkup(orders.buyerKeyboard(ratedOrder, language)).catch(() => {});
    if (ratedOrder.rating <= 3) {
      await context
        .reply(
          language === 'en'
            ? 'Sorry it wasn’t perfect 😔 Tell us what went wrong — just write here, we read every message.'
            : 'Жаль, что не всё прошло идеально 😔 Расскажите, что не так — просто напишите сюда, мы читаем каждое сообщение.',
        )
        .catch(() => {});
    }
  });

  bot.command('cancel', async (context, next) => {
    if (isOwnerChat(context.from.id) && replyTargets.delete(String(context.from.id)))
      return context.reply('Хорошо, ответ отменён.');
    return next();
  });
}

// Владелица прислала медиа в ответ покупателю — копируем его покупателю
async function forwardOwnerMedia(bot, context, mediaKind) {
  const targetChatId = await findReplyTarget(context.from.id, context.message.reply_to_message);
  if (!targetChatId || String(targetChatId) === String(context.from.id)) return false;
  try {
    await bot.telegram.copyMessage(targetChatId, context.chat.id, context.message.message_id);
    await messages.saveMessage({ chatId: targetChatId, fromOwner: true, text: `[${MEDIA_LABELS[mediaKind]}]` });
    replyTargets.delete(String(context.from.id));
    await context.reply('✓ Отправлено покупателю');
  } catch (copyError) {
    await context.reply('Telegram не доставил: ' + copyError.message);
  }
  return true;
}

// Покупатель прислал медиа — пересылаем владелице копией
async function relayBuyerMedia(bot, context, mediaKind) {
  const buyerChatId = context.from.id;
  const ownerChatId = process.env.OWNER_CHAT_ID;
  const caption = (context.message.caption || '').trim();
  const savedMessageId = await messages.saveMessage({
    chatId: buyerChatId,
    text: `[${MEDIA_LABELS[mediaKind]}]${caption ? ' ' + truncate(caption, 3500) : ''}`,
  });
  if (ownerChatId) {
    const buyerName = telegramFirstName(context);
    await bot.telegram
      .sendMessage(
        ownerChatId,
        `💬 <a href="tg://user?id=${buyerChatId}">${escapeHtml(buyerName)}</a> прислал(а): ${MEDIA_LABELS[mediaKind]}`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '↩️ Ответить', callback_data: `reply:${buyerChatId}` }]] },
        },
      )
      .catch(() => null);
    const copiedMessage = await bot.telegram
      .copyMessage(ownerChatId, context.chat.id, context.message.message_id)
      .catch((copyError) => console.error('Чат: не переслала медиа', copyError.message));
    if (copiedMessage) await messages.setOwnerMessageId(savedMessageId, copiedMessage.message_id);
  }
  await acknowledgeOnce(context, buyerChatId);
}

// Владелица пишет текст/фото — это ответ покупателю
async function handleOwnerText(bot, context, { text, photo }) {
  const targetChatId = await findReplyTarget(context.from.id, context.message.reply_to_message);
  if (!targetChatId) {
    return context.reply(
      'Это вы 🙂 Чтобы ответить покупателю — смахните его сообщение влево (ответить) или нажмите «💬 Написать покупателю». Все переписки — в магазине: ⚙️ Админка → 💬 Чаты.',
    );
  }
  if (String(targetChatId) === String(context.from.id)) {
    replyTargets.delete(String(context.from.id));
    return context.reply('Это ваше собственное сообщение (вы же и покупатель в тесте) 🙂');
  }
  try {
    await sendToBuyer(bot, targetChatId, { text, photo });
    replyTargets.delete(String(context.from.id));
    return context.reply('✓ Отправлено покупателю');
  } catch (sendError) {
    return context.reply('Telegram не доставил сообщение: ' + sendError.message);
  }
}

// Покупатель пишет текст/фото — пересылаем владелице и сохраняем для админки
async function relayBuyerText(bot, context, { text, photo }) {
  const buyerChatId = context.from.id;
  const savedMessageId = await messages.saveMessage({
    chatId: buyerChatId,
    text: text.trim().slice(0, TELEGRAM_TEXT_LIMIT) || null,
    photo,
  });
  const ownerChatId = process.env.OWNER_CHAT_ID;
  if (ownerChatId) {
    const buyerName = telegramFirstName(context);
    const lastOrder = await database.order.findFirst({
      where: { chat_id: buyerChatId },
      orderBy: { id: 'desc' },
      select: { order_code: true, id: true, status: true },
    });
    const lastOrderNote = lastOrder
      ? ` · заказ № ${lastOrder.order_code || lastOrder.id} (${orders.statusLabel({ base: orders.baseStatus(lastOrder.status), delivery_city: 1 }, 'ru')})`
      : '';
    const header = `💬 <a href="tg://user?id=${buyerChatId}">${escapeHtml(buyerName)}</a>${context.from.username ? ' @' + escapeHtml(context.from.username) : ''}${lastOrderNote}`;
    const chatsUrl = orders.shopUrl({ tab: 'admin', adm: 'chats', chat: buyerChatId });
    const replyMarkup = {
      inline_keyboard: [
        [{ text: '↩️ Ответить', callback_data: `reply:${buyerChatId}` }].concat(
          chatsUrl ? [{ text: '💬 Все чаты', web_app: { url: chatsUrl } }] : [],
        ),
      ],
    };
    // Лимиты Telegram: 4096 символов в сообщении и 1024 в подписи к фото (после экранирования)
    const forwardedMessage = photo
      ? await bot.telegram
          .sendPhoto(ownerChatId, photo, {
            caption: `${header}${text ? '\n' + escapeToFit(text, 800) : ''}`,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          })
          .catch((sendError) => console.error('Чат: не переслала фото владелице', sendError.message))
      : await bot.telegram
          .sendMessage(ownerChatId, `${header}\n${escapeToFit(text, 3800)}`, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          })
          .catch((sendError) => console.error('Чат: не переслала сообщение владелице', sendError.message));
    if (forwardedMessage) await messages.setOwnerMessageId(savedMessageId, forwardedMessage.message_id);
  }
  await acknowledgeOnce(context, buyerChatId);
}

// Свободные сообщения — регистрируется последним, после всех кнопок и сценариев
function setupRelay(bot) {
  bot.on(Object.keys(MEDIA_LABELS), async (context, next) => {
    if (context.chat?.type !== 'private') return next();
    const mediaKind = Object.keys(MEDIA_LABELS).find((kind) => context.message[kind]);
    if (isOwnerChat(context.from.id)) {
      if (!(await forwardOwnerMedia(bot, context, mediaKind))) return next();
      return undefined;
    }
    return relayBuyerMedia(bot, context, mediaKind);
  });

  bot.on(['text', 'photo'], async (context, next) => {
    if (context.chat?.type !== 'private') return next();
    const text = context.message.text ?? context.message.caption ?? '';
    if (context.message.text && text.startsWith('/')) return next();
    const photo = context.message.photo ? context.message.photo[context.message.photo.length - 1].file_id : null;
    if (isOwnerChat(context.from.id)) return handleOwnerText(bot, context, { text, photo });
    if (!text.trim() && !photo) return next();
    return relayBuyerText(bot, context, { text, photo });
  });
}

module.exports = { setupActions, setupRelay, sendToBuyer };
