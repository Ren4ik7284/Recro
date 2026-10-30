import { Injectable, signal, computed, inject, effect, untracked } from '@angular/core';
import { ThemeService } from './theme.service';
import { AuthService } from './auth.service';
import { LibraryService } from './library.service';

export interface BgPreset {
  id: 'off' | 'default' | 'grid' | 'waves' | 'rain' | 'custom';
  nameRu: string;
  nameEn: string;
  primaryColor?: string;
  secondaryColor?: string;
}

export interface SavedMediaItem {
  id: string;
  rawUrl: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  name: string;
  addedAt: number;
}

export const BG_PRESETS: BgPreset[] = [
  { id: 'off', nameRu: 'Отключен', nameEn: 'Off' },
  { id: 'default', nameRu: 'Обложка трека', nameEn: 'Track Cover' },
  { id: 'grid', nameRu: 'Сетка', nameEn: 'Grid', primaryColor: '#06b6d4', secondaryColor: '#0b1329' },
  { id: 'waves', nameRu: 'Волны', nameEn: 'Waves', primaryColor: '#8b5cf6', secondaryColor: '#130924' },
  { id: 'rain', nameRu: 'Дождь', nameEn: 'Rain', primaryColor: '#38bdf8', secondaryColor: '#0c192c' },
  { id: 'custom', nameRu: 'Свой GIF / Видео', nameEn: 'Custom Media' },
];

const DB_NAME = 'recro_live_bg_db';
const DB_VERSION = 1;
const STORE_NAME = 'backgrounds';
const KEY_CUSTOM = 'user_background';
const KEY_SAVED_URLS = 'recro_saved_bg_urls_v1';

@Injectable({
  providedIn: 'root',
})
export class LiveBackgroundService {
  private readonly themeService = inject(ThemeService);
  private readonly authService = inject(AuthService, { optional: true });
  private readonly libraryService = inject(LibraryService, { optional: true });

  readonly presets = BG_PRESETS;

  // Реактивные сигналы состояния
  readonly activePreset = signal<string>(this.loadStorage('recro_bg_preset', 'default'));
  readonly customMediaUrl = signal<string | null>(this.loadStorage('recro_bg_custom_url', '') || null);
  readonly customMediaType = signal<'image' | 'video'>((this.loadStorage('recro_bg_custom_type', 'image') as any) || 'image');
  readonly customMediaName = signal<string | null>(this.loadStorage('recro_bg_custom_name', ''));

  readonly hasCustomWallpaper = computed<boolean>(() => {
    return this.activePreset() === 'custom' && Boolean(this.customMediaUrl());
  });

  // Опции отображения
  readonly dimmerLevel = signal<number>(this.loadStorageNumber('recro_bg_dimmer', 45)); // 20 - 80%
  readonly blurLevel = signal<number>(this.loadStorageNumber('recro_bg_blur', 8)); // 0, 8, 16, 24px
  readonly syncThemeWithBg = signal<boolean>(this.loadStorageBool('recro_bg_sync_theme', true));
  readonly applyGlobally = signal<boolean>(this.loadStorageBool('recro_bg_global', true));
  readonly isGlassTinted = signal<boolean>(this.loadStorageBool('recro_bg_glass_tint', true)); // Тонированное стекло

  // Панель настроек
  readonly isSettingsOpen = signal<boolean>(false);

  // Настройки типографики караоке
  readonly fontSize = signal<'sm' | 'md' | 'lg' | 'xl'>((this.loadStorage('recro_lyrics_font_size', 'md') as any) || 'md');
  readonly fontFamily = signal<'sans' | 'serif' | 'mono'>((this.loadStorage('recro_lyrics_font_family', 'sans') as any) || 'sans');
  readonly textAlign = signal<'left' | 'center'>((this.loadStorage('recro_lyrics_text_align', 'left') as any) || 'left');
  readonly focusMode = signal<boolean>(this.loadStorageBool('recro_lyrics_focus_mode', true));

  // Список сохранённых ссылок (Pinterest, GIF, MP4) для быстрого повторного использования
  readonly savedItems = signal<SavedMediaItem[]>(this.loadSavedItems());
  readonly isResolvingUrl = signal<boolean>(false);
  readonly resolveError = signal<string | null>(null);

  // Авторитетность и защита от сетевых гонок / отката назад
  private localRevision = Number(this.loadStorage('recro_bg_rev', '0')) || 0;
  private lastUserActionTime = Number(this.loadStorage('recro_bg_last_action', '0')) || 0;
  private activeUploadToken = 0;
  private lastAppliedCloudBgJson = '';
  private syncBgTimeout: any = null;

  private recordLocalChange() {
    this.localRevision++;
    this.lastUserActionTime = Date.now();
    this.saveStorage('recro_bg_rev', String(this.localRevision));
    this.saveStorage('recro_bg_last_action', String(this.lastUserActionTime));
  }

  constructor() {
    if (typeof window !== 'undefined') {
      this.initIndexedDbAndRestore();
    }

    // Синхронизация фонового оформления с облаком (только если в облаке реально более новая ревизия)
    effect(() => {
      const user = this.authService?.currentUser();
      if (!user || user.id === 'guest' || !user.profile_tags) return;

      try {
        const meta = JSON.parse(user.profile_tags);
        if (!meta || !meta.background) return;
        const bg = meta.background;
        const bgJson = JSON.stringify(bg);

        // 1. Если сам объект фона в профиле не изменился — игнорируем (например, обновилась статистика треков)
        if (bgJson === this.lastAppliedCloudBgJson) return;

        // 2. Cooldown защита: если пользователь менял фон локально менее 15с назад ИЛИ локальная ревизия новее/равна
        const cloudRev = typeof bg.rev === 'number' ? bg.rev : 0;
        const isLocallyLocked = (Date.now() - this.lastUserActionTime < 15000);
        if (isLocallyLocked || this.localRevision > cloudRev) {
          // Локальное состояние пользователя авторитетно — не откатываем назад!
          this.lastAppliedCloudBgJson = bgJson;
          return;
        }

        // 3. Применяем легитимное обновление из облака
        this.lastAppliedCloudBgJson = bgJson;
        this.localRevision = cloudRev;

        if (bg.preset && bg.preset !== untracked(() => this.activePreset())) {
          this.activePreset.set(bg.preset);
          this.saveStorage('recro_bg_preset', bg.preset);
        }
        if (typeof bg.dimmer === 'number' && bg.dimmer !== untracked(() => this.dimmerLevel())) {
          this.dimmerLevel.set(bg.dimmer);
          this.saveStorage('recro_bg_dimmer', String(bg.dimmer));
        }
        if (typeof bg.blur === 'number' && bg.blur !== untracked(() => this.blurLevel())) {
          this.blurLevel.set(bg.blur);
          this.saveStorage('recro_bg_blur', String(bg.blur));
        }
        if (typeof bg.isGlassTinted === 'boolean' && bg.isGlassTinted !== untracked(() => this.isGlassTinted())) {
          this.isGlassTinted.set(bg.isGlassTinted);
          this.saveStorage('recro_bg_glass_tint', String(bg.isGlassTinted));
        }
        if (typeof bg.applyGlobally === 'boolean' && bg.applyGlobally !== untracked(() => this.applyGlobally())) {
          this.applyGlobally.set(bg.applyGlobally);
          this.saveStorage('recro_bg_global', String(bg.applyGlobally));
        }
        if (typeof bg.syncThemeWithBg === 'boolean' && bg.syncThemeWithBg !== untracked(() => this.syncThemeWithBg())) {
          this.syncThemeWithBg.set(bg.syncThemeWithBg);
          this.saveStorage('recro_bg_sync_theme', String(bg.syncThemeWithBg));
        }
        if (bg.customMediaUrl && bg.customMediaUrl !== untracked(() => this.customMediaUrl())) {
          this.customMediaUrl.set(bg.customMediaUrl);
          this.customMediaType.set(bg.customMediaType || 'image');
          this.customMediaName.set(bg.customMediaName || 'Cloud Background');
          this.saveStorage('recro_bg_custom_url', bg.customMediaUrl);
          this.saveStorage('recro_bg_custom_type', bg.customMediaType || 'image');
          this.saveStorage('recro_bg_custom_name', bg.customMediaName || '');
        }
      } catch {}
    }, { allowSignalWrites: true });
  }

  toggleSettings() {
    this.isSettingsOpen.update((v) => !v);
    this.resolveError.set(null);
  }

  closeSettings() {
    this.isSettingsOpen.set(false);
    this.resolveError.set(null);
  }

  // --- Пресеты ---

  setPreset(presetId: string) {
    this.recordLocalChange();
    ++this.activeUploadToken;

    this.activePreset.set(presetId);
    this.saveStorage('recro_bg_preset', presetId);

    if (presetId === 'off') {
      this.applyGlobally.set(false);
      this.saveStorage('recro_bg_global', 'false');
    } else if (presetId !== 'default') {
      this.applyGlobally.set(true);
      this.saveStorage('recro_bg_global', 'true');
    }

    const preset = BG_PRESETS.find((p) => p.id === presetId);
    if (preset?.primaryColor && preset?.secondaryColor && this.syncThemeWithBg()) {
      this.themeService.setCustomColors(preset.primaryColor, preset.secondaryColor);
    } else if (presetId === 'custom' && this.customMediaUrl() && this.syncThemeWithBg()) {
      this.extractPaletteAndApply(this.customMediaUrl()!, this.customMediaType() === 'video');
    }
    this.syncBgToCloud();
  }

  // --- Настройки отображения фона ---

  setDimmer(percent: number) {
    this.recordLocalChange();
    this.dimmerLevel.set(percent);
    this.saveStorage('recro_bg_dimmer', String(percent));
    this.syncBgToCloud();
  }

  setBlur(px: number) {
    this.recordLocalChange();
    this.blurLevel.set(px);
    this.saveStorage('recro_bg_blur', String(px));
    this.syncBgToCloud();
  }

  toggleSyncTheme() {
    this.recordLocalChange();
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
    this.syncBgToCloud();
  }

  toggleApplyGlobally() {
    this.recordLocalChange();
    const next = !this.applyGlobally();
    this.applyGlobally.set(next);
    this.saveStorage('recro_bg_global', String(next));
    this.syncBgToCloud();
  }

  toggleGlassTint() {
    this.recordLocalChange();
    const next = !this.isGlassTinted();
    this.isGlassTinted.set(next);
    this.saveStorage('recro_bg_glass_tint', String(next));
    this.syncBgToCloud();
  }

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
    this.recordLocalChange();
    this.setPreset('default');
    this.setDimmer(45);
    this.setBlur(8);
    this.setFontSize('md');
    this.setFontFamily('sans');
    this.setTextAlign('left');
    this.focusMode.set(true);
    this.applyGlobally.set(true);
    this.isGlassTinted.set(true);
    this.themeService.resetToDefault();
    this.syncBgToCloud();
  }

  syncBgToCloud() {
    if (!this.authService?.isAuthenticated()) return;
    if (this.syncBgTimeout) clearTimeout(this.syncBgTimeout);
    this.syncBgTimeout = setTimeout(() => {
      const curRev = this.localRevision;
      const bgData = {
        rev: curRev,
        preset: this.activePreset(),
        dimmer: this.dimmerLevel(),
        blur: this.blurLevel(),
        isGlassTinted: this.isGlassTinted(),
        applyGlobally: this.applyGlobally(),
        syncThemeWithBg: this.syncThemeWithBg(),
        customMediaUrl: this.customMediaUrl()?.startsWith('blob:') ? null : this.customMediaUrl(),
        customMediaType: this.customMediaType(),
        customMediaName: this.customMediaName(),
      };
      try {
        this.lastAppliedCloudBgJson = JSON.stringify(bgData);
      } catch {}

      this.authService?.updateProfileCustomization((meta) => {
        return {
          ...meta,
          background: bgData,
        };
      }).catch(() => {});
    }, 400);
  }

  // --- Поддержка ссылок (Pinterest pin.it / Web Video / GIF) ---

  async resolveAndApplyUrl(rawUrl: string): Promise<boolean> {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) return false;

    const currentToken = ++this.activeUploadToken;
    this.recordLocalChange();

    this.isResolvingUrl.set(true);
    this.resolveError.set(null);

    try {
      const endpoint = `/api/resolve-media?url=${encodeURIComponent(trimmed)}`;
      const res = await fetch(endpoint);
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const data = await res.json();
      if (!data.media_url) {
        throw new Error('Media URL not found');
      }

      if (currentToken !== this.activeUploadToken) {
        return false;
      }

      const mediaUrl: string = data.media_url;
      const mediaType: 'image' | 'video' = data.media_type === 'video' ? 'video' : 'image';
      const title: string = data.title || (mediaType === 'video' ? 'Pinterest Video' : 'Pinterest Media');

      // Применяем как активный фон
      this.customMediaUrl.set(mediaUrl);
      this.customMediaType.set(mediaType);
      this.customMediaName.set(title);
      this.activePreset.set('custom');
      this.applyGlobally.set(true);
      this.isGlassTinted.set(true);

      this.saveStorage('recro_bg_preset', 'custom');
      this.saveStorage('recro_bg_global', 'true');
      this.saveStorage('recro_bg_glass_tint', 'true');
      this.saveStorage('recro_bg_custom_url', mediaUrl);
      this.saveStorage('recro_bg_custom_type', mediaType);
      this.saveStorage('recro_bg_custom_name', title);

      // Сохраняем в список сохраненных ссылок, чтобы не потерять
      this.addSavedItem({
        id: 'saved_' + Date.now(),
        rawUrl: trimmed,
        mediaUrl,
        mediaType,
        name: title,
        addedAt: Date.now(),
      });

      // Адаптируем цвета темы
      if (this.syncThemeWithBg()) {
        this.extractPaletteAndApply(mediaUrl, mediaType === 'video');
      }

      this.syncBgToCloud();
      this.isResolvingUrl.set(false);
      return true;
    } catch (err: any) {
      if (currentToken !== this.activeUploadToken) {
        return false;
      }
      console.warn('[LiveBackgroundService] Error resolving media URL, trying direct fallback:', err);

      // Прямой фолбек для прямых ссылок
      const isVideo = trimmed.toLowerCase().includes('.mp4') || trimmed.toLowerCase().includes('.webm');
      const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';
      const name = trimmed.split('/').pop()?.split('?')[0] || 'Web Media';

      this.customMediaUrl.set(trimmed);
      this.customMediaType.set(mediaType);
      this.customMediaName.set(name);
      this.activePreset.set('custom');
      this.applyGlobally.set(true);
      this.isGlassTinted.set(true);

      this.saveStorage('recro_bg_preset', 'custom');
      this.saveStorage('recro_bg_global', 'true');
      this.saveStorage('recro_bg_glass_tint', 'true');
      this.saveStorage('recro_bg_custom_url', trimmed);
      this.saveStorage('recro_bg_custom_type', mediaType);
      this.saveStorage('recro_bg_custom_name', name);

      this.addSavedItem({
        id: 'saved_' + Date.now(),
        rawUrl: trimmed,
        mediaUrl: trimmed,
        mediaType,
        name,
        addedAt: Date.now(),
      });

      if (this.syncThemeWithBg()) {
        this.extractPaletteAndApply(trimmed, mediaType === 'video');
      }

      this.syncBgToCloud();
      this.isResolvingUrl.set(false);
      return true;
    }
  }

  selectSavedItem(item: SavedMediaItem) {
    ++this.activeUploadToken;
    this.recordLocalChange();

    this.customMediaUrl.set(item.mediaUrl);
    this.customMediaType.set(item.mediaType);
    this.customMediaName.set(item.name);
    this.activePreset.set('custom');
    this.applyGlobally.set(true);
    this.isGlassTinted.set(true);

    this.saveStorage('recro_bg_preset', 'custom');
    this.saveStorage('recro_bg_global', 'true');
    this.saveStorage('recro_bg_glass_tint', 'true');
    this.saveStorage('recro_bg_custom_url', item.mediaUrl);
    this.saveStorage('recro_bg_custom_type', item.mediaType);
    this.saveStorage('recro_bg_custom_name', item.name);

    if (this.syncThemeWithBg()) {
      this.extractPaletteAndApply(item.mediaUrl, item.mediaType === 'video');
    }
    this.syncBgToCloud();
  }

  removeSavedItem(id: string) {
    const updated = this.savedItems().filter((x) => x.id !== id);
    this.savedItems.set(updated);
    this.saveSavedItems(updated);
  }

  private addSavedItem(item: SavedMediaItem) {
    const list = this.savedItems().filter((x) => x.rawUrl !== item.rawUrl);
    const updated = [item, ...list].slice(0, 15); // Храним последние 15
    this.savedItems.set(updated);
    this.saveSavedItems(updated);
  }

  private loadSavedItems(): SavedMediaItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(KEY_SAVED_URLS);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private saveSavedItems(items: SavedMediaItem[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(KEY_SAVED_URLS, JSON.stringify(items));
    } catch {}
  }

  // --- Загрузка локального файла (GIF / Video) без внешних ссылок ---

  async handleFileUpload(file: File) {
    if (!file) return;

    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    if (!isVideo && !isImage) return;

    const currentToken = ++this.activeUploadToken;
    this.recordLocalChange();

    const mediaType: 'image' | 'video' = isVideo ? 'video' : 'image';

    const previousUrl = this.customMediaUrl();
    const objectUrl = URL.createObjectURL(file);

    this.customMediaUrl.set(objectUrl);
    this.customMediaType.set(mediaType);
    this.customMediaName.set(file.name);
    this.activePreset.set('custom');
    this.applyGlobally.set(true);
    this.isGlassTinted.set(true);

    this.saveStorage('recro_bg_preset', 'custom');
    this.saveStorage('recro_bg_global', 'true');
    this.saveStorage('recro_bg_glass_tint', 'true');
    this.saveStorage('recro_bg_custom_name', file.name);
    this.saveStorage('recro_bg_custom_type', mediaType);
    this.saveStorage('recro_bg_custom_url', objectUrl);

    await this.saveToIndexedDb(file);

    // Безопасно очищаем старый blob через таймаут, чтобы избежать мигания
    if (previousUrl && previousUrl.startsWith('blob:') && previousUrl !== objectUrl) {
      setTimeout(() => {
        try { URL.revokeObjectURL(previousUrl); } catch {}
      }, 1500);
    }

    if (this.syncThemeWithBg()) {
      this.extractPaletteAndApply(objectUrl, isVideo);
    }

    this.syncBgToCloud();

    // Upload to server storage (compressed via ffmpeg) for cross-device persistence
    const backendUrl = this.libraryService?.getBackendUrl() || '';
    if (backendUrl) {
      const formData = new FormData();
      formData.append('file', file, file.name);

      fetch(`${backendUrl}/api/background/upload`, {
        method: 'POST',
        body: formData,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (currentToken !== this.activeUploadToken) {
            console.log('[LiveBackground] Stale file upload response discarded');
            return;
          }
          if (this.activePreset() !== 'custom') return;

          if (data && data.url) {
            const fullUrl = data.url.startsWith('/') ? `${backendUrl}${data.url}` : data.url;
            console.log('[LiveBackground] Server compressed & stored background:', fullUrl);
            this.customMediaUrl.set(fullUrl);
            this.customMediaType.set(data.mediaType || mediaType);
            this.saveStorage('recro_bg_custom_url', fullUrl);
            this.saveStorage('recro_bg_custom_type', data.mediaType || mediaType);
            this.syncBgToCloud();
          }
        })
        .catch((err) => console.warn('[LiveBackground] Server upload failed:', err));
    }
  }

  async removeCustomFile() {
    ++this.activeUploadToken;
    this.recordLocalChange();

    if (this.customMediaUrl() && this.customMediaUrl()!.startsWith('blob:')) {
      try { URL.revokeObjectURL(this.customMediaUrl()!); } catch {}
    }
    this.customMediaUrl.set(null);
    this.customMediaName.set(null);
    this.saveStorage('recro_bg_custom_name', '');
    this.saveStorage('recro_bg_custom_url', '');
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
      // Восстанавливаем локальный blob из IndexedDB ТОЛЬКО если пресет custom и нет активного веб-URL
      const curPreset = untracked(() => this.activePreset());
      const curUrl = untracked(() => this.customMediaUrl());
      if (curPreset !== 'custom') return;
      if (curUrl && !curUrl.startsWith('blob:')) return;

      const db = await this.openDb();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(KEY_CUSTOM);

      req.onsuccess = () => {
        if (this.activePreset() !== 'custom') return;
        const currentUrl = this.customMediaUrl();
        if (currentUrl && !currentUrl.startsWith('blob:')) return;

        if (req.result instanceof Blob) {
          const blob = req.result;
          const isVideo = blob.type.startsWith('video/');
          const url = URL.createObjectURL(blob);
          this.customMediaUrl.set(url);
          this.customMediaType.set(isVideo ? 'video' : 'image');

          this.applyGlobally.set(true);
          this.saveStorage('recro_bg_global', 'true');
          if (this.syncThemeWithBg()) {
            this.extractPaletteAndApply(url, isVideo);
          }
        }
      };
    } catch (e) {
      console.warn('[LiveBackgroundService] Could not restore from IndexedDB:', e);
    }
  }

  // --- Автоматическая адаптация цветовой темы через Canvas Color Extractor ---

  private extractPaletteAndApply(mediaUrl: string, isVideo: boolean) {
    if (typeof document === 'undefined') return;

    if (isVideo) {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.src = mediaUrl;
      video.currentTime = 1.0;
      video.onloadeddata = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 64;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, 64, 64);
            const { primary, secondary } = this.extractColorsFromCanvas(ctx, 64, 64);
            this.themeService.setCustomColors(primary, secondary);
          }
        } catch {}
      };
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = mediaUrl;
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 64;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, 64, 64);
            const { primary, secondary } = this.extractColorsFromCanvas(ctx, 64, 64);
            this.themeService.setCustomColors(primary, secondary);
          }
        } catch {}
      };
    }
  }

  private extractColorsFromCanvas(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): { primary: string; secondary: string } {
    const data = ctx.getImageData(0, 0, width, height).data;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let i = 0; i < data.length; i += 16) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
      if (brightness > 30 && brightness < 225) {
        rSum += r;
        gSum += g;
        bSum += b;
        count++;
      }
    }

    if (count === 0) {
      return { primary: '#38bdf8', secondary: '#1e293b' };
    }

    const avgR = Math.round(rSum / count);
    const avgG = Math.round(gSum / count);
    const avgB = Math.round(bSum / count);

    const primaryHex = `#${((1 << 24) + (avgR << 16) + (avgG << 8) + avgB).toString(16).slice(1)}`;
    const secR = Math.max(8, Math.round(avgR * 0.25));
    const secG = Math.max(10, Math.round(avgG * 0.25));
    const secB = Math.max(18, Math.round(avgB * 0.25));
    const secondaryHex = `#${((1 << 24) + (secR << 16) + (secG << 8) + secB).toString(16).slice(1)}`;

    return { primary: primaryHex, secondary: secondaryHex };
  }

  // --- Helpers ---

  private loadStorage(key: string, def: string): string {
    if (typeof localStorage === 'undefined') return def;
    return localStorage.getItem(key) || def;
  }

  private loadStorageNumber(key: string, def: number): number {
    if (typeof localStorage === 'undefined') return def;
    const val = localStorage.getItem(key);
    return val !== null ? Number(val) : def;
  }

  private loadStorageBool(key: string, def: boolean): boolean {
    if (typeof localStorage === 'undefined') return def;
    const val = localStorage.getItem(key);
    return val !== null ? val === 'true' : def;
  }

  private saveStorage(key: string, val: string) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, val);
    } catch {}
  }
}
