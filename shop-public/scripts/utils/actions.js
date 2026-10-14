// Делегирование кликов: у кнопок в разметке есть data-action="имя-действия" (и данные в других data-*),
// а обработчики регистрируются по имени. Один слушатель на document обслуживает и статичную,
// и перерисованную разметку — не нужно навешивать обработчики после каждой перерисовки.

const clickActions = new Map();

/** handlers: { 'имя-действия': (element, event) => … } */
export function registerClickActions(handlers) {
  for (const [actionName, handler] of Object.entries(handlers)) {
    if (clickActions.has(actionName)) throw new Error(`Действие ${actionName} уже зарегистрировано`);
    clickActions.set(actionName, handler);
  }
}

export function listenForClickActions() {
  document.addEventListener('click', (event) => {
    // ближайший элемент с действием: кнопка «+» внутри карточки товара важнее самой карточки
    const element = event.target.closest('[data-action]');
    const handler = element && clickActions.get(element.dataset.action);
    if (handler) handler(element, event);
  });
}
