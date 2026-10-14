// /start, знакомство по имени и переключение языка
const { Markup } = require('telegraf');
const { translate } = require('../../i18n');
const customers = require('../../customers');
const { SHOP_URL, languageOf, buildMainMenu, shopKeyboard, dropOldKeyboard, bothLanguages, redirectToShopIfAvailable } = require('../keyboards');

function registerStartHandlers(bot) {
  bot.start(async (context) => {
    const language = await languageOf(context);
    const buyerName = await customers.getName(context.chat.id);
    if (!buyerName) {
      context.session.awaitingName = true;
      if (SHOP_URL) {
        context.session.kbRemoved = true;
        await context.reply(translate(language, 'welcomeShop'), Markup.removeKeyboard());
      } else {
        await context.reply(translate(language, 'welcome'), buildMainMenu(language));
      }
      await context.reply(translate(language, 'askName'));
      return;
    }
    if (!SHOP_URL) return context.reply(translate(language, 'welcomeBack', buyerName), buildMainMenu(language));
    await dropOldKeyboard(context);
    await context.reply(translate(language, 'welcomeBackShop', buyerName), shopKeyboard(language));
  });

  bot.hears(bothLanguages('btnLanguage'), redirectToShopIfAvailable);
  bot.hears(bothLanguages('btnLanguage'), async (context) => {
    const language = await languageOf(context);
    await context.reply(translate(language, 'chooseLanguage'),
      Markup.inlineKeyboard([[Markup.button.callback('🇷🇺 Русский', 'lang_ru'), Markup.button.callback('🇬🇧 English', 'lang_en')]]));
  });

  bot.action(/^lang_(ru|en)$/, async (context) => {
    const chosenLanguage = context.match[1];
    await customers.setLanguage(context.chat.id, chosenLanguage);
    await context.answerCbQuery();
    await context.reply(translate(chosenLanguage, 'languageSet'), buildMainMenu(chosenLanguage));
  });
}

// Ответ на «Как вас зовут?». Возвращает true, если сообщение обработано как имя.
async function handleNameInput(context, next) {
  const language = await languageOf(context);
  context.session.awaitingName = false;
  const enteredName = context.message.text.trim().slice(0, 64);
  if (!enteredName) {
    context.session.awaitingName = true;
    return context.reply(translate(language, 'askName'));
  }
  // Вместо имени сразу написали вопрос — не записываем его как имя: берём имя из Telegram, а сообщение передаём менеджеру
  const looksLikeQuestion = enteredName.length > 30 || /[?!.,:;()\d]/.test(enteredName) || enteredName.split(/\s+/).length > 3;
  if (looksLikeQuestion) {
    await customers.setName(context.chat.id, (context.from.first_name || '').slice(0, 64) || '—');
    if (SHOP_URL) await context.reply(translate(language, 'nameSavedShop', context.from.first_name || ''), shopKeyboard(language));
    return next();
  }
  await customers.setName(context.chat.id, enteredName);
  return context.reply(
    SHOP_URL ? translate(language, 'nameSavedShop', enteredName) : translate(language, 'nameSaved', enteredName),
    SHOP_URL ? shopKeyboard(language) : buildMainMenu(language),
  );
}

module.exports = { registerStartHandlers, handleNameInput };
