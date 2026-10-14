// Файлы каталога: резервная копия (ZIP с фото, каталогом, заказами и промокодами приходит в чат с ботом).
import { callApi } from '../../api.js';
import { showToast } from '../../utils/toast.js';

function requestBackup() {
  showToast('Собираю резервную копию…');
  callApi('/admin/backup', {}, 1)
    .then(() => showToast('Готово — архив в чате с ботом 📦'))
    .catch((error) => showToast(error.message));
}

export const catalogFileActions = {
  'request-backup': () => requestBackup(),
};
