// Тексты бота: у каждого ключа есть русский и английский вариант, бренд и тема — RadiatorPro и отопление
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { translate, STRINGS } = require('./index');

const sourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const entryPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(entryPath);
  return entry.name.endsWith('.js') && entry.name !== 'test.js' ? [entryPath] : [];
});

test('каждый ключ, который использует код, есть на обоих языках', () => {
  const usedKeys = new Set();
  for (const filePath of sourceFiles(path.join(__dirname, '..'))) {
    for (const keyMatch of fs.readFileSync(filePath, 'utf8').matchAll(/translate\((?:[\w.]+|'ru'|'en'), '(\w+)'/g)) usedKeys.add(keyMatch[1]);
  }
  assert.ok(usedKeys.size > 40, `найдено ключей: ${usedKeys.size}`);
  for (const key of usedKeys) {
    assert.ok(key in STRINGS.ru, `нет русского текста: ${key}`);
    assert.ok(key in STRINGS.en, `нет английского текста: ${key}`);
  }
});

test('бренд RadiatorPro и подсказки про отопление, без следов кофейни', () => {
  assert.match(translate('ru', 'welcome'), /RadiatorPro/);
  assert.match(translate('en', 'welcomeBackShop', 'Anna'), /^Welcome back, Anna!.*RadiatorPro — radiators and towel warmers/s);
  assert.match(translate('ru', 'aiPickPrompt'), /площадь.*тип отопления/);
  assert.match(translate('ru', 'aiNoMatch'), /тип отопления/);
  assert.equal(translate('de', 'promoLine', 'TEPLO', 10), 'Промокод «TEPLO»: −10%'); // неизвестный язык — русский
  assert.doesNotMatch(JSON.stringify(STRINGS, (key, value) => (typeof value === 'function' ? value('x', 1) : value)), /CoFFeeJD|кофе|coffee/i);
});
