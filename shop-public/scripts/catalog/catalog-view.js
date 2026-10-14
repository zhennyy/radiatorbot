// Вкладка «Каталог»: категории, поиск и сетка карточек.
import { state } from '../state.js';
import { texts } from '../i18n.js';
import { getElement, escapeHtml } from '../utils/dom.js';
import { productCardHtml } from './product-card.js';
import { productCategory } from './product-helpers.js';

export const LOADING_GRID_HTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';

export function renderCategoryChips() {
  // категория в базе (по-русски) → подпись на текущем языке
  const categories = [...new Map(state.products.filter((product) => product.category)
    .map((product) => [product.category, productCategory(product)])).entries()];
  const allChip = `<button class="chip ${state.selectedCategory === null ? 'on' : ''}" data-action="select-category" data-category="">${texts().all}</button>`;
  getElement('chips').innerHTML = [allChip].concat(categories.map(([category, label]) => (
    `<button class="chip ${state.selectedCategory === category ? 'on' : ''}" data-action="select-category" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`
  ))).join('');
}

function matchesFilters(product, searchText) {
  if (state.selectedCategory && product.category !== state.selectedCategory) return false;
  if (!searchText) return true;
  return [product.name, product.name_en, product.description, product.category, product.category_en].join(' ').toLowerCase().includes(searchText);
}

export function renderProductGrid() {
  const searchText = state.searchQuery.trim().toLowerCase();
  const visible = state.products.filter((product) => matchesFilters(product, searchText));
  getElement('grid').innerHTML = visible.length ? visible.map(productCardHtml).join('') : `<div class="empty"><b>🔍</b>${texts().nothingFound}</div>`;
}

/** Каталог целиком — после загрузки или смены языка */
export function renderCatalog() {
  renderCategoryChips();
  renderProductGrid();
}

export function listenToCatalogInputs() {
  getElement('q').addEventListener('input', (event) => { state.searchQuery = event.target.value; renderProductGrid(); });
}

export const catalogActions = {
  'select-category': (element) => { state.selectedCategory = element.dataset.category || null; renderCategoryChips(); renderProductGrid(); },
};
