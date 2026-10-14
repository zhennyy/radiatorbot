// Справочные функции о товаре: поиск по id и название, описание, категория на текущем языке.
import { state } from '../state.js';
import { isEnglish } from '../i18n.js';

export const findProduct = (productId) => state.products.find((product) => product.id == productId);

export const productName = (product) => (isEnglish() && product.name_en) || product.name;
export const productDescription = (product) => (isEnglish() && product.description_en) || product.description || '';
export const productCategory = (product) => (isEnglish() && product.category_en) || product.category || '';
