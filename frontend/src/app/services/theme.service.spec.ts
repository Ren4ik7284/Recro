import { TestBed } from '@angular/core/testing';
import { ThemeService, THEME_PRESETS, QUICK_SWATCH_PALETTE } from './theme.service';
import { I18nService } from './i18n.service';

describe('ThemeService & Discord Nitro Theme Engine', () => {
  let themeService: ThemeService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    themeService = TestBed.inject(ThemeService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should initialize with default classic dark monochrome theme', () => {
    const current = themeService.currentTheme();
    expect(current.color1).toBe('#ffffff');
    expect(current.color2).toBe('#27272a');
    expect(current.presetId).toBe('classic-dark');
  });

  it('should switch to a Discord Nitro preset correctly', () => {
    themeService.setPreset('midnight-blurple');
    const current = themeService.currentTheme();
    expect(current.color1).toBe('#5865F2');
    expect(current.color2).toBe('#111214');
    expect(current.presetId).toBe('midnight-blurple');
    expect(current.isCustom).toBe(false);

    // Verify localStorage persistence
    const saved = JSON.parse(localStorage.getItem('recro_theme_config') || '{}');
    expect(saved.presetId).toBe('midnight-blurple');
  });

  it('should support custom 2-color combination', () => {
    themeService.setCustomColors('#ff0055', '#1a0033');
    const current = themeService.currentTheme();
    expect(current.color1).toBe('#ff0055');
    expect(current.color2).toBe('#1a0033');
    expect(current.isCustom).toBe(true);
  });

  it('should update individual color1 and color2', () => {
    themeService.updateColor1('#06b6d4');
    expect(themeService.currentTheme().color1).toBe('#06b6d4');

    themeService.updateColor2('#ec4899');
    expect(themeService.currentTheme().color2).toBe('#ec4899');
  });

  it('should open and close theme modal state', () => {
    expect(themeService.isThemeModalOpen()).toBe(false);
    themeService.openModal();
    expect(themeService.isThemeModalOpen()).toBe(true);
    themeService.closeModal();
    expect(themeService.isThemeModalOpen()).toBe(false);
  });

  it('should have 10+ Nitro presets and quick swatch palette defined', () => {
    expect(themeService.presets.length).toBeGreaterThanOrEqual(10);
    expect(themeService.quickSwatches.length).toBeGreaterThan(10);
  });
});

describe('I18nService Translation Engine', () => {
  let i18n: I18nService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    i18n = TestBed.inject(I18nService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should translate keys in Russian and English', () => {
    i18n.setLanguage('ru');
    expect(i18n.t('nav.allMusic')).toBe('Вся музыка');
    expect(i18n.t('theme.sectionTitle')).toBe('ЦВЕТОВАЯ СХЕМА ПЛЕЕРА');

    i18n.setLanguage('en');
    expect(i18n.t('nav.allMusic')).toBe('All Music');
    expect(i18n.t('theme.sectionTitle')).toBe('PLAYER COLOR THEME');
  });

  it('should toggle language between ru and en', () => {
    i18n.setLanguage('ru');
    i18n.toggleLanguage();
    expect(i18n.currentLang()).toBe('en');
    i18n.toggleLanguage();
    expect(i18n.currentLang()).toBe('ru');
  });

  it('should fallback gracefully when key is missing', () => {
    expect(i18n.t('non.existent.key', 'Fallback')).toBe('Fallback');
  });
});
