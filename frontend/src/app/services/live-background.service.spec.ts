import { TestBed } from '@angular/core/testing';
import { LiveBackgroundService, BG_PRESETS } from './live-background.service';
import { ThemeService } from './theme.service';
import { provideZonelessChangeDetection } from '@angular/core';

describe('LiveBackgroundService', () => {
  let service: LiveBackgroundService;
  let themeService: ThemeService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        LiveBackgroundService,
        ThemeService,
      ],
    });

    service = TestBed.inject(LiveBackgroundService);
    themeService = TestBed.inject(ThemeService);
  });

  it('should initialize with default values', () => {
    expect(service.presets.length).toBeGreaterThanOrEqual(5);
    expect(service.isSettingsOpen()).toBe(false);
  });

  it('should toggle settings open state', () => {
    expect(service.isSettingsOpen()).toBe(false);
    service.toggleSettings();
    expect(service.isSettingsOpen()).toBe(true);
    service.closeSettings();
    expect(service.isSettingsOpen()).toBe(false);
  });

  it('should switch presets and adapt theme colors when syncThemeWithBg is true', () => {
    service.setPreset('grid');
    expect(service.activePreset()).toBe('grid');

    const gridPreset = BG_PRESETS.find((p) => p.id === 'grid');
    expect(themeService.currentTheme().color1).toBe(gridPreset?.primaryColor);
  });

  it('should switch to off preset and disable global background', () => {
    service.setPreset('off');
    expect(service.activePreset()).toBe('off');
    expect(service.applyGlobally()).toBe(false);
  });

  it('should update dimmer and blur levels', () => {
    service.setDimmer(70);
    expect(service.dimmerLevel()).toBe(70);

    service.setBlur(16);
    expect(service.blurLevel()).toBe(16);
  });

  it('should update typography settings', () => {
    service.setFontSize('xl');
    expect(service.fontSize()).toBe('xl');

    service.setTextAlign('center');
    expect(service.textAlign()).toBe('center');

    service.toggleFocusMode();
    expect(service.focusMode()).toBe(false);
  });

  it('should reset all settings back to defaults', () => {
    service.setFontSize('xl');
    service.setTextAlign('center');
    service.setDimmer(70);
    service.setBlur(16);

    service.resetAllSettings();
    expect(service.activePreset()).toBe('default');
    expect(service.fontSize()).toBe('md');
    expect(service.textAlign()).toBe('left');
    expect(service.dimmerLevel()).toBe(45);
    expect(service.blurLevel()).toBe(8);
  });

  it('should maintain authoritative local state during rapid background switching', () => {
    service.setPreset('grid');
    expect(service.activePreset()).toBe('grid');
    expect(service.hasCustomWallpaper()).toBe(false);

    service.setPreset('waves');
    expect(service.activePreset()).toBe('waves');

    service.selectSavedItem({
      id: 'test_1',
      rawUrl: 'https://example.com/test.gif',
      mediaUrl: 'https://example.com/test.gif',
      mediaType: 'image',
      name: 'Anime GIF',
      addedAt: Date.now(),
    });
    expect(service.activePreset()).toBe('custom');
    expect(service.customMediaUrl()).toBe('https://example.com/test.gif');
    expect(service.hasCustomWallpaper()).toBe(true);

    // Switch to another preset rapidly - custom wallpaper flag must clear
    service.setPreset('rain');
    expect(service.activePreset()).toBe('rain');
    expect(service.hasCustomWallpaper()).toBe(false);
  });
});
