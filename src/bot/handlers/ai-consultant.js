// AI-консультант: подбирает товары из каталога по описанию покупателя (Claude API)
const axios = require('axios');
const { database } = require('../../database');
const { translate } = require('../../i18n');
const { formatPrice, languageOf, buildMainMenu, bothLanguages, redirectToShopIfAvailable } = require('../keyboards');
const { renderProductCard } = require('./catalog');

const CLAUDE_MODEL = 'claude-sonnet-5';
const MAX_ANSWER_TOKENS = 800;
const MAX_QUERY_LENGTH = 500;
const MAX_RECOMMENDED_PRODUCTS = 3;
const ONE_HOUR_MS = 3600000;
const MAX_TRACKED_USERS = 5000;

// Лимиты, чтобы никто не «накрутил» счёт за Claude: на человека — AI_USER_DAY запросов в сутки, на всех — AI_GLOBAL_HOUR в час
const AI_USER_DAY = Number(process.env.AI_USER_DAY || 30);
const AI_GLOBAL_HOUR = Number(process.env.AI_GLOBAL_HOUR || 200);
const usageByUser = new Map(); // id пользователя → { day, count }
let globalUsage = { hour: 0, count: 0 };

function consumeAiQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const currentHour = Math.floor(Date.now() / ONE_HOUR_MS);
  if (globalUsage.hour !== currentHour) globalUsage = { hour: currentHour, count: 0 };
  const savedUsage = usageByUser.get(String(userId));
  const userUsage = savedUsage && savedUsage.day === today ? savedUsage : { day: today, count: 0 };
  if (userUsage.count >= AI_USER_DAY || globalUsage.count >= AI_GLOBAL_HOUR) {
    throw Object.assign(new Error('AI_LIMIT'), { code: 'AI_LIMIT' });
  }
  userUsage.count++;
  globalUsage.count++;
  if (usageByUser.size > MAX_TRACKED_USERS) usageByUser.clear(); // раз в сутки ключи всё равно обновятся
  usageByUser.set(String(userId), userUsage);
}

const describeProductForAi = (product) => `#${product.id} ${product.name} (${product.category}) — ${formatPrice(product.price)}. ${product.description || ''}`;

// Совет и id подходящих товаров: { adviceText, productIds }
async function getAiRecommendation(userQuery, language, userId = 'chat') {
  consumeAiQuota(userId);
  const availableProducts = await database.product.findMany({
    where: { stock: { gt: 0 } },
    select: { id: true, name: true, description: true, price: true, category: true, stock: true },
  });
  const languageInstruction = language === 'en'
    ? 'Answer in English, friendly and to the point, no markdown formatting.'
    : 'Отвечай по-русски, дружелюбно и по делу, без markdown-разметки.';
  const systemPrompt =
    'Ты — консультант интернет-магазина отопительного оборудования RadiatorPro. ' +
    'Ниже дан текущий каталог товаров в наличии. Подбери покупателю 1-3 подходящих товара ' +
    'по его описанию (площадь и тип помещения, тип отопления, бюджет, стиль и т.п.) и кратко объясни выбор. ' +
    `${languageInstruction} ` +
    'В самом конце ответа ОБЯЗАТЕЛЬНО добавь отдельной строкой формата ' +
    '"РЕКОМЕНДАЦИИ: #id1, #id2" с ID рекомендованных товаров из каталога.\n\n' +
    `Каталог:\n${availableProducts.map(describeProductForAi).join('\n')}`;

  const response = await axios.post(
    // ANTHROPIC_BASE_URL — свой адрес-посредник для Claude (нужен на серверах в России)
    (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages',
    { model: CLAUDE_MODEL, max_tokens: MAX_ANSWER_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: userQuery }] },
    { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
  );

  // ответ может содержать служебный блок "thinking" перед текстом — берём именно текстовый блок
  const answerText = response.data.content?.find((contentBlock) => contentBlock.type === 'text')?.text || '';
  const recommendationsMatch = answerText.match(/РЕКОМЕНДАЦИИ:\s*([^\n]*)/i);
  let productIds = [];
  let adviceText = answerText.trim();
  if (recommendationsMatch) {
    const allowedIds = new Set(availableProducts.map((product) => product.id)); // только товары, которые видел ИИ
    const mentionedIds = [...recommendationsMatch[1].matchAll(/(\d+)/g)].map((idMatch) => parseInt(idMatch[1], 10));
    productIds = [...new Set(mentionedIds)].filter((productId) => allowedIds.has(productId)).slice(0, MAX_RECOMMENDED_PRODUCTS);
    adviceText = answerText.slice(0, recommendationsMatch.index).trim();
  }
  if (!adviceText) adviceText = productIds.length ? translate(language, 'aiHere') : translate(language, 'aiNoMatch');
  return { adviceText, productIds };
}

function registerAiConsultantHandlers(bot) {
  bot.hears(bothLanguages('btnAiPick'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnAiPick'), async (context) => {
    const language = await languageOf(context);
    context.session.awaitingAiConsult = true;
    await context.reply(translate(language, 'aiPickPrompt'), buildMainMenu(language));
  });
}

// Ответ на «Опишите, что вам нужно»
async function handleAiConsultInput(context) {
  const language = await languageOf(context);
  context.session.awaitingAiConsult = false;
  const query = context.message.text.trim();
  if (!query) return;
  const thinkingMessage = await context.reply(translate(language, 'aiThinking'));
  const removeThinkingMessage = () => context.telegram.deleteMessage(context.chat.id, thinkingMessage.message_id).catch(() => {});
  try {
    const { adviceText, productIds } = await getAiRecommendation(query.slice(0, MAX_QUERY_LENGTH), language, context.from.id);
    await removeThinkingMessage();
    await context.reply(adviceText || translate(language, 'aiNoRecommendation'));
    for (const productId of productIds) {
      const product = await database.product.findUnique({ where: { id: productId } });
      if (product) await renderProductCard(context, product, language);
    }
  } catch (aiError) {
    await removeThinkingMessage();
    if (aiError.code === 'AI_LIMIT') {
      return context.reply(language === 'en' ? 'The AI consultant has reached its limit for now — please try again later.' : 'ИИ-консультант на сегодня устал 🙂 Попробуйте позже.');
    }
    console.error('Ошибка AI-консультанта:', aiError.response?.status || aiError.message);
    await context.reply(translate(language, 'aiError'));
  }
}

module.exports = { registerAiConsultantHandlers, handleAiConsultInput, getAiRecommendation };
