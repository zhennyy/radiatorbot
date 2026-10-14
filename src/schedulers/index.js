// Фоновые задачи по расписанию
const { checkLowStock } = require('../notifications');

const ONE_HOUR_MS = 60 * 60 * 1000;

function startSchedulers(bot) {
  const timers = [
    // проверка низкого остатка раз в час
    setInterval(() => checkLowStock(bot).catch((stockError) => console.error('Склад:', stockError.message)), ONE_HOUR_MS),
  ];
  return () => timers.forEach(clearInterval);
}

module.exports = { startSchedulers };
