import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = Object.assign({
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  DEFAULT_VENUE_SLUG: '',
}, window.APP_CONFIG || {});

const params = new URLSearchParams(location.search);
const venueSlug = params.get('locale') || params.get('venue') || CONFIG.DEFAULT_VENUE_SLUG;
const CACHE_KEY = venueSlug ? `digital-menu:${venueSlug}` : '';
const INSTALL_LAST_SHOWN_KEY = 'digital-menu-install-last-shown-v1';
const INSTALL_INSTALLED_KEY = 'digital-menu-install-installed-v1';
const INSTALL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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
  installPrompt: null,
  installModal: null,
};

const UI = {
  it: {
    kicker: 'Menu digitale',
    search: 'Cerca nel menu',
    home: 'Torna in Home',
    available: 'Disponibile',
    unavailable: 'Non disponibile',
    new: 'Novità',
    recommended: 'Consigliato',
    itemSingular: 'piatto',
    itemPlural: 'piatti',
    emptySearch: 'Nessun piatto corrisponde alla ricerca.',
    emptyMenu: 'Il menu non è ancora disponibile.',
    fatal: 'Menu non disponibile.',
    untitledCategory: 'Categoria senza nome',
    untitledItem: 'Piatto senza nome',
    installTitle: "Installa l'app",
    installText: "Installa l'app sul tuo telefono per prenotare più velocemente, consultare il menu anche dalla Home e ricevere notifiche.",
    installCta: 'Installa',
    later: 'Più tardi',
    iosTitle: "Aggiungi l'app alla Home",
    iosText: "Apri il menu Condividi di Safari e seleziona 'Aggiungi a Home'.",
  },
  en: {
    kicker: 'Digital menu',
    search: 'Search the menu',
    home: 'Back to Home',
    available: 'Available',
    unavailable: 'Unavailable',
    new: 'New',
    recommended: 'Recommended',
    itemSingular: 'item',
    itemPlural: 'items',
    emptySearch: 'No dishes match your search.',
    emptyMenu: 'The menu is not available yet.',
    fatal: 'Menu unavailable.',
    untitledCategory: 'Untitled category',
    untitledItem: 'Untitled item',
    installTitle: 'Install the app',
    installText: 'Install the app on your phone to book faster, check the menu from your Home screen and receive notifications.',
    installCta: 'Install',
    later: 'Later',
    iosTitle: 'Add the app to Home',
    iosText: "Open Safari's Share menu and choose 'Add to Home Screen'.",
  },
};

const CATEGORY_FALLBACKS = {
  antipasti: 'Starters',
  primi: 'First courses',
  'primi piatti': 'First courses',
  secondi: 'Main courses',
  'secondi piatti': 'Main courses',
  contorni: 'Sides',
  dessert: 'Desserts',
  dolci: 'Desserts',
  bibite: 'Drinks',
  bevande: 'Drinks',
  vini: 'Wines',
  pizze: 'Pizzas',
  pizza: 'Pizza',
  birre: 'Beers',
  caffe: 'Coffee',
  caffè: 'Coffee',
  digestivi: 'Digestifs',
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
const t = (key) => (UI[state.language] || UI.it)[key] || UI.it[key] || key;

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

function homeUrl() {
  return withLocale('index.html');
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

function selectedTr(entity) {
  return entity.translations?.[state.language] || {};
}

function fallbackTr(entity) {
  return entity.translations?.it || entity.translations?.en || {};
}

function categoryTitle(category) {
  const translated = selectedTr(category).name;
  if (translated) return translated;
  if (state.language === 'en') {
    const italian = category.translations?.it?.name || '';
    const fallback = CATEGORY_FALLBACKS[normalize(italian)];
    if (fallback) return fallback;
  }
  return fallbackTr(category).name || t('untitledCategory');
}

function itemTitle(item) {
  return selectedTr(item).name || fallbackTr(item).name || t('untitledItem');
}

function itemDescription(item) {
  return selectedTr(item).description || fallbackTr(item).description || '';
}

function isNew(item) {
  if (!item.created_at) return false;
  return Date.now() - new Date(item.created_at).getTime() < 1000 * 60 * 60 * 24 * 21;
}

function renderVenue() {
  document.title = state.venue ? `Menu - ${state.venue.name}` : 'Menu Digitale';
  $('venueName').textContent = state.venue?.name || 'Menu';
  $('venueSub').textContent = [state.venue?.address, state.venue?.phone].filter(Boolean).join(` ${String.fromCharCode(183)} `);
  $('bookingLink').href = homeUrl();
  $('fatalHomeLink').href = homeUrl();
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
  document.documentElement.lang = state.language;
  document.querySelector('.brand-kicker').textContent = t('kicker');
  $('menuSearch').placeholder = t('search');
  $('bookingLink').textContent = t('home');
  $('fatalHomeLink').textContent = t('home');
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
          <span class="badge ${item.available === false ? 'badge--off' : 'badge--ok'}">${item.available === false ? t('unavailable') : t('available')}</span>
          ${isNew(item) ? `<span class="badge badge--new">${t('new')}</span>` : ''}
          ${item.featured ? `<span class="badge badge--featured">${t('recommended')}</span>` : ''}
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
      ? t('emptySearch')
      : t('emptyMenu')}</div>`;
    $('menuContent').hidden = false;
    return;
  }

  $('menuContent').innerHTML = categories.map((category) => `
    <section class="menu-section" id="cat-${category.id}" data-category-section="${category.id}">
      <div class="menu-section__head">
        <h2 class="menu-section__title">${escapeHtml(categoryTitle(category))}</h2>
        <span class="menu-section__count">${category.items.length} ${category.items.length === 1 ? t('itemSingular') : t('itemPlural')}</span>
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
  renderLanguage();
  $('fatalText').textContent = error.message || t('fatal');
  $('fatalState').hidden = false;
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || readStorage(INSTALL_INSTALLED_KEY) === '1';
}

function installRecentlyShown() {
  const last = Number(readStorage(INSTALL_LAST_SHOWN_KEY) || 0);
  return last && Date.now() - last < INSTALL_INTERVAL_MS;
}

function canShowInstallPrompt() {
  return !isInstalled() && !installRecentlyShown();
}

function markInstallShown() {
  writeStorage(INSTALL_LAST_SHOWN_KEY, String(Date.now()));
}

function markInstalled() {
  writeStorage(INSTALL_INSTALLED_KEY, '1');
}

function isIosSafari() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /^((?!CriOS|FxiOS|EdgiOS|OPiOS).)*Safari/i.test(ua);
  return ios && safari;
}

function installIcon(isIos = false) {
  return isIos
    ? '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/><path d="M9 6h6"/></svg>';
}

function showInstallModal(mode = 'native') {
  if (!canShowInstallPrompt() || state.installModal) return;
  markInstallShown();
  const isIos = mode === 'ios';
  const modal = document.createElement('div');
  modal.className = 'install-modal';
  modal.id = 'installModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'installTitle');
  modal.innerHTML = `
    <div class="install-card">
      <div class="install-icon">${installIcon(isIos)}</div>
      <h2 class="install-title" id="installTitle">${escapeHtml(isIos ? t('iosTitle') : t('installTitle'))}</h2>
      <p class="install-text">${escapeHtml(isIos ? t('iosText') : t('installText'))}</p>
      <div class="install-actions">
        ${isIos ? '' : `<button class="install-btn install-btn--primary" type="button" data-install-action="install">${escapeHtml(t('installCta'))}</button>`}
        <button class="install-btn" type="button" data-install-action="later">${escapeHtml(t('later'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  state.installModal = modal;
  requestAnimationFrame(() => modal.classList.add('is-visible'));

  modal.addEventListener('click', (event) => {
    const action = event.target.closest('[data-install-action]')?.dataset.installAction;
    if (action === 'install') installPwa();
    if (action === 'later') closeInstallModal();
  });
}

function closeInstallModal() {
  const modal = state.installModal;
  if (!modal) return;
  modal.classList.remove('is-visible');
  state.installModal = null;
  setTimeout(() => modal.remove(), 240);
}

async function installPwa() {
  const promptEvent = state.installPrompt;
  state.installPrompt = null;
  if (!promptEvent) {
    closeInstallModal();
    return;
  }
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') markInstalled();
  } catch (error) {
    console.error('[digital-menu] prompt installazione non completato:', error);
  } finally {
    closeInstallModal();
  }
}

function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    window.setTimeout(() => showInstallModal('native'), 900);
  });
  window.addEventListener('appinstalled', () => {
    markInstalled();
    closeInstallModal();
    state.installPrompt = null;
  });
  window.addEventListener('load', () => {
    if (isIosSafari()) {
      window.setTimeout(() => showInstallModal('ios'), 1200);
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const registration = navigator.serviceWorker.register('/sw.js');
    const timeout = new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error('SERVICE_WORKER_TIMEOUT')), 5000);
    });
    Promise.race([registration, timeout])
      .then((reg) => {
        if (reg?.update) reg.update().catch((error) => {
          console.warn('[digital-menu] aggiornamento service worker non riuscito:', error);
        });
      })
      .catch((error) => {
        console.warn('[digital-menu] service worker non registrato:', error);
      });
  });
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
  initInstallPrompt();
  registerServiceWorker();
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
