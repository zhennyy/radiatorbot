// Браузерная часть проверки: подмена Telegram WebApp, страница с учётом запросов и ошибок консоли, скриншоты.
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../../src/server/test-helpers');

const VIEWPORT = { width: 390, height: 844 };

function telegramMock({ initData, colorScheme }) {
  // выполняется в странице до её скриптов: подменяем Telegram.WebApp и запоминаем, что с ним делали
  window.__telegramLog = { links: [], confirms: [], closed: false };
  const buttonState = (extra) => ({ isVisible: false, show() { this.isVisible = true; }, hide() { this.isVisible = false; }, onClick(callback) { this.callback = callback; }, ...extra });
  window.Telegram = { WebApp: {
    initData, colorScheme, ready() {}, expand() {}, close() { window.__telegramLog.closed = true; },
    MainButton: buttonState({ text: '', params: {}, setParams(params) { this.params = { ...params }; this.text = params.text; }, showProgress() {}, hideProgress() {} }),
    BackButton: buttonState({}),
    HapticFeedback: { impactOccurred() {} },
    showConfirm(text, callback) { window.__telegramLog.confirms.push(text); callback(true); },
    openLink(url) { window.__telegramLog.links.push(url); },
  } };
}

// заранее известные ответы с ошибкой: битое фото товара (Loft Black, id 4) и фото из чата (подставной Telegram их не отдаёт),
// 401 у страницы, открытой не из Telegram
const EXPECTED_FAILED_REQUESTS = /\/shop-photo\/4\?|\/shop-api\/admin\/photo\//;

function createRunner(browser, baseUrl, outputDir) {
  const report = { screens: [], consoleErrors: [], expectedNetworkErrors: [], checks: [] };
  fs.mkdirSync(outputDir, { recursive: true });

  /** userId = null — страница открыта не из Telegram (без подписанных данных) */
  async function openPage(userId, { colorScheme = 'light', name, waitFor = '#grid .card' }) {
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    await context.addInitScript(telegramMock, { initData: userId ? helpers.initData(userId) : '', colorScheme });
    // настоящий telegram-web-app.js перезаписал бы подмену — отдаём пустой скрипт; внешнюю сеть не трогаем
    await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => (route.request().url().includes('telegram.org')
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }) : route.abort()));
    const page = await context.newPage();
    let inFlight = 0;
    page.on('request', () => { inFlight++; });
    page.on('requestfinished', () => { inFlight--; });
    page.on('requestfailed', () => { inFlight--; });
    page.inFlight = () => inFlight;
    page.on('pageerror', (error) => report.consoleErrors.push(`[${name}] pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const url = message.location().url || '';
      const text = `[${name}] ${message.text()} ${url}`;
      const isExpected = /Failed to load resource/.test(message.text())
        && (EXPECTED_FAILED_REQUESTS.test(url) || (!userId && /status of 401/.test(message.text())));
      if (isExpected) report.expectedNetworkErrors.push(text);
      else report.consoleErrors.push(text);
    });
    await page.goto(baseUrl + '/shop/');
    await page.waitForSelector(waitFor);
    await settle(page);
    return page;
  }

  async function settle(page, { keepToast = false } = {}) {
    for (let quietChecks = 0, attempts = 0; quietChecks < 3 && attempts < 100; attempts++) {
      await page.waitForTimeout(100);
      quietChecks = page.inFlight() === 0 ? quietChecks + 1 : 0;
    }
    await page.waitForTimeout(300);
    if (!keepToast) await page.waitForFunction(() => !document.getElementById('toast').classList.contains('on'), null, { timeout: 4000 });
  }

  async function snap(page, name, options = {}) {
    await settle(page, options);
    const file = path.join(outputDir, name + '.png');
    // спрятанный тост на длинном скриншоте может попасть в кадр, а в нём случайный код заказа — скрываем его на время съёмки;
    // то же для закрытой шторки: её прокрутка зависит от того, как Playwright докручивал до кнопок
    await page.evaluate(() => {
      const toast = document.getElementById('toast');
      if (!toast.classList.contains('on')) toast.style.visibility = 'hidden';
      if (!document.body.classList.contains('open')) document.getElementById('sheet').style.visibility = 'hidden';
    });
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
    await page.evaluate(() => { document.getElementById('toast').style.visibility = ''; document.getElementById('sheet').style.visibility = ''; });
    const telegramState = await page.evaluate(() => {
      const webApp = window.Telegram.WebApp;
      return { mainButton: webApp.MainButton.isVisible ? webApp.MainButton.text : null, backButton: webApp.BackButton.isVisible, toast: document.getElementById('toast').classList.contains('on') ? document.getElementById('toast').textContent : null, sheetScrollTop: document.getElementById('sheet').scrollTop };
    });
    report.screens.push({ name, ...telegramState });
  }

  function check(description, passed, details = '') {
    report.checks.push({ description, passed: Boolean(passed), details });
    if (!passed) console.error('ПРОВАЛ:', description, details);
  }

  return { report, openPage, snap, settle, check };
}

const pressMainButton = (page) => page.evaluate(() => window.Telegram.WebApp.MainButton.callback());
const pressBackButton = (page) => page.evaluate(() => window.Telegram.WebApp.BackButton.callback());
// закрыть шторку тапом по затемнению над ней
const closeSheetByVeil = (page) => page.locator('#veil').click({ position: { x: 10, y: 10 } });
const tabButton = (page, label) => page.locator('#tabs button', { hasText: label });
const adminSection = (page, label) => page.locator('.chips.adm .chip', { hasText: label });

module.exports = { createRunner, pressMainButton, pressBackButton, closeSheetByVeil, tabButton, adminSection, VIEWPORT };
