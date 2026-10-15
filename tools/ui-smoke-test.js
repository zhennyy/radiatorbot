// Проверка мини-приложения в браузере (Playwright): поднимает магазин на временной базе,
// открывает витрину как покупатель и как владелица с подменённым Telegram WebApp,
// снимает скриншоты всех экранов, проходит основные сценарии и собирает ошибки консоли.
//
//   node tools/ui-smoke-test.js --out /tmp/rad-ui/after                   — снять скриншоты
//   node tools/ui-smoke-test.js --out /tmp/rad-ui/after --compare /tmp/rad-ui/before — и сравнить попиксельно
//
// Нужен Chromium для Playwright (PLAYWRIGHT_BROWSERS_PATH). В основной `npm test` не входит.
// Части проверки — в tools/ui-smoke/: тестовые данные, подмена Telegram, сценарии покупателя и владелицы, сравнение скриншотов.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const helpers = require('../src/server/test-helpers'); // задаёт BOT_TOKEN, временную базу и порт — до остальных модулей
const { prepareShop } = require('./ui-smoke/test-data');
const { createRunner } = require('./ui-smoke/browser');
const { runBuyerScreens } = require('./ui-smoke/buyer-screens');
const { runOwnerScreens } = require('./ui-smoke/owner-screens');
const { runExtraChecks } = require('./ui-smoke/extra-checks');
const { compareScreens } = require('./ui-smoke/compare-screens');

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
}
const outputDir = readArgument('--out') || '/tmp/rad-ui/latest';
const compareDir = readArgument('--compare');

async function main() {
  const browser = await chromium.launch();
  const shop = await helpers.start();
  await prepareShop(shop);
  const runner = createRunner(browser, shop.base, outputDir);
  try {
    await runBuyerScreens(runner, shop);
    await runOwnerScreens(runner, shop);
    await runExtraChecks(runner, shop);
  } catch (error) {
    runner.report.consoleErrors.push('сценарий прерван: ' + error.message);
    console.error(error);
  }
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(runner.report, null, 2));
  const { report } = runner;
  console.log(`Экранов: ${report.screens.length} → ${outputDir}`);
  console.log(`Проверки: ${report.checks.filter((item) => item.passed).length}/${report.checks.length} пройдено`);
  console.log(`Ошибки консоли: ${report.consoleErrors.length}`, report.consoleErrors);
  console.log(
    `Ожидаемые ошибки сети (битое фото, фото из чата, 401 вне Telegram): ${report.expectedNetworkErrors.length}`,
  );
  let failed = report.consoleErrors.length > 0 || report.checks.some((item) => !item.passed);
  if (compareDir) {
    const results = await compareScreens(browser, outputDir, compareDir);
    const mismatches = results.filter((item) => item.status !== 'совпадает');
    const noisy = results.filter((item) => item.noisePixels);
    console.log(
      `Сравнение с ${compareDir}: совпало ${results.length - mismatches.length} из ${results.length}` +
        (noisy.length
          ? ` (из них ${noisy.length} с шумом сглаживания: ${noisy.map((item) => `${item.file} ${item.noisePixels} пикс.`).join(', ')})`
          : ''),
    );
    mismatches.forEach((item) => console.log('  ✗', item.file, item.status));
    failed = failed || mismatches.length > 0;
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
