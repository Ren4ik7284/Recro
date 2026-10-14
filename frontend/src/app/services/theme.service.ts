import { Injectable, signal, effect } from '@angular/core';

export interface ThemePreset {
  id: string;
  nameRu: string;
  nameEn: string;
  color1: string;
  color2: string;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'deep-blue',
    nameRu: 'Королевский синий',
    nameEn: 'Royal Blue',
    color1: '#2563eb',
    color2: '#0f172a',
  },
  {
    id: 'midnight-blurple',
    nameRu: 'Полночь',
    nameEn: 'Midnight',
    color1: '#5865F2',
    color2: '#111214',
  },
  {
    id: 'cyberpunk-neon',
    nameRu: 'Киберпанк',
    nameEn: 'Cyberpunk',
    color1: '#06b6d4',
    color2: '#ec4899',
  },
  {
    id: 'sunset-horizon',
    nameRu: 'Закат',
    nameEn: 'Sunset',
    color1: '#f97316',
    color2: '#7c3aed',
  },
  {
    id: 'sakura-blossom',
    nameRu: 'Сакура',
    nameEn: 'Sakura',
    color1: '#f43f5e',
    color2: '#6366f1',
  },
  {
    id: 'emerald-abyss',
    nameRu: 'Изумруд',
    nameEn: 'Emerald',
    color1: '#10b981',
    color2: '#064e3b',
  },
  {
    id: 'synthwave-retro',
    nameRu: 'Синтвейв',
    nameEn: 'Synthwave',
    color1: '#d946ef',
    color2: '#2563eb',
  },
  {
    id: 'dark-amethyst',
    nameRu: 'Аметист',
    nameEn: 'Amethyst',
    color1: '#a855f7',
    color2: '#1e1b4b',
  },
  {
    id: 'solar-flare',
    nameRu: 'Солар',
    nameEn: 'Solar',
    color1: '#eab308',
    color2: '#b91c1c',
  },
  {
    id: 'monochrome-stealth',
    nameRu: 'Монохром',
    nameEn: 'Monochrome',
    color1: '#71717a',
    color2: '#09090b',
  },
];

export const QUICK_SWATCH_PALETTE: { nameRu: string; nameEn: string; hex: string }[] = [
  { nameRu: 'Discord Blurple', nameEn: 'Discord Blurple', hex: '#5865F2' },
  { nameRu: 'Королевский Синий', nameEn: 'Royal Blue', hex: '#2563eb' },
  { nameRu: 'Неоновый Циан', nameEn: 'Cyan Neon', hex: '#06b6d4' },
  { nameRu: 'Изумрудный', nameEn: 'Emerald Green', hex: '#10b981' },
  { nameRu: 'Сакура Розовый', nameEn: 'Sakura Pink', hex: '#f43f5e' },
  { nameRu: 'Маджента / Фуксия', nameEn: 'Hot Magenta', hex: '#ec4899' },
  { nameRu: 'Фиолетовый Неон', nameEn: 'Electric Purple', hex: '#8b5cf6' },
  { nameRu: 'Тёмный Аметист', nameEn: 'Deep Amethyst', hex: '#7c3aed' },
  { nameRu: 'Закатный Оранжевый', nameEn: 'Sunset Orange', hex: '#f97316' },
  { nameRu: 'Золотой Янтарь', nameEn: 'Amber Gold', hex: '#eab308' },
  { nameRu: 'Рубиновый Алый', nameEn: 'Ruby Crimson', hex: '#ef4444' },
  { nameRu: 'Серый Стелс', nameEn: 'Stealth Zinc', hex: '#71717a' },
  { nameRu: 'Изумрудная Бездна', nameEn: 'Abyss Green', hex: '#064e3b' },
  { nameRu: 'Индиго Ночь', nameEn: 'Midnight Indigo', hex: '#1e1b4b' },
  { nameRu: 'Глубокий Синий', nameEn: 'Deep Navy', hex: '#0f172a' },
  { nameRu: 'Тёмный Монохром', nameEn: 'Midnight Dark', hex: '#111214' },
];

export interface ThemeConfig {
  color1: string;
  color2: string;
  presetId?: string;
  isCustom?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private readonly STORAGE_KEY = 'recro_theme_config';
  readonly presets = THEME_PRESETS;
  readonly quickSwatches = QUICK_SWATCH_PALETTE;

  readonly currentTheme = signal<ThemeConfig>(this.loadInitialTheme());
  readonly isThemeModalOpen = signal<boolean>(false);

  constructor() {
    // Автоматически применяем стили при любом изменении сигнала темы
    effect(() => {
      const cfg = this.currentTheme();
      this.applyThemeToDOM(cfg);
    });
  }

  private loadInitialTheme(): ThemeConfig {
    if (typeof localStorage === 'undefined') {
      return { color1: THEME_PRESETS[0].color1, color2: THEME_PRESETS[0].color2, presetId: THEME_PRESETS[0].id };
    }
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.color1 && parsed.color2) {
          return parsed;
        }
      }
    } catch {}
    return { color1: THEME_PRESETS[0].color1, color2: THEME_PRESETS[0].color2, presetId: THEME_PRESETS[0].id };
  }

  setPreset(presetId: string) {
    const found = THEME_PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    const cfg: ThemeConfig = {
      color1: found.color1,
      color2: found.color2,
      presetId: found.id,
      isCustom: false,
    };
    this.currentTheme.set(cfg);
    this.persistTheme(cfg);
  }

  setCustomColors(color1: string, color2: string) {
    // Проверяем совпадение с пресетом
    const matched = THEME_PRESETS.find(
      (p) => p.color1.toLowerCase() === color1.toLowerCase() && p.color2.toLowerCase() === color2.toLowerCase()
    );
    const cfg: ThemeConfig = {
      color1,
      color2,
      presetId: matched?.id,
      isCustom: !matched,
    };
    this.currentTheme.set(cfg);
    this.persistTheme(cfg);
  }

  updateColor1(c1: string) {
    this.setCustomColors(c1, this.currentTheme().color2);
  }

  updateColor2(c2: string) {
    this.setCustomColors(this.currentTheme().color1, c2);
  }

  resetToDefault() {
    this.setPreset('deep-blue');
  }

  openModal() {
    this.isThemeModalOpen.set(true);
  }

  closeModal() {
    this.isThemeModalOpen.set(false);
  }

  private persistTheme(cfg: ThemeConfig) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(cfg));
      } catch {}
    }
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    let clean = hex.replace('#', '').trim();
    if (clean.length === 3) {
      clean = clean.split('').map((c) => c + c).join('');
    }
    const num = parseInt(clean, 16);
    if (isNaN(num)) {
      return { r: 37, g: 99, b: 235 };
    }
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255,
    };
  }

  private adjustBrightness(hex: string, percent: number): string {
    const { r, g, b } = this.hexToRgb(hex);
    const adjust = (val: number) => Math.min(255, Math.max(0, Math.round(val + (percent / 100) * 255)));
    const nr = adjust(r);
    const ng = adjust(g);
    const nb = adjust(b);
    return `#${((1 << 24) + (nr << 16) + (ng << 8) + nb).toString(16).slice(1)}`;
  }

  private applyThemeToDOM(cfg: ThemeConfig) {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const rgb1 = this.hexToRgb(cfg.color1);
    const rgb2 = this.hexToRgb(cfg.color2);

    const c1Hover = this.adjustBrightness(cfg.color1, 15);
    const c1Subtle = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, 0.16)`;
    const c1Border = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, 0.38)`;
    const c1Glow = `rgba(${rgb1.r}, ${rgb1.g}, ${rgb1.b}, 0.35)`;

    const c2Subtle = `rgba(${rgb2.r}, ${rgb2.g}, ${rgb2.b}, 0.16)`;
    const c2Glow = `rgba(${rgb2.r}, ${rgb2.g}, ${rgb2.b}, 0.30)`;

    // Основные CSS переменные цветовой темы
    root.style.setProperty('--theme-c1', cfg.color1);
    root.style.setProperty('--theme-c2', cfg.color2);
    root.style.setProperty('--theme-c1-hover', c1Hover);
    root.style.setProperty('--theme-c1-subtle', c1Subtle);
    root.style.setProperty('--theme-c1-border', c1Border);
    root.style.setProperty('--theme-c1-glow', c1Glow);
    root.style.setProperty('--theme-c2-subtle', c2Subtle);
    root.style.setProperty('--theme-c2-glow', c2Glow);

    // Градиенты в стиле Discord Nitro
    root.style.setProperty('--theme-gradient', `linear-gradient(135deg, ${cfg.color1}, ${cfg.color2})`);
    root.style.setProperty(
      '--theme-ambient-mesh',
      `radial-gradient(ellipse 90% 80% at 10% 15%, ${c1Subtle} 0%, transparent 65%), radial-gradient(ellipse 85% 75% at 90% 85%, ${c2Subtle} 0%, transparent 65%)`
    );

    // Акцентные переменные плеера
    root.style.setProperty('--accent-blue', cfg.color1);
    root.style.setProperty('--accent-blue-hover', c1Hover);
    root.style.setProperty('--accent-blue-subtle', c1Subtle);
    root.style.setProperty('--accent-blue-border', c1Border);

    root.style.setProperty('--accent-green', cfg.color1);
    root.style.setProperty('--accent-green-hover', c1Hover);
    root.style.setProperty('--accent-green-subtle', c1Subtle);
    root.style.setProperty('--accent-green-border', c1Border);

    // Подмешивание оттенков в фон (Discord Nitro atmospheric dark blend)
    root.style.setProperty('--bg-canvas', `color-mix(in srgb, ${cfg.color2} 12%, #09090b)`);
    root.style.setProperty('--bg-sidebar', `color-mix(in srgb, ${cfg.color1} 14%, #070709)`);
    root.style.setProperty('--bg-panel', `color-mix(in srgb, ${cfg.color2} 14%, #0b0b0e)`);
    root.style.setProperty('--bg-card', `color-mix(in srgb, ${cfg.color1} 18%, #141418)`);
    root.style.setProperty('--bg-card-hover', `color-mix(in srgb, ${cfg.color1} 26%, #1c1c22)`);
    root.style.setProperty('--border-subtle', `color-mix(in srgb, ${cfg.color1} 22%, #222228)`);
  }
}
