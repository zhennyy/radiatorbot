// Express 4 не ловит ошибки async-обработчиков сам: передаём их в общий обработчик ошибок
const asyncHandler = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

// Ошибка с текстом для пользователя (400) — в отличие от внутренних (500)
const userError = (message, statusCode = 400) => Object.assign(new Error(message), { expose: true, statusCode });

module.exports = { asyncHandler, userError };
