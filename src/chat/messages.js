// Переписка покупатель ⇄ магазин (вкладка «Чаты» в админке)
const { database } = require('../database');
const customers = require('../customers');

const CHAT_LIST_LIMIT = 100;
const CHAT_HISTORY_LIMIT = 200;

async function saveMessage({ chatId, fromOwner = false, text = null, photo = null, ownerMessageId = null }) {
  const savedMessage = await database.message.create({
    data: { chat_id: Number(chatId), from_owner: fromOwner ? 1 : 0, text, photo, owner_msg_id: ownerMessageId, is_read: fromOwner ? 1 : 0 },
  });
  return savedMessage.id;
}

const setOwnerMessageId = (messageId, ownerMessageId) =>
  database.message.update({ where: { id: messageId }, data: { owner_msg_id: ownerMessageId } });

// Владелица отвечает реплаем на копию сообщения — находим, от какого покупателя оно было
async function findChatByOwnerMessage(ownerMessageId) {
  const message = await database.message.findFirst({ where: { owner_msg_id: ownerMessageId }, select: { chat_id: true } });
  return message ? message.chat_id : null;
}

// Список чатов: последнее сообщение и число непрочитанных, свежие сверху
async function listChats() {
  const lastMessageIds = await database.message.groupBy({ by: ['chat_id'], _max: { id: true }, orderBy: { _max: { id: 'desc' } }, take: CHAT_LIST_LIMIT });
  const unreadCounts = await database.message.groupBy({ by: ['chat_id'], where: { is_read: 0, from_owner: 0 }, _count: { _all: true } });
  const unreadByChatId = new Map(unreadCounts.map((unreadGroup) => [unreadGroup.chat_id, unreadGroup._count._all]));
  const chats = [];
  for (const chatGroup of lastMessageIds) {
    const lastMessage = await database.message.findUnique({
      where: { id: chatGroup._max.id },
      select: { text: true, photo: true, from_owner: true, created_at: true },
    });
    chats.push({
      chat_id: chatGroup.chat_id,
      name: (await customers.getName(chatGroup.chat_id)) || '',
      unread: unreadByChatId.get(chatGroup.chat_id) || 0,
      last: lastMessage,
    });
  }
  return chats;
}

// Последние сообщения чата в хронологическом порядке
async function getChatHistory(chatId) {
  const recentMessages = await database.message.findMany({ where: { chat_id: Number(chatId) }, orderBy: { id: 'desc' }, take: CHAT_HISTORY_LIMIT });
  return recentMessages.reverse();
}

const markChatRead = (chatId) => database.message.updateMany({ where: { chat_id: Number(chatId), from_owner: 0 }, data: { is_read: 1 } });
const countUnread = () => database.message.count({ where: { is_read: 0, from_owner: 0 } });
const isKnownPhoto = async (fileId) => Boolean(await database.message.findFirst({ where: { photo: fileId }, select: { id: true } }));

module.exports = { saveMessage, setOwnerMessageId, findChatByOwnerMessage, listChats, getChatHistory, markChatRead, countUnread, isKnownPhoto };
