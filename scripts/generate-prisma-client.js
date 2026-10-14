// Генерация клиента Prisma (запускается автоматически после npm install).
// Для генерации движок схемы Prisma не нужен, но CLI пытается его скачать с binaries.prisma.sh,
// а этот адрес бывает закрыт (сервер в России, корпоративные сети). Подставляем заглушку, чтобы CLI не качал движок.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const environment = { ...process.env };
if (!environment.PRISMA_SCHEMA_ENGINE_BINARY) environment.PRISMA_SCHEMA_ENGINE_BINARY = process.execPath;

const prismaCli = require.resolve('prisma/build/index.js');
execFileSync(process.execPath, [prismaCli, 'generate', '--schema', path.join(__dirname, '..', 'prisma', 'schema.prisma')], {
  stdio: 'inherit',
  env: environment,
});
