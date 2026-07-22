import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue, toast, escapeHtml,
} from './app.js';

const $ = (id) => document.getElementById(id);

const PRESET_CATEGORIES = ['Antipasti', 'Primi', 'Secondi', 'Dessert', 'Bibite'];
const IMAGE_BUCKET = 'menu-images';
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const state = {
  session: null,
  venue: null,
  role: null,
  canEdit: false,
  categories: [],
  settings: {
    default_language: 'it',
    secondary_language: 'en',
    show_prices: true,
    show_images: true,
    currency: 'EUR',
    cover_image: null,
  },
  selectedCategoryId: null,
  drag: null,
  timers: new Map(),
};

function langMap(rows, key) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const id = row[key];
    const language = row.language || row.locale;
    if (!language) return;
    if (!map.has(id)) map.set(id, {});
    map.get(id)[language] = { ...row, language };
  });
  return map;
}

function isLegacyLocaleError(error) {
  const message = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`;
  return message.includes('column "locale"')
    || message.includes('null value in column "locale"')
    || message.includes('Could not find the \'language\' column');
}

function mirrorLegacyLocale(row) {
  return row && row.language ? { ...row, locale: row.language } : row;
}

async function insertTranslation(table, row) {
  const result = await supabase.from(table).insert(row);
  if (result.error && isLegacyLocaleError(result.error)) {
    return supabase.from(table).insert(mirrorLegacyLocale(row));
  }
  return result;
}

async function insertTranslations(table, rows) {
  const result = await supabase.from(table).insert(rows);
  if (result.error && isLegacyLocaleError(result.error)) {
    return supabase.from(table).insert(rows.map(mirrorLegacyLocale));
  }
  return result;
}

async function upsertTranslation(table, row, onConflict) {
  const result = await supabase.from(table).upsert(row, { onConflict });
  if (result.error && isLegacyLocaleError(result.error)) {
    return supabase.from(table).upsert(mirrorLegacyLocale(row), { onConflict });
  }
  return result;
}

function categoryName(category) {
  return category.translations?.it?.name || category.translations?.en?.name || 'Senza nome';
}

function itemName(item) {
  return item.translations?.it?.name || item.translations?.en?.name || 'Nuovo piatto';
}

function selectedCategory() {
  return state.categories.find((category) => category.id === state.selectedCategoryId) || null;
}

function setSaving(message = 'Salvataggio automatico attivo') {
  const node = $('saveState');
  if (node) node.textContent = message;
}

function debounced(key, fn, delay = 520) {
  window.clearTimeout(state.timers.get(key));
  state.timers.set(key, window.setTimeout(async () => {
    setSaving('Salvataggio...');
    try {
      await fn();
      setSaving('Salvato');
      window.setTimeout(() => setSaving(), 900);
    } catch (error) {
      console.error('[menu] autosave fallito:', error);
      setSaving('Errore salvataggio');
      toast('Salvataggio non riuscito.', true);
    }
  }, delay));
}

function assertCanEdit() {
  if (state.canEdit) return true;
  toast('Solo il titolare puo modificare il menu.', true);
  return false;
}

async function loadSettings() {
  const { data, error } = await supabase
    .from('menu_settings')
    .select('*')
    .eq('venue_id', state.venue.id)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    state.settings = { ...state.settings, ...data };
    return;
  }
  if (!state.canEdit) return;
  const { data: created, error: insertError } = await supabase
    .from('menu_settings')
    .insert({ venue_id: state.venue.id })
    .select('*')
    .maybeSingle();
  if (insertError) throw insertError;
  if (created) state.settings = { ...state.settings, ...created };
}

async function loadMenuData() {
  const { data: categories, error: catError } = await supabase
    .from('menu_categories')
    .select('id, venue_id, sort_order, is_visible, created_at, updated_at')
    .eq('venue_id', state.venue.id)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (catError) throw catError;

  const categoryIds = (categories || []).map((category) => category.id);
  let categoryTranslations = [];
  let items = [];
  let itemTranslations = [];

  if (categoryIds.length) {
    const [catTr, itemRows] = await Promise.all([
      supabase.from('menu_category_translations').select('id, category_id, language, name').in('category_id', categoryIds),
      supabase
        .from('menu_items')
        .select('id, category_id, price, image_url, sort_order, available, featured, created_at, updated_at')
        .in('category_id', categoryIds)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);
    if (catTr.error) throw catTr.error;
    if (itemRows.error) throw itemRows.error;
    categoryTranslations = catTr.data || [];
    items = itemRows.data || [];
  }

  const itemIds = items.map((item) => item.id);
  if (itemIds.length) {
    const tr = await supabase.from('menu_item_translations').select('id, item_id, language, name, description').in('item_id', itemIds);
    if (tr.error) throw tr.error;
    itemTranslations = tr.data || [];
  }

  const categoryTrMap = langMap(categoryTranslations, 'category_id');
  const itemTrMap = langMap(itemTranslations, 'item_id');
  const itemsByCategory = new Map();
  items.forEach((item) => {
    if (!itemsByCategory.has(item.category_id)) itemsByCategory.set(item.category_id, []);
    itemsByCategory.get(item.category_id).push({ ...item, translations: itemTrMap.get(item.id) || {} });
  });

  state.categories = (categories || []).map((category) => ({
    ...category,
    translations: categoryTrMap.get(category.id) || {},
    items: itemsByCategory.get(category.id) || [],
  }));

  if (!state.selectedCategoryId || !state.categories.some((category) => category.id === state.selectedCategoryId)) {
    state.selectedCategoryId = state.categories[0]?.id || null;
  }
}

function renderSettings() {
  $('defaultLanguage').value = state.settings.default_language || 'it';
  $('secondaryLanguage').value = state.settings.secondary_language || '';
  $('currency').value = state.settings.currency || 'EUR';
  $('showPrices').checked = state.settings.show_prices !== false;
  $('showImages').checked = state.settings.show_images !== false;
}

function renderPresets() {
  $('categoryPresets').innerHTML = PRESET_CATEGORIES.map((name) =>
    `<button class="category-preset" type="button" data-preset="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  ).join('');
}

function renderCategories() {
  const list = $('categoryList');
  if (!state.categories.length) {
    list.innerHTML = '<div class="menu-empty">Nessuna categoria. Crea la prima categoria o usa un suggerimento rapido.</div>';
    return;
  }

  list.innerHTML = state.categories.map((category) => {
    const selected = category.id === state.selectedCategoryId;
    return `
      <article class="category-card${selected ? ' is-selected' : ''}" draggable="${state.canEdit}" data-category-id="${category.id}">
        <div class="category-card__top">
          <span class="drag-handle" aria-hidden="true">::</span>
          <input class="category-input" data-category-name="${category.id}" value="${escapeHtml(categoryName(category))}" aria-label="Nome categoria" ${state.canEdit ? '' : 'disabled'} />
          <button class="menu-button" type="button" data-select-category="${category.id}">Apri</button>
        </div>
        <div class="category-meta">
          <span>${category.items.length} piatti</span>
          <label class="menu-switch">
            <input type="checkbox" data-category-visible="${category.id}" ${category.is_visible ? 'checked' : ''} ${state.canEdit ? '' : 'disabled'} />
            Visibile
          </label>
        </div>
        <div class="category-actions">
          <button class="menu-button" type="button" data-add-item="${category.id}">+ Piatto</button>
          <button class="menu-button menu-button--danger" type="button" data-delete-category="${category.id}">Elimina</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderItems() {
  const category = selectedCategory();
  const list = $('itemsList');
  $('addItemBtn').disabled = !state.canEdit || !category;
  $('addItemTop').disabled = !state.canEdit || !category;
  $('itemsTitle').textContent = category ? categoryName(category) : 'Seleziona una categoria';
  $('selectedCategoryLabel').textContent = category ? 'Piatti della categoria' : 'Piatti';

  if (!category) {
    list.innerHTML = '<div class="items-empty">Crea o seleziona una categoria per iniziare a inserire i piatti.</div>';
    return;
  }
  if (!category.items.length) {
    list.innerHTML = '<div class="items-empty">Nessun piatto in questa categoria. Aggiungi il primo piatto.</div>';
    return;
  }

  list.innerHTML = category.items.map((item) => renderItemCard(item, category.id)).join('');
}

function renderItemCard(item, categoryId) {
  const trIt = item.translations?.it || {};
  const trEn = item.translations?.en || {};
  const price = item.price == null ? '' : Number(item.price).toFixed(2);
  const categoryOptions = state.categories.map((category) =>
    `<option value="${category.id}" ${category.id === categoryId ? 'selected' : ''}>${escapeHtml(categoryName(category))}</option>`
  ).join('');
  return `
    <article class="menu-item-card" draggable="${state.canEdit}" data-item-id="${item.id}" data-category-id="${categoryId}">
      <button class="item-image-drop" type="button" data-image-drop="${item.id}" aria-label="Carica foto piatto" ${state.canEdit ? '' : 'disabled'}>
        ${item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="" />` : ''}
        <span>${item.image_url ? 'Cambia foto' : 'Trascina foto o clicca'}</span>
      </button>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-image-input="${item.id}" hidden />
      <div class="menu-item-form">
        <div class="item-status-row">
          <span class="drag-handle" aria-hidden="true">::</span>
          <div class="item-actions">
            <button class="menu-button" type="button" data-duplicate-item="${item.id}">Duplica</button>
            <button class="menu-button menu-button--danger" type="button" data-delete-item="${item.id}">Elimina</button>
          </div>
        </div>
        <div class="item-form-grid">
          <label class="menu-field">
            <span>Nome italiano</span>
            <input class="menu-input" data-item-field="${item.id}:it:name" value="${escapeHtml(trIt.name || '')}" ${state.canEdit ? '' : 'disabled'} />
          </label>
          <label class="menu-field">
            <span>Nome inglese</span>
            <input class="menu-input" data-item-field="${item.id}:en:name" value="${escapeHtml(trEn.name || '')}" ${state.canEdit ? '' : 'disabled'} />
          </label>
          <label class="menu-field">
            <span>Prezzo</span>
            <input class="menu-input" data-item-price="${item.id}" type="number" step="0.01" min="0" value="${escapeHtml(price)}" ${state.canEdit ? '' : 'disabled'} />
          </label>
          <label class="menu-field">
            <span>Categoria</span>
            <select class="menu-select" data-item-category="${item.id}" ${state.canEdit ? '' : 'disabled'}>${categoryOptions}</select>
          </label>
        </div>
        <div class="item-form-grid">
          <label class="menu-field">
            <span>Descrizione italiana</span>
            <textarea class="menu-textarea" data-item-field="${item.id}:it:description" ${state.canEdit ? '' : 'disabled'}>${escapeHtml(trIt.description || '')}</textarea>
          </label>
          <label class="menu-field">
            <span>Descrizione inglese</span>
            <textarea class="menu-textarea" data-item-field="${item.id}:en:description" ${state.canEdit ? '' : 'disabled'}>${escapeHtml(trEn.description || '')}</textarea>
          </label>
        </div>
        <div class="item-status-row">
          <label class="menu-switch">
            <input type="checkbox" data-item-available="${item.id}" ${item.available ? 'checked' : ''} ${state.canEdit ? '' : 'disabled'} />
            Disponibile
          </label>
          <label class="menu-switch">
            <input type="checkbox" data-item-featured="${item.id}" ${item.featured ? 'checked' : ''} ${state.canEdit ? '' : 'disabled'} />
            In evidenza
          </label>
        </div>
      </div>
    </article>
  `;
}

function render() {
  renderSettings();
  renderPresets();
  renderCategories();
  renderItems();
}

async function reloadAndRender() {
  await loadSettings();
  await loadMenuData();
  render();
}

function nextSort(rows) {
  return rows.length ? Math.max(...rows.map((row) => Number(row.sort_order || 0))) + 10 : 10;
}

async function createCategory(name) {
  if (!assertCanEdit()) return;
  const clean = String(name || '').trim();
  if (!clean) {
    toast('Inserisci il nome della categoria.', true);
    return;
  }
  setSaving('Creazione categoria...');
  const { data, error } = await supabase
    .from('menu_categories')
    .insert({ venue_id: state.venue.id, sort_order: nextSort(state.categories), is_visible: true })
    .select('id, venue_id, sort_order, is_visible, created_at, updated_at')
    .maybeSingle();
  if (error) throw error;
  const tr = await insertTranslation('menu_category_translations', { category_id: data.id, language: 'it', name: clean });
  if (tr.error) throw tr.error;
  state.selectedCategoryId = data.id;
  $('newCategoryName').value = '';
  await loadMenuData();
  render();
  setSaving('Salvato');
  toast('Categoria creata.');
}

async function saveCategoryName(categoryId, value) {
  if (!assertCanEdit()) return;
  const name = String(value || '').trim();
  if (!name) {
    toast('Il nome categoria non puo essere vuoto.', true);
    return;
  }
  const category = state.categories.find((row) => row.id === categoryId);
  if (category) {
    category.translations.it = { ...(category.translations.it || {}), category_id: categoryId, language: 'it', name };
  }
  const { error } = await upsertTranslation(
    'menu_category_translations',
    { category_id: categoryId, language: 'it', name },
    'category_id,language'
  );
  if (error) throw error;
}

async function setCategoryVisible(categoryId, isVisible) {
  if (!assertCanEdit()) return;
  const category = state.categories.find((row) => row.id === categoryId);
  if (category) category.is_visible = isVisible;
  const { error } = await supabase.from('menu_categories').update({ is_visible: isVisible }).eq('id', categoryId);
  if (error) throw error;
}

async function deleteCategory(categoryId) {
  if (!assertCanEdit()) return;
  const { error } = await supabase.from('menu_categories').delete().eq('id', categoryId);
  if (error) throw error;
  if (state.selectedCategoryId === categoryId) state.selectedCategoryId = null;
  await loadMenuData();
  render();
  toast('Categoria eliminata.');
}

async function createItem(categoryId = state.selectedCategoryId) {
  if (!assertCanEdit()) return;
  const category = state.categories.find((row) => row.id === categoryId);
  if (!category) {
    toast('Seleziona prima una categoria.', true);
    return;
  }
  setSaving('Creazione piatto...');
  const { data, error } = await supabase
    .from('menu_items')
    .insert({
      category_id: category.id,
      sort_order: nextSort(category.items),
      available: true,
      featured: false,
    })
    .select('id, category_id, price, image_url, sort_order, available, featured, created_at, updated_at')
    .maybeSingle();
  if (error) throw error;
  const tr = await insertTranslation(
    'menu_item_translations',
    { item_id: data.id, language: 'it', name: 'Nuovo piatto', description: null }
  );
  if (tr.error) throw tr.error;
  state.selectedCategoryId = category.id;
  await loadMenuData();
  render();
  setSaving('Salvato');
  toast('Piatto creato.');
}

function findItem(itemId) {
  for (const category of state.categories) {
    const item = category.items.find((row) => row.id === itemId);
    if (item) return { item, category };
  }
  return { item: null, category: null };
}

async function saveItemTranslation(itemId, language) {
  if (!assertCanEdit()) return;
  const nameInput = document.querySelector(`[data-item-field="${itemId}:${language}:name"]`);
  const descInput = document.querySelector(`[data-item-field="${itemId}:${language}:description"]`);
  const name = String(nameInput?.value || '').trim();
  const description = String(descInput?.value || '').trim() || null;
  if (language === 'it' && !name) {
    toast('Il nome italiano e obbligatorio.', true);
    return;
  }
  if (language !== 'it' && !name && !description) {
    const deleted = await supabase
      .from('menu_item_translations')
      .delete()
      .eq('item_id', itemId)
      .eq('language', language);
    if (deleted.error) throw deleted.error;
    return;
  }
  const { item } = findItem(itemId);
  if (item) {
    item.translations[language] = { item_id: itemId, language, name, description };
  }
  const { error } = await upsertTranslation(
    'menu_item_translations',
    { item_id: itemId, language, name, description },
    'item_id,language'
  );
  if (error) throw error;
}

async function updateItem(itemId, patch) {
  if (!assertCanEdit()) return;
  const { item } = findItem(itemId);
  if (item) Object.assign(item, patch);
  const { error } = await supabase.from('menu_items').update(patch).eq('id', itemId);
  if (error) throw error;
}

async function saveItemPrice(itemId, value) {
  const raw = String(value || '').trim().replace(',', '.');
  const price = raw === '' ? null : Number(raw);
  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    toast('Prezzo non valido.', true);
    return;
  }
  await updateItem(itemId, { price });
}

async function moveItemToCategory(itemId, categoryId) {
  if (!assertCanEdit()) return;
  const target = state.categories.find((category) => category.id === categoryId);
  if (!target) return;
  await updateItem(itemId, { category_id: categoryId, sort_order: nextSort(target.items) });
  state.selectedCategoryId = categoryId;
  await loadMenuData();
  render();
  toast('Piatto spostato.');
}

async function duplicateItem(itemId) {
  if (!assertCanEdit()) return;
  const { item, category } = findItem(itemId);
  if (!item || !category) return;
  const { data, error } = await supabase
    .from('menu_items')
    .insert({
      category_id: category.id,
      price: item.price,
      image_url: item.image_url,
      sort_order: nextSort(category.items),
      available: item.available,
      featured: item.featured,
    })
    .select('id')
    .maybeSingle();
  if (error) throw error;
  const translations = Object.values(item.translations || {}).map((tr) => ({
    item_id: data.id,
    language: tr.language,
    name: `${tr.name || itemName(item)} copia`,
    description: tr.description || null,
  }));
  if (translations.length) {
    const inserted = await insertTranslations('menu_item_translations', translations);
    if (inserted.error) throw inserted.error;
  }
  await loadMenuData();
  render();
  toast('Piatto duplicato.');
}

async function deleteItem(itemId) {
  if (!assertCanEdit()) return;
  const { error } = await supabase.from('menu_items').delete().eq('id', itemId);
  if (error) throw error;
  await loadMenuData();
  render();
  toast('Piatto eliminato.');
}

async function persistCategoryOrder() {
  const updates = state.categories.map((category, index) =>
    supabase.from('menu_categories').update({ sort_order: (index + 1) * 10 }).eq('id', category.id)
  );
  const results = await Promise.all(updates);
  const failed = results.find((result) => result.error);
  if (failed) throw failed.error;
}

async function persistItemOrder(categoryIds) {
  const updates = [];
  categoryIds.forEach((categoryId) => {
    const category = state.categories.find((row) => row.id === categoryId);
    if (!category) return;
    category.items.forEach((item, index) => {
      updates.push(supabase
        .from('menu_items')
        .update({ category_id: category.id, sort_order: (index + 1) * 10 })
        .eq('id', item.id));
    });
  });
  const results = await Promise.all(updates);
  const failed = results.find((result) => result.error);
  if (failed) throw failed.error;
}

async function reorderCategory(dragId, targetId) {
  if (!assertCanEdit() || dragId === targetId) return;
  const fromIndex = state.categories.findIndex((category) => category.id === dragId);
  const toIndex = state.categories.findIndex((category) => category.id === targetId);
  if (fromIndex < 0 || toIndex < 0) return;
  const [moved] = state.categories.splice(fromIndex, 1);
  state.categories.splice(toIndex, 0, moved);
  renderCategories();
  await persistCategoryOrder();
  toast('Categorie riordinate.');
}

async function reorderItem(dragItemId, targetCategoryId, beforeItemId = null) {
  if (!assertCanEdit()) return;
  const from = findItem(dragItemId);
  const targetCategory = state.categories.find((category) => category.id === targetCategoryId);
  if (!from.item || !from.category || !targetCategory) return;
  from.category.items = from.category.items.filter((item) => item.id !== dragItemId);
  const nextItem = { ...from.item, category_id: targetCategory.id };
  const targetIndex = beforeItemId
    ? Math.max(0, targetCategory.items.findIndex((item) => item.id === beforeItemId))
    : targetCategory.items.length;
  targetCategory.items.splice(targetIndex < 0 ? targetCategory.items.length : targetIndex, 0, nextItem);
  state.selectedCategoryId = targetCategory.id;
  renderItems();
  await persistItemOrder([...new Set([from.category.id, targetCategory.id])]);
  toast('Piatti riordinati.');
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Compressione immagine non riuscita.'));
    }, type, quality);
  });
}

async function compressSquareImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Formato immagine non valido.');
  }
  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error('Immagine troppo grande. Usa un file inferiore a 5 MB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Immagine non leggibile.'));
    });
    img.src = url;
    await loaded;
    const size = Math.min(img.naturalWidth, img.naturalHeight);
    const sourceX = Math.max(0, Math.floor((img.naturalWidth - size) / 2));
    const sourceY = Math.max(0, Math.floor((img.naturalHeight - size) / 2));
    const outputSize = Math.min(1200, size);
    const canvas = document.createElement('canvas');
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Compressione immagine non disponibile nel browser.');
    ctx.drawImage(img, sourceX, sourceY, size, size, 0, 0, outputSize, outputSize);
    return await canvasToBlob(canvas, 'image/jpeg', 0.84);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadItemImage(itemId, file) {
  if (!assertCanEdit() || !file) return;
  const { item } = findItem(itemId);
  if (!item) return;
  const previewUrl = URL.createObjectURL(file);
  item.image_url = previewUrl;
  renderItems();
  setSaving('Caricamento immagine...');
  try {
    const blob = await compressSquareImage(file);
    const path = `${state.venue.id}/${itemId}-${Date.now()}.jpg`;
    const uploaded = await supabase.storage.from(IMAGE_BUCKET).upload(path, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: true,
    });
    if (uploaded.error) throw uploaded.error;
    const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    if (!data?.publicUrl) throw new Error('URL pubblico immagine non disponibile.');
    await updateItem(itemId, { image_url: `${data.publicUrl}?v=${Date.now()}` });
    await loadMenuData();
    render();
    setSaving('Salvato');
    toast('Foto aggiornata.');
  } catch (error) {
    console.error('[menu] upload immagine fallito:', error);
    await loadMenuData();
    render();
    setSaving('Errore immagine');
    toast(error.message || 'Upload immagine non riuscito.', true);
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

async function saveSettings() {
  if (!assertCanEdit()) return;
  const currency = ($('currency').value || 'EUR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    toast('Inserisci una valuta valida di 3 lettere, es. EUR.', true);
    $('currency').value = state.settings.currency || 'EUR';
    return;
  }
  const patch = {
    venue_id: state.venue.id,
    default_language: $('defaultLanguage').value || 'it',
    secondary_language: $('secondaryLanguage').value || null,
    show_prices: $('showPrices').checked,
    show_images: $('showImages').checked,
    currency,
  };
  state.settings = { ...state.settings, ...patch };
  const { error } = await supabase
    .from('menu_settings')
    .upsert(patch, { onConflict: 'venue_id' });
  if (error) throw error;
}

function wireStaticControls() {
  $('logoutBtn').addEventListener('click', confirmSignOut);
  $('addCategoryTop').addEventListener('click', () => $('newCategoryName').focus());
  $('addCategoryBtn').addEventListener('click', () => createCategory($('newCategoryName').value).catch(handleActionError));
  $('newCategoryName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') createCategory($('newCategoryName').value).catch(handleActionError);
  });
  $('addItemTop').addEventListener('click', () => createItem().catch(handleActionError));
  $('addItemBtn').addEventListener('click', () => createItem().catch(handleActionError));
  ['defaultLanguage', 'secondaryLanguage', 'currency', 'showPrices', 'showImages'].forEach((id) => {
    $(id).addEventListener('input', () => debounced('settings', saveSettings));
    $(id).addEventListener('change', () => debounced('settings', saveSettings, 80));
  });
}

function handleActionError(error) {
  console.error('[menu] azione fallita:', error);
  toast(error.message || 'Operazione non riuscita.', true);
  setSaving('Errore');
}

function wireDelegatedControls() {
  document.addEventListener('click', (event) => {
    const preset = event.target.closest('[data-preset]');
    if (preset) createCategory(preset.dataset.preset).catch(handleActionError);

    const selectCategory = event.target.closest('[data-select-category]');
    if (selectCategory) {
      state.selectedCategoryId = selectCategory.dataset.selectCategory;
      render();
    }

    const addItem = event.target.closest('[data-add-item]');
    if (addItem) createItem(addItem.dataset.addItem).catch(handleActionError);

    const deleteCategoryBtn = event.target.closest('[data-delete-category]');
    if (deleteCategoryBtn) deleteCategory(deleteCategoryBtn.dataset.deleteCategory).catch(handleActionError);

    const duplicateItemBtn = event.target.closest('[data-duplicate-item]');
    if (duplicateItemBtn) duplicateItem(duplicateItemBtn.dataset.duplicateItem).catch(handleActionError);

    const deleteItemBtn = event.target.closest('[data-delete-item]');
    if (deleteItemBtn) deleteItem(deleteItemBtn.dataset.deleteItem).catch(handleActionError);

    const imageDrop = event.target.closest('[data-image-drop]');
    if (imageDrop) {
      const input = document.querySelector(`[data-image-input="${imageDrop.dataset.imageDrop}"]`);
      if (input) input.click();
    }
  });

  document.addEventListener('input', (event) => {
    const categoryInput = event.target.closest('[data-category-name]');
    if (categoryInput) {
      const id = categoryInput.dataset.categoryName;
      debounced(`category:${id}`, () => saveCategoryName(id, categoryInput.value));
    }

    const itemField = event.target.closest('[data-item-field]');
    if (itemField) {
      const [itemId, language] = itemField.dataset.itemField.split(':');
      debounced(`item-tr:${itemId}:${language}`, () => saveItemTranslation(itemId, language));
    }

    const priceInput = event.target.closest('[data-item-price]');
    if (priceInput) {
      const id = priceInput.dataset.itemPrice;
      debounced(`item-price:${id}`, () => saveItemPrice(id, priceInput.value));
    }
  });

  document.addEventListener('change', (event) => {
    const visible = event.target.closest('[data-category-visible]');
    if (visible) setCategoryVisible(visible.dataset.categoryVisible, visible.checked).catch(handleActionError);

    const available = event.target.closest('[data-item-available]');
    if (available) updateItem(available.dataset.itemAvailable, { available: available.checked }).catch(handleActionError);

    const featured = event.target.closest('[data-item-featured]');
    if (featured) updateItem(featured.dataset.itemFeatured, { featured: featured.checked }).catch(handleActionError);

    const categorySelect = event.target.closest('[data-item-category]');
    if (categorySelect) moveItemToCategory(categorySelect.dataset.itemCategory, categorySelect.value).catch(handleActionError);

    const imageInput = event.target.closest('[data-image-input]');
    if (imageInput && imageInput.files?.[0]) {
      uploadItemImage(imageInput.dataset.imageInput, imageInput.files[0]).catch(handleActionError);
      imageInput.value = '';
    }
  });
}

function wireDragAndDrop() {
  document.addEventListener('dragstart', (event) => {
    const category = event.target.closest('[data-category-id]');
    const item = event.target.closest('[data-item-id]');
    if (!state.canEdit) return;
    if (item) {
      state.drag = { type: 'item', id: item.dataset.itemId };
      item.classList.add('is-dragging');
    } else if (category) {
      state.drag = { type: 'category', id: category.dataset.categoryId };
      category.classList.add('is-dragging');
    }
    if (state.drag) event.dataTransfer.effectAllowed = 'move';
  });

  document.addEventListener('dragend', () => {
    document.querySelectorAll('.is-dragging,.is-drop-target,.is-over').forEach((node) =>
      node.classList.remove('is-dragging', 'is-drop-target', 'is-over'));
    state.drag = null;
  });

  document.addEventListener('dragover', (event) => {
    const imageZone = event.target.closest('[data-image-drop]');
    const dragTypes = Array.from(event.dataTransfer?.types || []);
    if (imageZone && dragTypes.includes('Files')) {
      event.preventDefault();
      imageZone.classList.add('is-over');
      return;
    }
    if (!state.drag) return;
    const itemTarget = event.target.closest('[data-item-id]');
    const categoryTarget = event.target.closest('[data-category-id]');
    const itemsList = event.target.closest('#itemsList');
    if (itemTarget || categoryTarget || itemsList) {
      event.preventDefault();
      (itemTarget || categoryTarget || itemsList).classList.add('is-drop-target');
    }
  });

  document.addEventListener('dragleave', (event) => {
    event.target.closest?.('.is-drop-target')?.classList.remove('is-drop-target');
    event.target.closest?.('.is-over')?.classList.remove('is-over');
  });

  document.addEventListener('drop', (event) => {
    const imageZone = event.target.closest('[data-image-drop]');
    if (imageZone && event.dataTransfer.files?.[0]) {
      event.preventDefault();
      uploadItemImage(imageZone.dataset.imageDrop, event.dataTransfer.files[0]).catch(handleActionError);
      return;
    }

    if (!state.drag) return;
    event.preventDefault();
    const itemTarget = event.target.closest('[data-item-id]');
    const categoryTarget = event.target.closest('[data-category-id]');
    const itemsList = event.target.closest('#itemsList');

    if (state.drag.type === 'category' && categoryTarget) {
      reorderCategory(state.drag.id, categoryTarget.dataset.categoryId).catch(handleActionError);
    }
    if (state.drag.type === 'item') {
      if (itemTarget) {
        reorderItem(state.drag.id, itemTarget.dataset.categoryId, itemTarget.dataset.itemId).catch(handleActionError);
      } else if (categoryTarget) {
        reorderItem(state.drag.id, categoryTarget.dataset.categoryId).catch(handleActionError);
      } else if (itemsList && state.selectedCategoryId) {
        reorderItem(state.drag.id, state.selectedCategoryId).catch(handleActionError);
      }
    }
  });
}

async function init() {
  state.session = await requireSession();
  if (!state.session) return;

  try {
    const current = await loadCurrentVenue();
    if (!current) { location.replace('dashboard.html'); return; }
    state.venue = current.venue;
    state.role = current.role;
    state.canEdit = current.role === 'owner';
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' - ' + (state.session.user.email || '');

    await reloadAndRender();
    wireStaticControls();
    wireDelegatedControls();
    wireDragAndDrop();

    if (!state.canEdit) setSaving('Sola lettura');
    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (error) {
    console.error('[menu] caricamento editor fallito:', error);
    $('pageSpinner').hidden = true;
    toast(error.message?.includes('menu_')
      ? 'Applica prima la migration del Menu Digitale.'
      : 'Errore di caricamento menu.', true);
  }
}

init();
