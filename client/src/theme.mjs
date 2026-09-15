// 主题与字号偏好（需求 12）：
//  - 主题：浅色 / 深色 / 跟随系统。存的是「偏好」，写到 <html data-theme> 的是「解析结果」，
//    这样 CSS 只需要处理 light / dark 两套。
//  - 字号：写在 <html data-scale>，由 CSS 用 zoom 统一缩放，不用逐个改 font-size。
const THEME_KEY = 'ai-teacher-theme';
const SCALE_KEY = 'ai-teacher-font-scale';

export const THEMES = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'system', label: '跟随系统' },
];

export const SCALES = [
  { id: 'small', label: '小' },
  { id: 'normal', label: '标准' },
  { id: 'large', label: '大' },
];

const THEME_IDS = THEMES.map((item) => item.id);
const SCALE_IDS = SCALES.map((item) => item.id);

function read(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下写不了，退化为「本次会话有效」，不影响使用。
  }
}

export function readTheme() {
  return read(THEME_KEY, THEME_IDS, 'light');
}

export function readScale() {
  return read(SCALE_KEY, SCALE_IDS, 'normal');
}

export function resolveTheme(theme) {
  if (theme === 'system') {
    const media = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)');
    return media?.matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function applyScale(scale) {
  document.documentElement.dataset.scale = SCALE_IDS.includes(scale) ? scale : 'normal';
}

export function initTheme() {
  const theme = readTheme();
  const scale = readScale();
  applyTheme(theme);
  applyScale(scale);
  return { theme, scale };
}

export function saveTheme(theme) {
  write(THEME_KEY, THEME_IDS.includes(theme) ? theme : 'light');
  return applyTheme(theme);
}

export function saveScale(scale) {
  write(SCALE_KEY, SCALE_IDS.includes(scale) ? scale : 'normal');
  applyScale(scale);
}

// 选「跟随系统」时要跟着系统切换走。
export function watchSystemTheme(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (readTheme() === 'system') onChange(applyTheme('system'));
  };
  media.addEventListener?.('change', handler);
  return () => media.removeEventListener?.('change', handler);
}
