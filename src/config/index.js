// Настройки из .env: читаем один раз при старте и сразу проверяем,
// чтобы бот падал с понятной ошибкой, а не через час на первой оплате.
require('dotenv').config();

const REQUIRED_VARIABLES = ['BOT_TOKEN', 'OWNER_CHAT_ID'];
// Эти пары работают только вместе: одна без другой — почти наверняка опечатка в .env
const PAIRED_VARIABLES = [['YOOKASSA_SHOP_ID', 'YOOKASSA_SECRET_KEY']];

function validateConfig() {
  const missingVariables = REQUIRED_VARIABLES.filter((variableName) => !process.env[variableName]);
  if (missingVariables.length) {
    throw new Error(`В .env не заполнено: ${missingVariables.join(', ')}`);
  }
  for (const [firstVariable, secondVariable] of PAIRED_VARIABLES) {
    if (Boolean(process.env[firstVariable]) !== Boolean(process.env[secondVariable])) {
      throw new Error(`В .env нужно заполнить оба: ${firstVariable} и ${secondVariable}`);
    }
  }
  if (!/^\d+$/.test(process.env.OWNER_CHAT_ID)) {
    throw new Error('OWNER_CHAT_ID должен быть числом (id чата владелицы)');
  }
  if (!process.env.ANTHROPIC_API_KEY) console.warn('ANTHROPIC_API_KEY не задан — AI-подбор будет отключён');
  if (!process.env.YOOKASSA_SHOP_ID) console.warn('ЮKassa не настроена — онлайн-оплата отключена');
}

module.exports = { validateConfig };
