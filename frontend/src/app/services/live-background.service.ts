import { Injectable, signal, inject } from '@angular/core';
import { ThemeService } from './theme.service';

export interface BgPreset {
  id: 'default' | 'grid' | 'waves' | 'rain' | 'stars' | 'custom';
  nameRu: string;
  nameEn: string;
  primaryColor?: string;
  secondaryColor?: string;
}

export const BG_PRESETS: BgPreset[] = [
  { id: 'default', nameRu: 'Обложка трека', nameEn: 'Track Cover' },
  { id: 'grid', nameRu: 'Сетка', nameEn: 'Grid', primaryColor: '#06b6d4', secondaryColor: '#0b1329' },
  { id: 'waves', nameRu: 'Волны', nameEn: 'Waves', primaryColor: '#8b5cf6', secondaryColor: '#130924' },
  { id: 'rain', nameRu: 'Дождь', nameEn: 'Rain', primaryColor: '#38bdf8', secondaryColor: '#0c192c' },
  { id: 'stars', nameRu: 'Космос', nameEn: 'Stars', primaryColor: '#cbd5e1', secondaryColor: '#090a10' },
  { id: 'custom', nameRu: 'Свой файл', nameEn: 'Custom File' },
];

const DB_NAME = 'recro_live_bg_db';
const DB_VERSION = 1;
const STORE_NAME = 'backgrounds';
const KEY_CUSTOM = 'user_background';

@Injectable({
  providedIn: 'root',
})
export class LiveBackgroundService {
  private readonly themeService = inject(ThemeService);

  readonly presets = BG_PRESETS;

  // Реактивные сигналы состояния
  readonly activePreset = signal<string>(this.loadStorage('recro_bg_preset', 'default'));
  readonly customMediaUrl = signal<string | null>(null);
  readonly customMediaType = signal<'image' | 'video'>('image');
  readonly customMediaName = signal<string | null>(this.loadStorage('recro_bg_custom_name', ''));

  // Опции отображения
  readonly dimmerLevel = signal<number>(this.loadStorageNumber('recro_bg_dimmer', 45)); // 20 - 80%
  readonly blurLevel = signal<number>(this.loadStorageNumber('recro_bg_blur', 8)); // 0, 8, 16, 24px
  readonly syncThemeWithBg = signal<boolean>(this.loadStorageBool('recro_bg_sync_theme', true));
  readonly applyGlobally = signal<boolean>(this.loadStorageBool('recro_bg_global', true));

  // Панель настроек шестерёнки в lyrics
  readonly isSettingsOpen = signal<boolean>(false);

  // Настройки типографики караоке
  readonly fontSize = signal<'sm' | 'md' | 'lg' | 'xl'>((this.loadStorage('recro_lyrics_font_size', 'md') as any) || 'md');
  readonly fontFamily = signal<'sans' | 'serif' | 'mono'>((this.loadStorage('recro_lyrics_font_family', 'sans') as any) || 'sans');
  readonly textAlign = signal<'left' | 'center'>((this.loadStorage('recro_lyrics_text_align', 'left') as any) || 'left');
  readonly focusMode = signal<boolean>(this.loadStorageBool('recro_lyrics_focus_mode', true));

  constructor() {
    if (typeof window !== 'undefined') {
      this.initIndexedDbAndRestore();
    }
  }

  toggleSettings() {
    this.isSettingsOpen.update((v) => !v);
  }

  closeSettings() {
    this.isSettingsOpen.set(false);
  }

  // --- Пресеты ---

  setPreset(presetId: string) {
    this.activePreset.set(presetId);
    this.saveStorage('recro_bg_preset', presetId);

    if (presetId !== 'default') {
      this.applyGlobally.set(true);
      this.saveStorage('recro_bg_global', 'true');
    }

    const preset = BG_PRESETS.find((p) => p.id === presetId);
    if (preset?.primaryColor && preset?.secondaryColor && this.syncThemeWithBg()) {
      this.themeService.setCustomColors(preset.primaryColor, preset.secondaryColor);
    } else if (presetId === 'custom' && this.customMediaUrl() && this.syncThemeWithBg()) {
      this.extractPaletteAndApply(this.customMediaUrl()!, this.customMediaType() === 'video');
    }
  }

  // --- Настройки отображения фона ---

  setDimmer(percent: number) {
    this.dimmerLevel.set(percent);
    this.saveStorage('recro_bg_dimmer', String(percent));
  }

  setBlur(px: number) {
    this.blurLevel.set(px);
    this.saveStorage('recro_bg_blur', String(px));
  }

  toggleSyncTheme() {
    const next = !this.syncThemeWithBg();
    this.syncThemeWithBg.set(next);
    this.saveStorage('recro_bg_sync_theme', String(next));

    if (next) {
      if (this.activePreset() === 'custom' && this.customMediaUrl()) {
        this.extractPaletteAndApply(this.customMediaUrl()!, this.customMediaType() === 'video');
      } else {
        const p = BG_PRESETS.find((x) => x.id === this.activePreset());
        if (p?.primaryColor && p?.secondaryColor) {
          this.themeService.setCustomColors(p.primaryColor, p.secondaryColor);
        }
      }
    }
  }

  toggleApplyGlobally() {
    const next = !this.applyGlobally();
    this.applyGlobally.set(next);
    this.saveStorage('recro_bg_global', String(next));
  }

  // --- Настройки текста ---

  setFontSize(size: 'sm' | 'md' | 'lg' | 'xl') {
    this.fontSize.set(size);
    this.saveStorage('recro_lyrics_font_size', size);
  }

  setFontFamily(fam: 'sans' | 'serif' | 'mono') {
    this.fontFamily.set(fam);
    this.saveStorage('recro_lyrics_font_family', fam);
  }

  setTextAlign(align: 'left' | 'center') {
    this.textAlign.set(align);
    this.saveStorage('recro_lyrics_text_align', align);
  }

  toggleFocusMode() {
    const next = !this.focusMode();
    this.focusMode.set(next);
    this.saveStorage('recro_lyrics_focus_mode', String(next));
  }

  resetAllSettings() {
    this.setPreset('default');
    this.setDimmer(45);
    this.setBlur(8);
    this.setFontSize('md');
    this.setFontFamily('sans');
    this.setTextAlign('left');
    this.focusMode.set(true);
    this.saveStorage('recro_lyrics_focus_mode', 'true');
    this.themeService.resetToDefault();
  }

  // --- Загрузка локального файла (GIF / Video) без внешних ссылок ---

  async handleFileUpload(file: File) {
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) return;

    const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';

    // Освобождаем старый blob url
    if (this.customMediaUrl()) {
      try { URL.revokeObjectURL(this.customMediaUrl()!); } catch {}
    }

    const objectUrl = URL.createObjectURL(file);
    this.customMediaUrl.set(objectUrl);
    this.customMediaType.set(mediaType);
    this.customMediaName.set(file.name);
    this.activePreset.set('custom');
    this.applyGlobally.set(true);

    this.saveStorage('recro_bg_preset', 'custom');
    this.saveStorage('recro_bg_global', 'true');
    this.saveStorage('recro_bg_custom_name', file.name);

    // Сохраняем в IndexedDB
    await this.saveToIndexedDb(file);

    // Извлекаем палитру и адаптируем тему
    if (this.syncThemeWithBg()) {
      this.extractPaletteAndApply(objectUrl, isVideo);
    }
  }

  async removeCustomFile() {
    if (this.customMediaUrl()) {
      try { URL.revokeObjectURL(this.customMediaUrl()!); } catch {}
    }
    this.customMediaUrl.set(null);
    this.customMediaName.set(null);
    this.saveStorage('recro_bg_custom_name', '');
    this.setPreset('default');

    await this.deleteFromIndexedDb();
  }

  // --- IndexedDB ---

  private async openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async saveToIndexedDb(file: File): Promise<void> {
    try {
      const db = await this.openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(file, KEY_CUSTOM);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[LiveBackgroundService] Failed to save custom background to IndexedDB:', e);
    }
  }

  private async deleteFromIndexedDb(): Promise<void> {
    try {
      const db = await this.openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(KEY_CUSTOM);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('[LiveBackgroundService] Failed to delete from IndexedDB:', e);
    }
  }

  private async initIndexedDbAndRestore() {
    try {
      const db = await this.openDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY_CUSTOM);

      req.onsuccess = () => {
        const file = req.result as File | Blob | undefined;
        if (file) {
          const isVideo = file.type?.startsWith('video/') || false;
          const url = URL.createObjectURL(file);
          this.customMediaUrl.set(url);
          this.customMediaType.set(isVideo ? 'video' : 'image');

          if (this.activePreset() === 'custom' && this.syncThemeWithBg()) {
            this.extractPaletteAndApply(url, isVideo);
          }
        }
      };
    } catch {}
  }

  // --- Автоматическая адаптация темы под цветовую палитру GIF / Видео ---

  private extractPaletteAndApply(url: string, isVideo: boolean) {
    if (typeof document === 'undefined') return;

    if (isVideo) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.src = url;

      video.onloadeddata = () => {
        video.currentTime = 0.5;
      };

      video.onseeked = () => {
        this.processCanvasExtraction(video, video.videoWidth || 64, video.videoHeight || 64);
        video.src = '';
      };
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.processCanvasExtraction(img, img.naturalWidth || 64, img.naturalHeight || 64);
      };
      img.src = url;
    }
  }

  private processCanvasExtraction(mediaEl: CanvasImageSource, w: number, h: number) {
    try {
      const canvas = document.createElement('canvas');
      const size = 64;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(mediaEl, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      let bestScore = -1;
      let primaryRgb = [6, 182, 212]; // fallback cyan
      let darkRgb = [11, 19, 41];

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a < 128) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lum = (max + min) / 2;
        const delta = max - min;
        const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * (lum / 255) - 1));

        // Отбираем гармоничные выразительные цвета (не чересчур серые и не слепящие)
        if (lum < 35 || lum > 225 || sat < 0.2) continue;

        const score = sat * (1 - Math.abs(lum / 255 - 0.5));
        if (score > bestScore) {
          bestScore = score;
          primaryRgb = [r, g, b];
        }
      }

      // Формируем глубокий гармоничный темный оттенок для подложек
      darkRgb = [
        Math.max(8, Math.round(primaryRgb[0] * 0.12)),
        Math.max(10, Math.round(primaryRgb[1] * 0.12)),
        Math.max(18, Math.round(primaryRgb[2] * 0.15)),
      ];

      const toHex = (c: number[]) =>
        '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');

      const primaryHex = toHex(primaryRgb);
      const secondaryHex = toHex(darkRgb);

      this.themeService.setCustomColors(primaryHex, secondaryHex);
    } catch {}
  }

  // --- Хелперы LocalStorage ---

  private loadStorage(key: string, def: string): string {
    if (typeof localStorage === 'undefined') return def;
    try {
      const v = localStorage.getItem(key);
      return v !== null ? v : def;
    } catch {
      return def;
    }
  }

  private loadStorageNumber(key: string, def: number): number {
    if (typeof localStorage === 'undefined') return def;
    try {
      const v = localStorage.getItem(key);
      if (v !== null) {
        const parsed = parseInt(v, 10);
        return !isNaN(parsed) ? parsed : def;
      }
    } catch {}
    return def;
  }

  private loadStorageBool(key: string, def: boolean): boolean {
    if (typeof localStorage === 'undefined') return def;
    try {
      const v = localStorage.getItem(key);
      return v !== null ? v === 'true' : def;
    } catch {
      return def;
    }
  }

  private saveStorage(key: string, val: string) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, val);
    } catch {}
  }
}
