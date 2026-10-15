// Кнопки раздела «Настройки»: сохранить доставку, добавить/удалить город и промокод.
// Сервер в ответ присылает настройки целиком — просто перерисовываем раздел.
import { callApi } from '../../api.js';
import { confirmAction, vibrate } from '../../telegram.js';
import { getElement } from '../../utils/dom.js';
import { showToast } from '../../utils/toast.js';
import { adminState } from '../admin-state.js';
import { renderSettings } from './settings-view.js';

async function saveSettings(path, body, successMessage) {
  try {
    adminState.settings = await callApi(path, body, 1);
    renderSettings();
    if (successMessage) showToast(successMessage);
    vibrate('light');
  } catch (error) {
    showToast(error.message);
  }
}

const fieldValue = (id) => getElement(id).value;
const isChecked = (id) => getElement(id).checked;

function saveDelivery() {
  saveSettings(
    '/admin/delivery',
    {
      otherPrice: fieldValue('dOther'),
      freeFrom: fieldValue('dFree'),
      pickup: isChecked('dPickup'),
      pickupAddress: fieldValue('dPickupAddr'),
    },
    'Доставка сохранена ✓',
  );
}

async function deleteAfterConfirm(question, path) {
  if (await confirmAction(question)) saveSettings(path, {}, 'Удалено');
}

export const settingsActions = {
  'save-delivery': () => saveDelivery(),
  'add-city': () =>
    saveSettings('/admin/cities', { city: fieldValue('ncity'), price: fieldValue('nprice') }, 'Город добавлен ✓'),
  'delete-city': (element) =>
    deleteAfterConfirm('Удалить город из списка доставки?', `/admin/cities/${element.dataset.cityId}/delete`),
  'add-promo': () =>
    saveSettings(
      '/admin/promos',
      { code: fieldValue('pcode'), percent: fieldValue('ppct'), max_uses: fieldValue('pmax') },
      'Промокод создан ✓',
    ),
  'toggle-promo': (checkbox) =>
    saveSettings(
      `/admin/promos/${checkbox.dataset.promoId}`,
      { active: checkbox.checked },
      checkbox.checked ? 'Промокод включён' : 'Промокод выключен',
    ),
  'delete-promo': (element) =>
    deleteAfterConfirm('Удалить промокод?', `/admin/promos/${element.dataset.promoId}/delete`),
};
