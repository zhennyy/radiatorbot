// middleware/isOwner.js
function isOwner(ctx, next) {
  if (String(ctx.chat.id) !== process.env.OWNER_CHAT_ID) {
    return; // молча игнорируем для не-владельца
  }
  return next();
}
module.exports = isOwner;
