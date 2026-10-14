// Подготовка базы при старте: миграции и стартовые данные
const { connect } = require('./index');
const { seedDatabase } = require('./seed');

async function initializeDatabase() {
  connect(); // применяет миграции и создаёт клиент Prisma
  await seedDatabase();
}

module.exports = { initializeDatabase };
