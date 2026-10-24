import { useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'zhishu.theme';
const ACCEPTED: readonly ThemeMode[] = ['system', 'light', 'dark'];

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return ACCEPTED.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = mode === 'dark' || (mode === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', isDark);
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

export function initializeTheme(): void {
  applyTheme(readStoredTheme());
}

/**
 * 同步应用 + localStorage 中的主题偏好；
 * `system` 跟随系统的暗色变化。
 */
export function useTheme(): {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 即使存储失败，当前页面主题仍然生效
    }
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);

  return {
    theme,
    setTheme: (mode) => setThemeState(mode),
  };
}

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];
