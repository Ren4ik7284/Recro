import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  effect,
  HostListener,
  ViewEncapsulation,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AudioService } from './services/audio.service';
import { LibraryService, ExtractedResult } from './services/library.service';
import { Track, Playlist, RadioStation, MixMood, MixSource, MixLanguage, MixConfig, DEFAULT_MIX_CONFIG } from './models/track.model';
import { HeaderComponent } from './components/header/header.component';
import { SidebarComponent } from './components/sidebar/sidebar.component';
import { PlayerBarComponent } from './components/player-bar/player-bar.component';
import { VisualizerComponent } from './components/visualizer/visualizer.component';
import { OfflineService } from './services/offline.service';
import { AuthService, HistoryItem, WrappedStats } from './services/auth.service';
import { RecommendationService } from './services/recommendation.service';
import { LyricsService } from './services/lyrics.service';
import { LyricsComponent } from './components/lyrics/lyrics.component';
import { NavigationService } from './services/navigation.service';
import { AmbientService } from './services/ambient.service';
import { PwaService } from './services/pwa.service';

declare global {
  interface Window {
    google?: any;
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    HeaderComponent,
    SidebarComponent,
    PlayerBarComponent,
    VisualizerComponent,
    LyricsComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  encapsulation: ViewEncapsulation.None,
})
export class App implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  readonly audioService = inject(AudioService);
  readonly libraryService = inject(LibraryService);
  readonly offlineService = inject(OfflineService);
  readonly authService = inject(AuthService);
  readonly recService = inject(RecommendationService);
  readonly lyricsService = inject(LyricsService);
  readonly navService = inject(NavigationService);
  readonly ambientService = inject(AmbientService);

  constructor() {
    // Динамический заголовок вкладки в браузере (Track - Artist | Recro)
    effect(() => {
      if (typeof document === 'undefined') return;
      const track = this.audioService.currentTrack();
      const isPlaying = this.audioService.isPlaying();
      if (track) {
        const icon = isPlaying ? '▶' : '⏸';
        document.title = `${icon} ${track.title} • ${track.artist} | Recro`;
      } else {
        document.title = 'Recro - Аудиоплеер';
      }
    });
  }

  readonly draggedQueueIndex = signal<number | null>(null);
  readonly dragOverQueueIndex = signal<number | null>(null);
  private touchStartIndex: number | null = null;

  readonly isQuickStartMixModalOpen = signal<boolean>(false);
  readonly isMixSettingsModalOpen = signal<boolean>(false);

  readonly isAuthModalOpen = signal<boolean>(false);
  readonly authModalTab = signal<'login' | 'register'>('login');
  readonly authUsernameInput = signal<string>('');
  readonly authPasswordInput = signal<string>('');
  readonly showPassword = signal<boolean>(false);
  readonly isGoogleConfigOpen = signal<boolean>(false);
  readonly customGoogleClientIdInput = signal<string>('');
  readonly authModalReason = signal<string | null>(null);
  readonly isGuestBannerDismissed = signal<boolean>(
    typeof window !== 'undefined' && sessionStorage.getItem('signal_guest_banner_dismissed') === 'true'
  );

  readonly isWrappedModalOpen = signal<boolean>(false);
  readonly wrappedStats = signal<WrappedStats | null>(null);
  readonly isLoadingWrapped = signal<boolean>(false);

  readonly isHistoryModalOpen = signal<boolean>(false);
  readonly historyList = signal<HistoryItem[]>([]);
  readonly isLoadingHistory = signal<boolean>(false);

  readonly isAddModalOpen = signal<boolean>(false);
  readonly addModalTab = signal<'youtube' | 'search' | 'radio' | 'url' | 'file'>('youtube');
  readonly isPlaylistModalOpen = signal<boolean>(false);
  readonly isQueueDrawerOpen = signal<boolean>(false);
  readonly activeTab = signal<'all' | 'favorites' | 'uploads' | 'streams' | 'playlist' | 'offline'>('all');
  readonly toastMessage = signal<string | null>(null);

  readonly isMobilePlayerExpanded = signal<boolean>(false);
  readonly isMobilePlaylistsOpen = signal<boolean>(false);

  readonly pwaService = inject(PwaService);
  readonly isMobileDevice = this.pwaService.isMobile;
  readonly canInstallPwa = this.pwaService.canPromptInstall;
  readonly isPwaModalOpen = this.pwaService.isInstallModalOpen;
  readonly isIos = this.pwaService.isIos;

  readonly modalSearchInput = signal<string>('');

  readonly currentPlaylist = computed(() => {
    const id = this.libraryService.activePlaylistId();
    if (!id) return null;
    return this.libraryService.playlists().find((p) => p.id === id) || null;
  });

  readonly activePlaylistPickerTrackId = signal<string | null>(null);

  readonly youtubeUrlInput = signal<string>('');
  readonly isExtractingUrl = signal<boolean>(false);
  readonly extractedResult = signal<ExtractedResult | null>(null);
  readonly extractMode = signal<'single' | 'playlist'>('single');
  readonly selectedExtractedTrackIds = signal<Set<string>>(new Set());
  readonly extractError = signal<string | null>(null);

  readonly radioSearchInput = signal<string>('');
  readonly isSearchingRadio = signal<boolean>(false);
  readonly radioSearchResults = signal<RadioStation[]>([]);
  readonly isAddStationModalOpen = signal<boolean>(false);
  readonly newStationName = signal<string>('');
  readonly newStationUrl = signal<string>('');
  readonly newStationGenre = signal<string>('Pop');

  readonly inputUrl = signal<string>('');
  readonly inputTitle = signal<string>('');
  readonly inputArtist = signal<string>('');
  readonly inputGenre = signal<string>('Web Stream');
  readonly isLiveStreamCheckbox = signal<boolean>(false);
  readonly isUrlValidating = signal<boolean>(false);

  readonly uploadFile = signal<File | null>(null);
  readonly uploadFileName = signal<string>('');
  readonly uploadTitle = signal<string>('');
  readonly uploadArtist = signal<string>('');
  readonly uploadGenre = signal<string>('Electronic');
  readonly isDragging = signal<boolean>(false);

  readonly playlistTitleInput = signal<string>('');
  readonly playlistDescInput = signal<string>('');

  readonly isAddToPlaylistModalOpen = signal<boolean>(false);
  readonly targetTrackForPlaylist = signal<Track | null>(null);
  readonly isRefreshingLibrary = signal<boolean>(false);

  readonly isScrubbing = signal<boolean>(false);
  readonly scrubTime = signal<number>(0);
  private toastTimeoutId: ReturnType<typeof setTimeout> | null = null;

  onScrubberInput(val: number) {
    this.isScrubbing.set(true);
    this.scrubTime.set(val);
  }

  onScrubberChange(val: number) {
    this.isScrubbing.set(false);
    this.audioService.seek(val);
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  ngOnInit() {
    this.libraryService.checkBackendHealth();
    this.authService.fetchAuthConfig(this.libraryService.getBackendUrl());

    this.navService.init((state) => {
      this.setView(state.tab, state.playlistId || undefined, false);

      const o = state.overlay;

      // Lyrics
      if (o === 'lyrics') {
        this.lyricsService.openLyrics(false);
      } else if (this.lyricsService.isLyricsOpen()) {
        this.lyricsService.closeLyrics(false);
      }

      // Visualizer
      if (o === 'visualizer') {
        this.audioService.openVisualizer(false);
      } else if (this.audioService.isVisualizerOpen()) {
        this.audioService.closeVisualizer(false);
      }

      // Mobile player
      this.isMobilePlayerExpanded.set(o === 'player');

      // Queue drawer
      this.isQueueDrawerOpen.set(o === 'queue');

      // Add modal
      this.isAddModalOpen.set(o === 'add');

      // Mobile playlists
      this.isMobilePlaylistsOpen.set(o === 'playlists');

      // Create playlist
      this.isPlaylistModalOpen.set(o === 'playlist-new');

      // Add to playlist
      this.isAddToPlaylistModalOpen.set(o === 'playlist-add');

      // History
      if (o === 'history') {
        if (!this.isHistoryModalOpen()) {
          this.openHistoryModal(false);
        }
      } else {
        this.isHistoryModalOpen.set(false);
      }

      // Mix settings
      this.isMixSettingsModalOpen.set(o === 'mix-settings');

      // Auth
      this.isAuthModalOpen.set(o === 'auth');

      // Wrapped
      if (o === 'wrapped') {
        if (!this.isWrappedModalOpen()) {
          this.openWrappedModal(false);
        }
      } else {
        this.isWrappedModalOpen.set(false);
      }

      // PWA
      if (o === 'pwa') {
        this.pwaService.openInstallModal();
      } else if (this.isPwaModalOpen()) {
        this.pwaService.closeInstallModal();
      }

      this.cdr.markForCheck();
    });
  }

  async openPwaInstallModal(pushHistory = true) {
    const outcome = await this.pwaService.promptInstall();
    if (outcome === 'accepted') {
      this.showToast('Приложение установлено');
    } else if (outcome === 'already-installed') {
      this.showToast('Приложение уже установлено');
    } else if (outcome === 'manual') {
      if (pushHistory) {
        this.navService.pushOverlay('pwa');
      }
    }
  }

  closePwaModal() {
    this.pwaService.closeInstallModal();
    this.navService.closeOverlay('pwa');
  }

  installPwa() {
    this.openPwaInstallModal();
  }

  @HostListener('wheel', ['$event'])
  onWindowWheel(event: WheelEvent) {
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

    let el = event.target as HTMLElement | null;
    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const isHorizScrollable = (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
      const isVertScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;

      if (isHorizScrollable && !isVertScrollable) {
        el.scrollLeft += event.deltaY;
        event.preventDefault();
        return;
      }

      if (isHorizScrollable) {
        const atVertBoundary = !isVertScrollable || 
          (event.deltaY > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1) ||
          (event.deltaY < 0 && el.scrollTop <= 1);
        
        if (atVertBoundary) {
          el.scrollLeft += event.deltaY;
          event.preventDefault();
          return;
        }
      }

      el = el.parentElement;
    }
  }

  onQueueDragStart(event: DragEvent, index: number) {
    this.draggedQueueIndex.set(index);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', index.toString());
    }
  }

  onQueueDragOver(event: DragEvent, index: number) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (this.dragOverQueueIndex() !== index) {
      this.dragOverQueueIndex.set(index);
    }
  }

  onQueueDragLeave(event: DragEvent, index: number) {
    if (this.dragOverQueueIndex() === index) {
      this.dragOverQueueIndex.set(null);
    }
  }

  onQueueDrop(event: DragEvent, targetIndex: number) {
    event.preventDefault();
    const fromIdx = this.draggedQueueIndex();
    if (fromIdx !== null && fromIdx !== targetIndex) {
      this.audioService.moveQueueItem(fromIdx, targetIndex);
    }
    this.draggedQueueIndex.set(null);
    this.dragOverQueueIndex.set(null);
  }

  onQueueDragEnd() {
    this.draggedQueueIndex.set(null);
    this.dragOverQueueIndex.set(null);
  }

  onQueueTouchStart(event: TouchEvent, index: number) {
    this.touchStartIndex = index;
    this.draggedQueueIndex.set(index);
  }

  onQueueTouchMove(event: TouchEvent) {
    if (this.touchStartIndex === null) return;
    const touch = event.touches[0];
    const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!targetEl) return;
    const queueItem = targetEl.closest('.queue-item') as HTMLElement | null;
    if (queueItem && queueItem.dataset['index'] !== undefined) {
      const idx = parseInt(queueItem.dataset['index'], 10);
      if (!isNaN(idx) && this.dragOverQueueIndex() !== idx) {
        this.dragOverQueueIndex.set(idx);
      }
    }
  }

  onQueueTouchEnd() {
    const fromIdx = this.touchStartIndex;
    const toIdx = this.dragOverQueueIndex();
    if (fromIdx !== null && toIdx !== null && fromIdx !== toIdx) {
      this.audioService.moveQueueItem(fromIdx, toIdx);
    }
    this.touchStartIndex = null;
    this.draggedQueueIndex.set(null);
    this.dragOverQueueIndex.set(null);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    if (event.code === 'Space') {
      event.preventDefault();
      this.audioService.togglePlay();
    } else if (event.shiftKey && event.code === 'ArrowRight') {
      event.preventDefault();
      this.audioService.next();
      this.showToast('Следующий трек');
    } else if (event.shiftKey && event.code === 'ArrowLeft') {
      event.preventDefault();
      this.audioService.prev();
      this.showToast('Предыдущий трек');
    } else if (event.code === 'ArrowRight') {
      event.preventDefault();
      this.audioService.skipBy(5);
      this.showToast('Перемотка +5с');
    } else if (event.code === 'ArrowLeft') {
      event.preventDefault();
      this.audioService.skipBy(-5);
      this.showToast('Перемотка -5с');
    } else if (event.code === 'ArrowUp') {
      event.preventDefault();
      this.audioService.setVolume(this.audioService.volume() + 0.05);
    } else if (event.code === 'ArrowDown') {
      event.preventDefault();
      this.audioService.setVolume(this.audioService.volume() - 0.05);
    } else if (event.key === 'n' || event.key === 'N' || event.key === 'т' || event.key === 'Т') {
      event.preventDefault();
      this.audioService.next();
      this.showToast('Следующий трек');
    } else if (event.key === 'p' || event.key === 'P' || event.key === 'з' || event.key === 'З') {
      event.preventDefault();
      this.audioService.prev();
      this.showToast('Предыдущий трек');
    } else if (event.key === 't' || event.key === 'T' || event.key === 'е' || event.key === 'Е') {
      event.preventDefault();
      this.lyricsService.toggleLyricsView();
    } else if (event.key === 'm' || event.key === 'ь' || event.key === 'M' || event.key === 'Ь') {
      event.preventDefault();
      this.audioService.toggleMute();
      this.showToast(this.audioService.isMuted() ? 'Звук выключен' : 'Звук включен');
    } else if (event.key === 'l' || event.key === 'д' || event.key === 'L' || event.key === 'Д') {
      const current = this.audioService.currentTrack();
      if (current) {
        event.preventDefault();
        this.toggleFavorite(current);
      }
    } else if (event.key === 'v' || event.key === 'V' || event.key === 'м' || event.key === 'М') {
      event.preventDefault();
      this.audioService.toggleVisualizer();
      this.showToast(this.audioService.isVisualizerOpen() ? 'Визуализатор открыт' : 'Визуализатор закрыт');
    } else if (event.key === 'Escape') {
      if (this.lyricsService.isLyricsOpen()) {
        this.lyricsService.closeLyrics();
      } else if (this.audioService.isVisualizerOpen()) {
        this.audioService.closeVisualizer();
      } else if (this.isQueueDrawerOpen()) {
        this.closeQueueDrawer();
      } else if (this.isAddModalOpen()) {
        this.closeAddModal();
      } else if (this.isPlaylistModalOpen()) {
        this.closeCreatePlaylistModal();
      } else if (this.isAddToPlaylistModalOpen()) {
        this.closeAddToPlaylistModal();
      } else if (this.isAuthModalOpen()) {
        this.closeAuthModal();
      } else if (this.isWrappedModalOpen()) {
        this.closeWrappedModal();
      } else if (this.isHistoryModalOpen()) {
        this.closeHistoryModal();
      } else if (this.isMixSettingsModalOpen()) {
        this.closeMixSettings();
      } else if (this.isPwaModalOpen()) {
        this.closePwaModal();
      } else if (this.isMobilePlaylistsOpen()) {
        this.closeMobilePlaylists();
      } else if (this.isMobilePlayerExpanded()) {
        this.collapseMobilePlayer();
      }
    }
  }

  showToast(msg: string) {
    // Отменяем предыдущий таймаут чтобы новый тост не обнулился раньше времени
    if (this.toastTimeoutId !== null) {
      clearTimeout(this.toastTimeoutId);
    }
    this.toastMessage.set(msg);
    this.toastTimeoutId = setTimeout(() => {
      this.toastMessage.set(null);
      this.toastTimeoutId = null;
    }, 3000);
  }

  dismissGuestBanner() {
    this.isGuestBannerDismissed.set(true);
    try {
      sessionStorage.setItem('signal_guest_banner_dismissed', 'true');
    } catch {}
  }

  /** Guard: требует авторизацию, иначе открывает модалку с поясняющей плашкой */
  requireAuth(actionName?: string): boolean {
    if (this.authService.isAuthenticated()) return true;
    const toastMsg = actionName
      ? `Действие требует аккаунт: ${actionName}`
      : 'Войдите в аккаунт для этого действия';
    this.showToast(toastMsg);

    // Легкая вибрация на смартфонах при блокировке действия
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(30); } catch {}
    }

    const reason = actionName
      ? `Чтобы ${actionName}, необходимо войти в аккаунт или зарегистрироваться.`
      : 'Для доступа к этой функции необходимо войти в систему.';
    this.openAuthModal('register', reason);
    return false;
  }

  openAddModalGuarded(tab?: 'youtube' | 'search' | 'radio' | 'url' | 'file', pushHistory = true) {
    if (tab) this.addModalTab.set(tab);
    this.isAddModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('add');
    }
  }

  closeAddModal() {
    this.isAddModalOpen.set(false);
    this.navService.closeOverlay('add');
  }

  openAuthModal(tab: 'login' | 'register' = 'login', reason?: string, pushHistory = true) {
    this.authModalTab.set(tab);
    this.authModalReason.set(reason || null);
    this.authUsernameInput.set('');
    this.authPasswordInput.set('');
    this.authService.authError.set(null);
    this.isGoogleConfigOpen.set(false);
    this.customGoogleClientIdInput.set(this.authService.googleClientId() || '');
    this.isAuthModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('auth');
    }

    this.renderGoogleButton();
  }

  closeAuthModal() {
    this.isAuthModalOpen.set(false);
    this.navService.closeOverlay('auth');
  }

  toggleGoogleConfig() {
    this.isGoogleConfigOpen.update((v) => !v);
  }

  saveCustomGoogleClientId() {
    const val = this.customGoogleClientIdInput().trim();
    if (!val) {
      this.authService.authError.set('Введите Google Client ID');
      return;
    }
    this.authService.setCustomGoogleClientId(val);
    this.isGoogleConfigOpen.set(false);
    this.showToast('Google Client ID сохранён');
    this.renderGoogleButton();
  }

  async renderGoogleButton() {
    const backendUrl = this.libraryService.getBackendUrl();
    await this.authService.fetchAuthConfig(backendUrl);

    const clientId = this.authService.googleClientId();
    if (!clientId) return;

    const loaded = await this.ensureGoogleScriptLoaded();
    if (!loaded || !window.google?.accounts?.id) {
      return;
    }

    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (response: any) => {
          if (response && response.credential) {
            const ok = await this.authService.loginWithGoogle(
              this.libraryService.getBackendUrl(),
              response.credential
            );
            if (ok) {
              this.closeAuthModal();
              const username = this.authService.currentUser()?.username || 'пользователь';
              this.showToast(`Вход выполнен! С возвращением, ${username}!`);
              this.audioService.resetSessionAudio();
              await this.libraryService.onUserLoggedIn();
            }
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
        ux_mode: 'popup',
        context: 'signin',
      });

      setTimeout(() => {
        const slot = document.getElementById('google-btn-slot');
        if (slot && window.google?.accounts?.id) {
          slot.innerHTML = '';
          const buttonWidth = typeof window !== 'undefined' ? Math.min(320, window.innerWidth - 64) : 280;
          window.google.accounts.id.renderButton(slot, {
            type: 'standard',
            theme: 'filled_black',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: buttonWidth,
          });
        }
      }, 60);
    } catch (err) {
      console.warn('[Recro GSI] Ошибка инициализации кнопки Google:', err);
    }
  }

  private ensureGoogleScriptLoaded(): Promise<boolean> {
    if (typeof window === 'undefined') return Promise.resolve(false);
    if (window.google?.accounts?.id) return Promise.resolve(true);

    return new Promise((resolve) => {
      let attempts = 0;
      const timer = setInterval(() => {
        attempts++;
        if (window.google?.accounts?.id) {
          clearInterval(timer);
          resolve(true);
        } else if (attempts >= 25) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
    });
  }

  async submitAuth() {
    const backendUrl = this.libraryService.getBackendUrl();

    if (this.authModalTab() === 'login') {
      const loginVal = this.authUsernameInput().trim();
      const pass = this.authPasswordInput().trim();

      if (!loginVal || !pass) {
        this.authService.authError.set('Заполните логин и пароль');
        return;
      }

      if (this.authService.hasWhitespace(loginVal)) {
        this.authService.authError.set('Логин не должен содержать пробелы');
        return;
      }

      const ok = await this.authService.login(backendUrl, loginVal, pass);
      if (ok) {
        this.authPasswordInput.set('');
        this.closeAuthModal();
        this.showToast(`Добро пожаловать, ${this.authService.currentUser()?.username || loginVal}!`);
        this.audioService.resetSessionAudio();
        await this.libraryService.onUserLoggedIn();
      }
    } else if (this.authModalTab() === 'register') {
      const username = this.authUsernameInput().trim();
      const pass = this.authPasswordInput().trim();

      if (!username || !pass) {
        this.authService.authError.set('Заполните имя пользователя и пароль');
        return;
      }

      if (this.authService.hasWhitespace(username)) {
        this.authService.authError.set('Имя пользователя не должно содержать пробелы');
        return;
      }

      if (!this.authService.isValidUsername(username)) {
        this.authService.authError.set('Имя пользователя должно быть от 3 до 30 символов (только латиница, цифры, _ и -)');
        return;
      }

      if (!this.authService.isValidPassword(pass)) {
        this.authService.authError.set('Пароль должен содержать от 6 до 72 символов');
        return;
      }

      const ok = await this.authService.register(backendUrl, username, pass);
      if (ok) {
        this.authPasswordInput.set('');
        this.closeAuthModal();
        this.showToast(`Регистрация успешна! Добро пожаловать, ${username}!`);
        this.audioService.resetSessionAudio();
        await this.libraryService.onUserLoggedIn();
      }
    }
  }

  async openWrappedModal(pushHistory = true) {
    if (!this.authService.isAuthenticated()) {
      this.showToast('Войдите в аккаунт для просмотра Recro Wrapped');
      this.openAuthModal('login', 'Чтобы посмотреть персональную статистику и итоги прослушиваний Recro Wrapped, войдите в аккаунт.');
      return;
    }

    this.isLoadingWrapped.set(true);
    this.isWrappedModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('wrapped');
    }
    try {
      const stats = await this.libraryService.getWrappedStats();
      this.wrappedStats.set(stats);
    } catch {
      this.showToast('Не удалось загрузить статистику');
    } finally {
      this.isLoadingWrapped.set(false);
    }
  }

  closeWrappedModal() {
    this.isWrappedModalOpen.set(false);
    this.navService.closeOverlay('wrapped');
  }

  async openHistoryModal(pushHistory = true) {
    if (!this.authService.isAuthenticated()) {
      this.showToast('Войдите в аккаунт для просмотра истории');
      this.openAuthModal('login', 'Чтобы просматривать и быстро воспроизводить историю прослушиваний, войдите в аккаунт.');
      return;
    }

    this.isLoadingHistory.set(true);
    this.isHistoryModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('history');
    }
    try {
      const history = await this.libraryService.getHistory();
      this.historyList.set(history);
    } catch {
      this.showToast('Не удалось загрузить историю');
    } finally {
      this.isLoadingHistory.set(false);
    }
  }

  closeHistoryModal() {
    this.isHistoryModalOpen.set(false);
    this.navService.closeOverlay('history');
  }

  async clearListeningHistory() {
    if (confirm('Очистить всю историю прослушиваний?')) {
      const ok = await this.libraryService.clearHistory();
      if (ok) {
        this.historyList.set([]);
        this.showToast('История прослушиваний очищена');
      }
    }
  }

  playFromHistory(item: HistoryItem) {
    const existing = this.libraryService.tracks().find((t) => t.id === item.track_id);
    if (existing) {
      this.playTrack(existing);
    } else {
      const tempTrack: Track = {
        id: item.track_id,
        title: item.track_title,
        artist: item.track_artist,
        duration: item.duration || 0,
        audioUrl: `${this.libraryService.getBackendUrl()}/api/stream?id=${encodeURIComponent(item.track_id.replace(/^yt-/, ''))}&title=${encodeURIComponent(item.track_title)}&artist=${encodeURIComponent(item.track_artist)}`,
        coverUrl: item.cover_url,
        genre: item.track_genre || 'Music',
        format: 'mp3',
        plays: 1,
        isFavorite: false,
        addedAt: new Date(item.played_at * 1000).toISOString().split('T')[0],
      };
      this.libraryService.addTrackToLibrary(tempTrack);
      this.playTrack(tempTrack);
    }
    this.showToast(`Воспроизведение: ${item.track_title}`);
  }

  formatHistoryDate(timestampSecs: number): string {
    if (!timestampSecs) return '';
    const date = new Date(timestampSecs * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Только что';
    if (diffMins < 60) return `${diffMins} мин назад`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} ч назад`;

    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  setView(view: 'all' | 'favorites' | 'uploads' | 'streams' | 'playlist' | 'offline', playlistId?: string, pushHistory = true) {
    this.activeTab.set(view);
    this.libraryService.selectedView.set(view);
    if (playlistId) {
      this.libraryService.activePlaylistId.set(playlistId);
    } else {
      this.libraryService.activePlaylistId.set(null);
    }
    this.isMobilePlaylistsOpen.set(false);

    if (pushHistory) {
      this.navService.setTab(view, playlistId, true);
    }
    this.cdr.markForCheck();
  }

  expandMobilePlayer() {
    this.isMobilePlayerExpanded.set(true);
    this.navService.pushOverlay('player');
  }

  collapseMobilePlayer() {
    this.isMobilePlayerExpanded.set(false);
    this.navService.closeOverlay('player');
  }

  openQueueDrawer() {
    this.isQueueDrawerOpen.set(true);
    this.navService.pushOverlay('queue');
  }

  closeQueueDrawer() {
    this.isQueueDrawerOpen.set(false);
    this.navService.closeOverlay('queue');
  }

  toggleQueueDrawer() {
    if (this.isQueueDrawerOpen()) {
      this.closeQueueDrawer();
    } else {
      this.openQueueDrawer();
    }
  }

  openMobilePlaylists() {
    this.isMobilePlaylistsOpen.set(true);
    this.navService.pushOverlay('playlists');
  }

  closeMobilePlaylists() {
    this.isMobilePlaylistsOpen.set(false);
    this.navService.closeOverlay('playlists');
  }

  selectGenre(genre: string) {
    this.libraryService.selectedGenre.set(genre);
  }

  playTrack(track: Track) {
    this.audioService.playTrack(track, this.libraryService.filteredTracks());
  }

  toggleFavorite(track: Track, event?: Event) {
    if (event) event.stopPropagation();
    if (!this.requireAuth('добавлять в избранное')) return;
    const isNowFav = this.libraryService.toggleFavorite(track.id, track);
    this.audioService.updateTrackFavoriteStatus(track.id, isNowFav, track);
    if (isNowFav) {
      this.recService.recordTrackLike(track);
      this.showToast('Добавлено в избранное');
    } else {
      this.showToast('Удалено из избранного');
    }
  }

  addToQueue(track: Track, event?: Event) {
    if (event) event.stopPropagation();
    this.audioService.addToQueue(track);
    this.showToast('Добавлено в очередь');
  }

  openAddToPlaylistModal(track: Track, event?: Event, pushHistory = true) {
    if (event) event.stopPropagation();
    if (!this.requireAuth('управлять плейлистами')) return;
    this.targetTrackForPlaylist.set(track);
    this.isAddToPlaylistModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('playlist-add');
    }
  }

  closeAddToPlaylistModal() {
    this.isAddToPlaylistModalOpen.set(false);
    this.navService.closeOverlay('playlist-add');
  }

  toggleTrackInPlaylistFromModal(playlist: Playlist) {
    const track = this.targetTrackForPlaylist();
    if (!track) return;
    this.libraryService.addTrackToLibrary({ ...track, playlistOnly: false });
    const isAdded = this.libraryService.toggleTrackInPlaylist(playlist.id, track.id);
    this.showToast(
      isAdded
        ? `Трек добавлен в "${playlist.title}"`
        : `Трек убран из "${playlist.title}"`
    );
  }

  deleteTrack(track: Track, event?: Event) {
    if (event) event.stopPropagation();

    if (this.activeTab() === 'playlist' && this.currentPlaylist()) {
      const pl = this.currentPlaylist()!;
      this.libraryService.removeTrackFromPlaylist(pl.id, track.id);
      this.showToast(`Трек убран из плейлиста "${pl.title}"`);
    } else {
      this.libraryService.deleteTrack(track.id);
      this.showToast(`Трек "${track.title}" удален`);
    }
  }

  async refreshLibrary() {
    this.isRefreshingLibrary.set(true);
    try {
      await this.libraryService.syncWithBackendOnStartup();
      this.showToast('Медиатека обновлена');
    } catch {
      this.showToast('Не удалось обновить медиатеку');
    } finally {
      this.isRefreshingLibrary.set(false);
    }
  }

  clearAllLibraryTracks() {
    if (confirm('Вы действительно хотите удалить все треки из медиатеки?')) {
      this.libraryService.clearAllTracks();
      this.showToast('Медиатека очищена');
    }
  }

  async toggleOfflineTrack(track: Track, event?: Event) {
    if (event) event.stopPropagation();
    if (!this.requireAuth('сохранять оффлайн')) return;
    if (track.isLiveStream) {
      this.showToast('Прямой эфир нельзя сохранить оффлайн');
      return;
    }

    if (this.offlineService.isTrackOffline(track.id)) {
      await this.offlineService.removeTrackOffline(track.id);
      this.libraryService.updateTrackOfflineStatus(track.id, false);
      this.showToast('Трек удалён из оффлайн-хранилища');
    } else {
      this.showToast('Загрузка трека в кэш...');
      const ok = await this.offlineService.saveTrackOffline(track);
      if (ok) {
        this.libraryService.addTrackToLibrary(track);
        this.libraryService.updateTrackOfflineStatus(track.id, true);
        this.showToast('Трек сохранён для оффлайн-прослушивания!');
      } else {
        this.showToast('Ошибка при загрузке трека');
      }
    }
  }

  async toggleSmartMix(mood: MixMood = 'all') {
    const isCurrentlyActive = this.recService.isMixActive();
    const currentMood = this.recService.currentMood();

    if (isCurrentlyActive && currentMood === mood) {
      this.audioService.togglePlay();
      return;
    }

    if (isCurrentlyActive && currentMood !== mood) {
      this.audioService.setMixMood(mood);
      const moodNames: Record<MixMood, string> = {
        all: 'Все стили',
        energetic: 'Бодрый вайб',
        chill: 'Спокойный чилл',
        favorites: 'Только любимое',
      };
      this.showToast(`Режим волны: ${moodNames[mood]}`);
      return;
    }

    this.showToast('Запуск Моей Волны...');
    const ok = await this.audioService.startSmartMix(mood);
    if (!ok) {
      this.isQuickStartMixModalOpen.set(true);
    }
  }

  async selectQuickStartVibe(vibe: 'phonk' | 'hiphop' | 'rock' | 'lofi' | 'pop' | 'indie') {
    this.recService.setQuickStartVibe(vibe);
    this.isQuickStartMixModalOpen.set(false);
    this.showToast('Подбираем треки под выбранный стиль...');
    const ok = await this.audioService.startSmartMix('all');
    if (ok) {
      this.showToast('Волна запущена!');
    }
  }

  openMixSettings(pushHistory = true) {
    if (!this.requireAuth('настраивать персональную Мою Волну')) return;
    this.isMixSettingsModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('mix-settings');
    }
  }

  closeMixSettings() {
    this.isMixSettingsModalOpen.set(false);
    this.navService.closeOverlay('mix-settings');
  }

  updateMixMood(mood: MixMood) {
    this.libraryService.setMixConfig({ mood });
    if (this.recService.isMixActive()) {
      this.audioService.setMixMood(mood);
    }
  }

  updateMixSource(source: MixSource) {
    this.libraryService.setMixConfig({ source });
    if (this.recService.isMixActive()) {
      this.audioService.setMixMood(this.recService.currentMood());
    }
  }

  updateMixLanguage(language: MixLanguage) {
    this.libraryService.setMixConfig({ language });
    if (this.recService.isMixActive()) {
      this.audioService.setMixMood(this.recService.currentMood());
    }
  }

  resetMixConfig() {
    this.libraryService.setMixConfig(DEFAULT_MIX_CONFIG);
    if (this.recService.isMixActive()) {
      this.audioService.setMixMood('all');
    }
    this.showToast('Параметры волны сброшены по умолчанию');
  }

  dislikeCurrentTrack() {
    if (!this.requireAuth('обучать персональные рекомендации')) return;
    const cur = this.audioService.currentTrack();
    if (!cur) return;
    this.audioService.dislikeCurrentTrack();
    this.showToast(`Трек "${cur.title}" скрыт и не будет звучать`);
  }

  async triggerOnlineSearch() {
    const q = this.modalSearchInput().trim();
    if (!q) return;
    await this.libraryService.searchOnline(q);
  }

  openOnlineSearchWithQuery(query: string) {
    if (query.startsWith('http://') || query.startsWith('https://')) {
      this.youtubeUrlInput.set(query);
      this.openAddModalGuarded('youtube');
      this.extractYouTubeUrl();
      return;
    }
    this.modalSearchInput.set(query);
    this.openAddModalGuarded('search');
    this.triggerOnlineSearch();
  }

  playOnlineTrack(track: Track) {
    this.libraryService.addTrackToLibrary(track);
    this.audioService.playTrack(track, this.libraryService.tracks());
    this.showToast(`Воспроизведение: ${track.title}`);
    // Не скачиваем автоматически — пользователь должен явно нажать кнопку оффлайн
  }

  addOnlineTrackToLib(track: Track) {
    this.libraryService.addTrackToLibrary(track);
    this.audioService.playTrack(track, this.libraryService.tracks());
    this.showToast(`Трек "${track.title}" добавлен и воспроизводится`);
    // Не скачиваем автоматически — пользователь должен явно нажать кнопку оффлайн
  }

  async extractYouTubeUrl() {
    const url = this.youtubeUrlInput().trim();
    if (!url) return;

    this.isExtractingUrl.set(true);
    this.extractError.set(null);
    this.extractedResult.set(null);

    try {
      const res = await this.libraryService.extractFromUrl(url);
      if ((!res.tracks || res.tracks.length === 0) && !res.mainVideo) {
        this.extractError.set('Не удалось извлечь аудио по этой ссылке. Проверьте URL.');
      } else {
        this.extractedResult.set(res);
        if (res.mainVideo && (res.isRadioMix || res.mainVideo.duration > 600 || res.tracks.length <= 1)) {
          this.extractMode.set('single');
        } else {
          this.extractMode.set('playlist');
        }
        this.selectedExtractedTrackIds.set(new Set(res.tracks.map((t) => t.id)));
      }
    } catch {
      this.extractError.set('Ошибка соединения с бэкендом. Убедитесь, что бэкенд запущен.');
    } finally {
      this.isExtractingUrl.set(false);
    }
  }

  addExtractedSingleTrack(playNow = true) {
    const data = this.extractedResult();
    const track = data?.mainVideo || data?.tracks[0];
    if (!track) return;

    this.libraryService.addTrackToLibrary(track);
    this.audioService.playTrack(track, this.libraryService.tracks());
    this.showToast(`Воспроизведение: ${track.title}`);

    this.closeAddModal();
    this.youtubeUrlInput.set('');
    this.extractedResult.set(null);
  }

  toggleSelectExtractedTrack(trackId: string) {
    this.selectedExtractedTrackIds.update((set) => {
      const next = new Set(set);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  }

  toggleSelectAllExtractedTracks() {
    const data = this.extractedResult();
    if (!data) return;
    const allIds = data.tracks.map((t) => t.id);
    const current = this.selectedExtractedTrackIds();
    if (current.size === allIds.length) {
      this.selectedExtractedTrackIds.set(new Set());
    } else {
      this.selectedExtractedTrackIds.set(new Set(allIds));
    }
  }

  importAllExtractedTracks(onlySelected = false) {
    if (!this.requireAuth('импортировать плейлист')) return;
    const data = this.extractedResult();
    if (!data || data.tracks.length === 0) return;

    let tracksToImport = data.tracks;
    if (onlySelected) {
      const selected = this.selectedExtractedTrackIds();
      tracksToImport = data.tracks.filter((t) => selected.has(t.id));
    }

    if (tracksToImport.length === 0) {
      this.showToast('Выберите хотя бы один трек для импорта');
      return;
    }

    const title = data.playlistTitle || data.mainVideo?.title || 'YouTube Плейлист';
    const createdPl = this.libraryService.importPlaylist(title, tracksToImport);
    this.showToast(`Создан плейлист "${title}" (${tracksToImport.length} треков)`);
    this.closeAddModal();
    this.youtubeUrlInput.set('');
    this.extractedResult.set(null);
    this.setView('playlist', createdPl.id);
  }

  addExtractedTracksToLibraryOnly() {
    const data = this.extractedResult();
    if (!data || data.tracks.length === 0) return;

    const selected = this.selectedExtractedTrackIds();
    const tracksToAdd = selected.size > 0 ? data.tracks.filter((t) => selected.has(t.id)) : data.tracks;

    this.libraryService.addMultipleTracks(tracksToAdd);
    this.showToast(`Добавлено ${tracksToAdd.length} треков в медиатеку`);
    this.closeAddModal();
    this.youtubeUrlInput.set('');
    this.extractedResult.set(null);
  }

  playExtractedTrackNow(track: Track) {
    this.libraryService.addTrackToLibrary(track);
    this.audioService.playTrack(track, this.libraryService.tracks());
    this.showToast(`Воспроизведение: ${track.title}`);
  }

  async searchRadio() {
    const q = this.radioSearchInput().trim();
    if (!q) {
      this.radioSearchResults.set([]);
      return;
    }

    this.isSearchingRadio.set(true);
    try {
      const results = await this.libraryService.searchRadioBrowser(q);
      this.radioSearchResults.set(results);
    } catch {
      this.radioSearchResults.set([]);
    } finally {
      this.isSearchingRadio.set(false);
    }
  }

  playRadioStation(station: RadioStation) {
    const track = this.libraryService.createTrackFromStation(station);
    this.audioService.playTrack(track, [track]);
    this.showToast(`Радио: ${station.name}`);
  }

  addRadioStationToMyList(station: RadioStation) {
    if (!this.requireAuth('сохранять станции')) return;
    this.libraryService.addRadioStation({
      name: station.name,
      streamUrl: station.streamUrl,
      genre: station.genre,
      country: station.country,
      bitrate: station.bitrate,
    });
    this.showToast(`Станция "${station.name}" сохранена`);
  }

  deleteRadioStation(stationId: string) {
    if (!this.requireAuth('управлять радиостанциями')) return;
    this.libraryService.removeRadioStation(stationId);
    this.showToast('Радиостанция удалена');
  }

  resetRadioStations() {
    if (!this.requireAuth('управлять радиостанциями')) return;
    this.libraryService.resetDefaultStations();
    this.showToast('Список радиостанций сброшен по умолчанию');
  }

  saveCustomStation() {
    if (!this.requireAuth('управлять радиостанциями')) return;
    const name = this.newStationName().trim();
    const url = this.newStationUrl().trim();
    if (!url) return;

    this.libraryService.addRadioStation({
      name: name || 'Мое радио',
      streamUrl: url,
      genre: this.newStationGenre().trim() || 'Custom',
    });

    this.isAddStationModalOpen.set(false);
    this.newStationName.set('');
    this.newStationUrl.set('');
    this.showToast(`Станция "${name || 'Мое радио'}" добавлена`);
  }

  openCreatePlaylistModal(pushHistory = true) {
    if (!this.requireAuth('создавать плейлисты')) return;
    this.playlistTitleInput.set('');
    this.playlistDescInput.set('');
    this.isPlaylistModalOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('playlist-new');
    }
  }

  closeCreatePlaylistModal() {
    this.isPlaylistModalOpen.set(false);
    this.navService.closeOverlay('playlist-new');
  }

  submitCreatePlaylist() {
    if (!this.requireAuth('создавать плейлисты')) return;
    const title = this.playlistTitleInput().trim();
    if (!title) return;

    const desc = this.playlistDescInput().trim();
    const pl = this.libraryService.createPlaylist(title, desc);
    this.closeCreatePlaylistModal();
    this.showToast(`Плейлист "${pl.title}" создан`);
    this.setView('playlist', pl.id);
  }

  deleteCurrentPlaylist() {
    if (!this.requireAuth('управлять плейлистами')) return;
    const pl = this.currentPlaylist();
    if (!pl) return;
    this.libraryService.deletePlaylist(pl.id);
    this.showToast(`Плейлист "${pl.title}" удален`);
  }

  toggleTrackInPlaylist(playlist: Playlist, track: Track) {
    const isAdded = this.libraryService.toggleTrackInPlaylist(playlist.id, track.id);
    this.showToast(
      isAdded
        ? `Трек добавлен в "${playlist.title}"`
        : `Трек убран из "${playlist.title}"`
    );
    this.activePlaylistPickerTrackId.set(null);
  }

  async submitUrlTrack() {
    const url = this.inputUrl().trim();
    const title = this.inputTitle().trim();
    const artist = this.inputArtist().trim();

    if (!url && !title) return;

    this.isUrlValidating.set(true);
    try {
      let track: Track;
      if (!url && title) {
        track = {
          id: 'manual-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
          title,
          artist: artist || 'Разные исполнители',
          album: 'Recro Music',
          duration: 0,
          audioUrl: `/api/stream?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
          genre: this.inputGenre() || 'Music',
          format: 'mp3',
          bitrate: '192 kbps',
          plays: 0,
          isFavorite: false,
          addedAt: new Date().toISOString().split('T')[0],
        };
        this.libraryService.addTrackToLibrary(track);
      } else {
        track = await this.libraryService.addStreamTrack(
          url,
          title || undefined,
          artist || undefined,
          this.inputGenre() || undefined,
          this.isLiveStreamCheckbox()
        );
      }

      this.showToast(`Трек "${track.title}" добавлен`);
      this.closeAddModal();
      this.inputUrl.set('');
      this.inputTitle.set('');
      this.inputArtist.set('');

      this.audioService.playTrack(track, this.libraryService.tracks());
      this.offlineService.saveTrackOffline(track);
    } catch {
      this.showToast('Ошибка при добавлении трека');
    } finally {
      this.isUrlValidating.set(false);
    }
  }

  addManualFromSearch() {
    const q = this.modalSearchInput().trim();
    if (!q) return;

    let title = q;
    let artist = 'Разные исполнители';
    if (q.includes(' - ')) {
      const parts = q.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }

    const track: Track = {
      id: 'manual-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title,
      artist,
      album: 'Recro Music',
      duration: 0,
      audioUrl: `/api/stream?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`,
      genre: 'Music',
      format: 'mp3',
      bitrate: '192 kbps',
      plays: 0,
      isFavorite: false,
      addedAt: new Date().toISOString().split('T')[0],
    };

    this.libraryService.addTrackToLibrary(track);
    this.audioService.playTrack(track, this.libraryService.tracks());
    this.offlineService.saveTrackOffline(track);
    this.showToast(`Трек "${track.title}" добавлен в медиатеку`);
    this.closeAddModal();
    this.modalSearchInput.set('');
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.prepareUpload(input.files[0]);
    }
  }

  onDragOver(e: DragEvent) {
    e.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.isDragging.set(false);
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.isDragging.set(false);
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      this.prepareUpload(e.dataTransfer.files[0]);
    }
  }

  private prepareUpload(file: File) {
    this.uploadFile.set(file);
    this.uploadFileName.set(file.name);
    const cleanName = file.name.replace(/\.[^/.]+$/, '');
    if (cleanName.includes(' - ')) {
      const parts = cleanName.split(' - ');
      this.uploadArtist.set(parts[0].trim());
      this.uploadTitle.set(parts.slice(1).join(' - ').trim());
    } else {
      this.uploadTitle.set(cleanName);
      this.uploadArtist.set('Локальный файл');
    }
  }

  async submitUpload() {
    const file = this.uploadFile();
    if (!file) return;

    const track = await this.libraryService.addUploadedFile(
      file,
      this.uploadTitle() || undefined,
      this.uploadArtist() || undefined,
      this.uploadGenre() || undefined
    );

    this.showToast(`Файл "${track.title}" добавлен`);
    this.closeAddModal();
    this.uploadFile.set(null);
    this.uploadFileName.set('');

    this.audioService.playTrack(track, this.libraryService.tracks());
  }

  exportLibrary() {
    if (!this.requireAuth('экспортировать медиатеку')) return;
    this.libraryService.exportLibrary();
    this.showToast('Медиатека экспортирована в файл');
  }

  onBackupFileSelected(event: Event) {
    if (!this.requireAuth('импортировать бэкап')) return;
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const res = this.libraryService.importLibrary(reader.result as string);
          this.showToast(
            `Импортировано: ${res.tracksCount} треков, ${res.playlistsCount} плейлистов, ${res.stationsCount} радио`
          );
        } catch {
          this.showToast('Ошибка импорта: некорректный файл бэкапа');
        }
      };
      reader.readAsText(file);
      input.value = '';
    }
  }
}
