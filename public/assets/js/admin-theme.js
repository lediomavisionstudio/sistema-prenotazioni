(function () {
  const STORAGE_KEY = 'admin_theme';
  const VALID_THEMES = new Set(['light', 'dark', 'system']);
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readPreference() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return VALID_THEMES.has(value) ? value : 'system';
    } catch (_) {
      return 'system';
    }
  }

  function resolvedTheme(preference = readPreference()) {
    if (preference === 'system') return media && media.matches ? 'dark' : 'light';
    return preference;
  }

  function applyTheme(preference = readPreference()) {
    const resolved = resolvedTheme(preference);
    document.documentElement.dataset.adminThemePreference = preference;
    document.documentElement.dataset.adminTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', resolved === 'dark' ? '#0f131a' : '#c8402a');
    window.dispatchEvent(new CustomEvent('admin-theme-change', {
      detail: { preference, resolved },
    }));
  }

  function setPreference(preference) {
    const next = VALID_THEMES.has(preference) ? preference : 'system';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (_) {}
    applyTheme(next);
  }

  window.AdminTheme = {
    key: STORAGE_KEY,
    getPreference: readPreference,
    setPreference,
    apply: applyTheme,
    resolvedTheme,
  };

  applyTheme();

  if (media) {
    const onSystemChange = () => {
      if (readPreference() === 'system') applyTheme('system');
    };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }
})();
