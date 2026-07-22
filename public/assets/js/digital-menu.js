import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = Object.assign({
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  DEFAULT_VENUE_SLUG: '',
}, window.APP_CONFIG || {});

const params = new URLSearchParams(location.search);
const venueSlug = params.get('locale') || params.get('venue') || CONFIG.DEFAULT_VENUE_SLUG;
const CACHE_KEY = venueSlug ? `digital-menu:${venueSlug}` : '';

function readStorage(key) {
  try {
    return window.localStorage?.getItem(key) || '';
  } catch (error) {
    console.error('[digital-menu] localStorage non disponibile:', error);
    return '';
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch (error) {
    console.error('[digital-menu] salvataggio preferenza non riuscito:', error);
  }
}

const state = {
  venue: null,
  settings: null,
  categories: [],
  language: readStorage('digital-menu-language') || 'it',
  query: '',
  observer: null,
};

const $ = (id) => document.getElementById(id);
const money = (value, currency) => {
  if (value == null || value === '') return '';
  try {
    return new Intl.NumberFormat(state.language === 'en' ? 'en-US' : 'it-IT', {
      style: 'currency',
      currency: currency || 'EUR',
    }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency || 'EUR'}`;
  }
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));
const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

let supabase = null;

function readCache() {
  if (!CACHE_KEY) return null;
  try {
    const raw = window.sessionStorage?.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('[digital-menu] cache non leggibile:', error);
    return null;
  }
}

function writeCache() {
  if (!CACHE_KEY || !state.venue) return;
  try {
    window.sessionStorage?.setItem(CACHE_KEY, JSON.stringify({
      venue: state.venue,
      settings: state.settings,
      categories: state.categories,
      savedAt: Date.now(),
    }));
  } catch (error) {
    console.error('[digital-menu] cache non salvata:', error);
  }
}

function withLocale(path) {
  if (!venueSlug) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}locale=${encodeURIComponent(venueSlug)}`;
}

function setBrandColor(venue) {
  if (!venue?.brand_primary) return;
  const root = document.documentElement.style;
  root.setProperty('--tomato', venue.brand_primary);
  root.setProperty('--tomato-dark', venue.brand_primary_dark || venue.brand_primary);
  root.setProperty('--tomato-soft', hexToRgba(venue.brand_primary, 0.14) || '#f7ddd5');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', venue.brand_primary);
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || '').trim().replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((char) => char + char).join('')
    : clean;
  if (!/^[0-9a-f]{6}$/i.test(full)) return '';
  const value = Number.parseInt(full, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function tr(entity, fallbackLanguage = 'it') {
  const translations = entity.translations || {};
  return translations[state.language] || translations[fallbackLanguage] || translations.it || translations.en || {};
}

function categoryTitle(category) {
  return tr(category).name || (state.language === 'en' ? 'Untitled category' : 'Categoria senza nome');
}

function itemTitle(item) {
  return tr(item).name || (state.language === 'en' ? 'Untitled item' : 'Piatto senza nome');
}

function itemDescription(item) {
  return tr(item).description || '';
}

function isNew(item) {
  if (!item.created_at) return false;
  return Date.now() - new Date(item.created_at).getTime() < 1000 * 60 * 60 * 24 * 21;
}

function renderVenue() {
  document.title = state.venue ? `Menu - ${state.venue.name}` : 'Menu Digitale';
  $('venueName').textContent = state.venue?.name || 'Menu';
  $('venueSub').textContent = [state.venue?.address, state.venue?.phone].filter(Boolean).join(` ${String.fromCharCode(183)} `);
  $('bookingLink').href = withLocale('index.html');
  if (state.venue?.logo_url) {
    $('venueLogo').src = state.venue.logo_url;
    $('venueLogo').alt = state.venue.name || '';
    $('venueLogo').hidden = false;
  }
  const cover = state.settings?.cover_image;
  if (cover) $('menuCover').style.setProperty('--cover-image', `url("${cover}")`);
  setBrandColor(state.venue);
}

function filteredCategories() {
  const query = normalize(state.query);
  if (!query) return state.categories;
  return state.categories
    .map((category) => ({
      ...category,
      items: category.items.filter((item) => {
        const haystack = normalize(`${categoryTitle(category)} ${itemTitle(item)} ${itemDescription(item)}`);
        return haystack.includes(query);
      }),
    }))
    .filter((category) => category.items.length);
}

function renderLanguage() {
  document.querySelectorAll('[data-lang]').forEach((button) => {
    const active = button.dataset.lang === state.language;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('menuSearch').placeholder = state.language === 'en' ? 'Search the menu' : 'Cerca nel menu';
  $('bookingLink').textContent = state.language === 'en' ? 'Book a table' : 'Prenota un tavolo';
}

function renderCategoryStrip(categories) {
  const strip = $('categoryStrip');
  $('categoryWrap').hidden = !categories.length;
  strip.innerHTML = categories.map((category, index) =>
    `<button class="category-chip${index === 0 ? ' is-active' : ''}" type="button" data-target="${category.id}" aria-current="${index === 0 ? 'true' : 'false'}">${escapeHtml(categoryTitle(category))}</button>`
  ).join('');
}

function renderItem(item) {
  const price = state.settings?.show_prices === false ? '' : money(item.price, state.settings?.currency);
  const imageAllowed = state.settings?.show_images !== false;
  const image = imageAllowed && item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(itemTitle(item))}" loading="lazy" decoding="async" />`
    : `<div class="dish-placeholder" aria-hidden="true">${escapeHtml(itemTitle(item).charAt(0).toUpperCase() || 'M')}</div>`;
  return `
    <article class="dish-card">
      <div class="dish-media">${image}</div>
      <div class="dish-body">
        <div class="dish-title-row">
          <h3 class="dish-title">${escapeHtml(itemTitle(item))}</h3>
          ${price ? `<span class="dish-price">${escapeHtml(price)}</span>` : ''}
        </div>
        ${itemDescription(item) ? `<p class="dish-description">${escapeHtml(itemDescription(item))}</p>` : ''}
        <div class="dish-badges">
          <span class="badge badge--ok">${state.language === 'en' ? 'Available' : 'Disponibile'}</span>
          ${isNew(item) ? `<span class="badge badge--new">${state.language === 'en' ? 'New' : 'Novita'}</span>` : ''}
          ${item.featured ? `<span class="badge badge--featured">${state.language === 'en' ? 'Recommended' : 'Consigliato'}</span>` : ''}
        </div>
      </div>
    </article>
  `;
}

function renderMenu() {
  renderLanguage();
  const categories = filteredCategories();
  renderCategoryStrip(categories);

  if (!categories.length) {
    if (state.observer) state.observer.disconnect();
    $('menuContent').innerHTML = `<div class="empty-card">${state.query
      ? (state.language === 'en' ? 'No dishes match your search.' : 'Nessun piatto corrisponde alla ricerca.')
      : (state.language === 'en' ? 'The menu is not available yet.' : 'Il menu non e ancora disponibile.')}</div>`;
    $('menuContent').hidden = false;
    return;
  }

  $('menuContent').innerHTML = categories.map((category) => `
    <section class="menu-section" id="cat-${category.id}" data-category-section="${category.id}">
      <div class="menu-section__head">
        <h2 class="menu-section__title">${escapeHtml(categoryTitle(category))}</h2>
        <span class="menu-section__count">${category.items.length} ${category.items.length === 1 ? (state.language === 'en' ? 'item' : 'piatto') : (state.language === 'en' ? 'items' : 'piatti')}</span>
      </div>
      <div class="items-grid">${category.items.map(renderItem).join('')}</div>
    </section>
  `).join('');
  $('menuContent').hidden = false;
  observeSections();
}

function observeSections() {
  if (state.observer) state.observer.disconnect();
  const sections = [...document.querySelectorAll('[data-category-section]')];
  if (!sections.length || !('IntersectionObserver' in window)) return;
  state.observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    document.querySelectorAll('.category-chip').forEach((chip) => {
      const active = chip.dataset.target === visible.target.dataset.categorySection;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-current', active ? 'true' : 'false');
    });
  }, { rootMargin: '-18% 0px -68% 0px', threshold: [0.1, 0.35, 0.6] });
  sections.forEach((section) => state.observer.observe(section));
}

async function loadMenu() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !venueSlug) {
    throw new Error('Configurazione menu non disponibile.');
  }
  if (!supabase) {
    supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
  }
  const venueResult = await supabase
    .from('venues')
    .select('id, name, slug, phone, address, logo_url, brand_primary, brand_primary_dark, active')
    .eq('slug', venueSlug)
    .maybeSingle();
  if (venueResult.error) throw venueResult.error;
  if (!venueResult.data || !venueResult.data.active) throw new Error('Locale non disponibile.');
  state.venue = venueResult.data;

  const settingsResult = await supabase
    .from('menu_settings')
    .select('*')
    .eq('venue_id', state.venue.id)
    .maybeSingle();
  if (settingsResult.error) throw settingsResult.error;
  state.settings = settingsResult.data || {
    default_language: 'it',
    secondary_language: 'en',
    show_prices: true,
    show_images: true,
    currency: 'EUR',
  };

  const categoriesResult = await supabase
    .from('menu_categories')
    .select('id, sort_order, is_visible, created_at')
    .eq('venue_id', state.venue.id)
    .eq('is_visible', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (categoriesResult.error) throw categoriesResult.error;
  const categoryIds = (categoriesResult.data || []).map((category) => category.id);

  let categoryTranslations = [];
  let items = [];
  let itemTranslations = [];
  if (categoryIds.length) {
    const [catTrResult, itemResult] = await Promise.all([
      supabase.from('menu_category_translations').select('id, category_id, language, name').in('category_id', categoryIds),
      supabase
        .from('menu_items')
        .select('id, category_id, price, image_url, sort_order, available, featured, created_at')
        .in('category_id', categoryIds)
        .eq('available', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);
    if (catTrResult.error) throw catTrResult.error;
    if (itemResult.error) throw itemResult.error;
    categoryTranslations = catTrResult.data || [];
    items = itemResult.data || [];
  }

  const itemIds = items.map((item) => item.id);
  if (itemIds.length) {
    const trResult = await supabase.from('menu_item_translations').select('id, item_id, language, name, description').in('item_id', itemIds);
    if (trResult.error) throw trResult.error;
    itemTranslations = trResult.data || [];
  }

  const categoryTrMap = groupTranslations(categoryTranslations, 'category_id');
  const itemTrMap = groupTranslations(itemTranslations, 'item_id');
  const itemsByCategory = new Map();
  items.forEach((item) => {
    if (!itemsByCategory.has(item.category_id)) itemsByCategory.set(item.category_id, []);
    itemsByCategory.get(item.category_id).push({ ...item, translations: itemTrMap.get(item.id) || {} });
  });

  state.categories = (categoriesResult.data || []).map((category) => ({
    ...category,
    translations: categoryTrMap.get(category.id) || {},
    items: itemsByCategory.get(category.id) || [],
  })).filter((category) => category.items.length);
  writeCache();
}

function groupTranslations(rows, key) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const language = row.language || row.locale;
    if (!language) return;
    if (!map.has(row[key])) map.set(row[key], {});
    map.get(row[key])[language] = { ...row, language };
  });
  return map;
}

function showFatal(error) {
  console.error('[digital-menu] caricamento fallito:', error);
  if (state.observer) state.observer.disconnect();
  $('skeleton').hidden = true;
  $('categoryWrap').hidden = true;
  $('menuContent').hidden = true;
  $('fatalText').textContent = error.message || 'Menu non disponibile.';
  $('fatalState').hidden = false;
}

function wire() {
  document.querySelectorAll('[data-lang]').forEach((button) => {
    button.addEventListener('click', () => {
      state.language = button.dataset.lang;
      writeStorage('digital-menu-language', state.language);
      renderMenu();
    });
  });
  $('menuSearch').addEventListener('input', (event) => {
    state.query = event.target.value;
    renderMenu();
  });
  $('categoryStrip').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-target]');
    if (!chip) return;
    document.querySelectorAll('.category-chip').forEach((node) => {
      const active = node === chip;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-current', active ? 'true' : 'false');
    });
    document.getElementById(`cat-${chip.dataset.target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function init() {
  try {
    wire();
    await loadMenu();
    renderVenue();
    $('skeleton').hidden = true;
    renderMenu();
  } catch (error) {
    const cached = readCache();
    if (cached?.venue && Array.isArray(cached.categories)) {
      console.error('[digital-menu] uso cache menu dopo errore:', error);
      state.venue = cached.venue;
      state.settings = cached.settings || state.settings;
      state.categories = cached.categories;
      renderVenue();
      $('skeleton').hidden = true;
      renderMenu();
      return;
    }
    showFatal(error);
  }
}

init();
