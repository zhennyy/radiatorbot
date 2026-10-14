// Пропускает дальше только сообщения владелицы (OWNER_CHAT_ID); остальных молча игнорирует
function isOwner(context, next) {
  if (String(context.chat.id) !== process.env.OWNER_CHAT_ID) return undefined;
  return next();
}

module.exports = isOwner;
