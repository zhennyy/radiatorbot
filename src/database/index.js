// Подключение к базе через Prisma.
// database — клиент Prisma; внутри runInTransaction он сам переключается на текущую транзакцию,
// поэтому функциям не нужно передавать транзакцию параметром.
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { PrismaClient } = require('./generated');
const { runMigrations } = require('./migrations');

const databasePath = path.resolve(process.env.DB_PATH || 'shop.db');

let prismaClient = null;
const transactionStorage = new AsyncLocalStorage();

function connect() {
  if (prismaClient) return prismaClient;
  runMigrations(databasePath);
  prismaClient = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath}` }) });
  return prismaClient;
}

// Обращение database.order.findMany(...) идёт в активную транзакцию, если она есть, иначе — в общий клиент
const database = new Proxy({}, {
  get(_target, propertyName) {
    const activeClient = transactionStorage.getStore() || connect();
    const value = activeClient[propertyName];
    return typeof value === 'function' ? value.bind(activeClient) : value;
  },
});

// Всё внутри work выполняется одной транзакцией: либо целиком, либо никак.
// Вложенный вызов просто продолжает внешнюю транзакцию.
async function runInTransaction(work) {
  if (transactionStorage.getStore()) return work();
  return connect().$transaction((transactionClient) => transactionStorage.run(transactionClient, work), { timeout: 30000, maxWait: 30000 });
}

// Время в формате, в котором SQLite хранит даты в этой базе: «2026-10-08 19:30:00» (UTC)
const toSqliteTimestamp = (date = new Date()) => new Date(date).toISOString().replace('T', ' ').slice(0, 19);

async function disconnect() {
  if (prismaClient) await prismaClient.$disconnect();
  prismaClient = null;
}

module.exports = { database, runInTransaction, toSqliteTimestamp, connect, disconnect, databasePath };
