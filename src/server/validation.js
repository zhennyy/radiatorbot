// Общие помощники для validation.js маршрутов.
// Проверка — это middleware перед маршрутом: разбирает запрос, кладёт готовые значения в request.validated
// или сразу отвечает ошибкой, и тогда маршрут не вызывается.
class ValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// validate(request) возвращает объект проверенных значений или бросает ValidationError
function createValidator(validate) {
  return (request, response, next) => {
    try {
      request.validated = { ...(request.validated || {}), ...(validate(request) || {}) };
    } catch (validationError) {
      if (!(validationError instanceof ValidationError)) return next(validationError);
      return response.status(validationError.statusCode).json({ error: validationError.message });
    }
    return next();
  };
}

const parsePositiveId = (value) => {
  const parsedId = parseInt(value, 10);
  return parsedId > 0 ? parsedId : 0;
};
const toKopecks = (value) => Math.round(parseFloat(String(value ?? '').replace(',', '.').replace(/\s/g, '')) * 100);
const cleanText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);

// :id в адресе → request.validated[fieldName] (0, если не число — маршрут ответит «не найдено»)
const idParamValidator = (fieldName) => createValidator((request) => ({ [fieldName]: parsePositiveId(request.params.id) }));

module.exports = { ValidationError, createValidator, parsePositiveId, toKopecks, cleanText, idParamValidator };
