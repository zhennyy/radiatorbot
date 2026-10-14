// Покупатель: язык интерфейса (ru/en) и имя
const { database } = require('../database');

async function findCustomer(chatId) {
  return database.userSettings.findUnique({ where: { chat_id: Number(chatId) } });
}

async function getLanguage(chatId) {
  const customer = await findCustomer(chatId);
  return customer ? customer.lang : 'ru';
}

async function getName(chatId) {
  const customer = await findCustomer(chatId);
  return customer ? customer.name : null;
}

// Сохранить поля покупателя (создаёт запись, если покупателя ещё нет)
async function updateCustomer(chatId, fields) {
  const customerChatId = Number(chatId);
  await database.userSettings.upsert({
    where: { chat_id: customerChatId },
    create: { chat_id: customerChatId, ...fields },
    update: fields,
  });
}

const setLanguage = (chatId, language) => updateCustomer(chatId, { lang: language });
const setName = (chatId, name) => updateCustomer(chatId, { name });

module.exports = { getLanguage, setLanguage, getName, setName };
