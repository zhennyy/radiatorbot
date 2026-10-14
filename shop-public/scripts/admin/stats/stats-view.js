// Админка → «Статистика»: показатели за 7/30/90 дней, выручка по дням, топ товаров, города, заканчивающиеся товары.
import { callApi } from '../../api.js';
import { getElement, escapeHtml } from '../../utils/dom.js';
import { formatRubles } from '../../utils/format.js';
import { showToast } from '../../utils/toast.js';
import { adminState } from '../admin-state.js';

const PERIODS = [7, 30, 90];
const DENSE_CHART_AFTER_DAYS = 30;
const MIN_BAR_PERCENT = 4; // чтобы маленькая выручка была видна

/** «2026-10-05» → «05.10» */
const shortDate = (isoDate) => isoDate.slice(8, 10) + '.' + isoDate.slice(5, 7);
const kpiHtml = (label, value, subtitle = '') => `<div class="kpi"><span>${label}</span><b>${value}</b>${subtitle ? `<i>${subtitle}</i>` : ''}</div>`;

function kpisHtml(stats) {
  return `<div class="kpis">
      ${kpiHtml('Выручка', formatRubles(stats.revenue), stats.delivery ? `из них доставка ${formatRubles(stats.delivery)}` : '')}
      ${kpiHtml('Оплаченных заказов', stats.orders, stats.active ? `в работе сейчас: ${stats.active}` : '')}
      ${kpiHtml('Средний чек', formatRubles(stats.avg))}
      ${kpiHtml('Покупателей', stats.customers, stats.repeat ? `вернулись повторно: ${stats.repeat}` : '')}
      ${kpiHtml('Оценка', stats.rating ? `${stats.rating} ★` : '—', stats.rated ? `оценок: ${stats.rated}` : 'ещё нет оценок')}
      ${kpiHtml('Не оплачено / отмен', `${stats.unpaid} / ${stats.cancelled}`, stats.promoUsed ? `с промокодом: ${stats.promoUsed}` : '')}
    </div>`;
}

function revenueChartHtml(stats) {
  const maxRevenue = Math.max(1, ...stats.byDay.map((day) => day.revenue));
  const bars = stats.byDay.map((day) => {
    const height = day.revenue ? Math.max(MIN_BAR_PERCENT, day.revenue / maxRevenue * 100) : 0;
    return `<div class="bar" data-action="show-bar-tip" data-tip="${shortDate(day.date)}: ${formatRubles(day.revenue)} · заказов ${day.orders}"><i style="height:${height}%"></i></div>`;
  }).join('');
  return `<div class="box"><h3>Выручка по дням</h3>
      <div class="bars ${stats.days > DENSE_CHART_AFTER_DAYS ? 'dense' : ''}">${bars}</div>
      <div class="axis"><span>${shortDate(stats.byDay[0].date)}</span><span>сегодня</span></div>
    </div>`;
}

/** Горизонтальные полосы: топ товаров или города */
function rankingHtml(rows, label, caption) {
  const maxRevenue = Math.max(1, ...rows.map((row) => row.revenue));
  return rows.map((row) => `
      <div class="hbar"><div class="hl"><span>${escapeHtml(label(row))}</span><b>${formatRubles(row.revenue)}</b></div><div class="ht"><i style="width:${row.revenue / maxRevenue * 100}%"></i></div><small>${caption(row)}</small></div>`).join('');
}

function lowStockHtml(stats) {
  if (!stats.lowStock.length) return '';
  return `<div class="box"><h3>⚠️ Заканчивается</h3>${stats.lowStock.map((product) => `<div class="aline" data-action="open-low-stock-product" data-product-id="${product.id}" style="margin:0 0 6px;background:var(--bg)"><div class="mid"><div class="t">${escapeHtml(product.name)}</div><div class="s"><span class="warn">${product.stock > 0 ? 'осталось ' + product.stock + ' шт.' : 'нет в наличии'}</span></div></div><span style="color:var(--muted)">›</span></div>`).join('')}</div>`;
}

export async function loadStats() {
  const stats = await callApi('/admin/stats?days=' + adminState.statsDays);
  const topProducts = stats.top.length
    ? rankingHtml(stats.top, (product) => product.name, (product) => `${product.qty} шт.`)
    : '<div class="note" style="text-align:left">Продаж за период пока нет</div>';
  getElement('admBody').innerHTML = `
    <div class="seg">${PERIODS.map((days) => `<button data-action="stats-period" data-days="${days}" class="${adminState.statsDays === days ? 'on' : ''}">${days} дней</button>`).join('')}</div>
    ${kpisHtml(stats)}
    ${revenueChartHtml(stats)}
    <div class="box"><h3>Топ товаров</h3>${topProducts}</div>
    ${stats.cities.length ? `<div class="box"><h3>Города</h3>${rankingHtml(stats.cities, (city) => city.city, (city) => `заказов: ${city.orders}`)}</div>` : ''}
    ${lowStockHtml(stats)}`;
}

export const statsActions = {
  'stats-period': (element) => { adminState.statsDays = Number(element.dataset.days); loadStats().catch((error) => showToast(error.message)); },
  'show-bar-tip': (element) => showToast(element.dataset.tip),
};
