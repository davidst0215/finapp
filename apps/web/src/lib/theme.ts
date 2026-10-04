export type ThemeMode = 'auto' | 'dark' | 'light';

// La misma clave la lee el script inline de index.html para aplicar el tema antes del primer pintado.
const KEY = 'wabid-theme';
const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)');

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(mode: ThemeMode) {
  const light = mode === 'light' || (mode === 'auto' && prefersLight().matches);
  document.documentElement.classList.toggle('light', light);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#fafafa' : '#141417');
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // sin almacenamiento: el tema vale solo para esta sesión
  }
  applyTheme(mode);
}

export function watchSystemTheme() {
  const media = prefersLight();
  const onChange = () => {
    if (readTheme() === 'auto') applyTheme('auto');
  };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
