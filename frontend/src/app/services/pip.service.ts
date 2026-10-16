import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { AudioService } from './audio.service';
import { LyricsService } from './lyrics.service';
import { LibraryService } from './library.service';
import { I18nService } from './i18n.service';
import { Track } from '../models/track.model';

@Injectable({
  providedIn: 'root',
})
export class PipService {
  private readonly audioService = inject(AudioService);
  private readonly lyricsService = inject(LyricsService);
  private readonly libraryService = inject(LibraryService);
  private readonly i18n = inject(I18nService);

  readonly isPipActive = signal<boolean>(false);
  readonly isFloatingFallbackActive = signal<boolean>(false);

  readonly isDocumentPipSupported = computed<boolean>(() => {
    return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  });

  private pipWindow: any = null;

  // Кэшированные DOM элементы в окне PiP для 60fps обновления без reflow
  private dom = {
    coverImg: null as HTMLImageElement | null,
    titleEl: null as HTMLElement | null,
    artistEl: null as HTMLElement | null,
    lineCurrentEl: null as HTMLElement | null,
    lineNextEl: null as HTMLElement | null,
    progressBar: null as HTMLElement | null,
    progressFill: null as HTMLElement | null,
    timeCurrentEl: null as HTMLElement | null,
    timeTotalEl: null as HTMLElement | null,
    btnPlayIcon: null as HTMLElement | null,
    btnLike: null as HTMLElement | null,
    backdropEl: null as HTMLElement | null,
  };

  constructor() {
    // Автоматическое закрытие PiP при выгрузке страницы
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.closePip();
      });
    }

    // Реактивное обновление состояния PiP окна (Document PiP)
    effect(() => {
      if (!this.isPipActive() || !this.pipWindow) return;

      const track = this.audioService.currentTrack();
      const isPlaying = this.audioService.isPlaying();
      const currentTime = this.audioService.currentTime();
      const duration = this.audioService.duration() || 0;
      const lyrics = this.lyricsService.currentLyrics();
      const curLine = this.lyricsService.currentLyricLine();
      const nextLine = this.lyricsService.nextLyricLine();
      const isSynced = !!lyrics?.isSynced;
      const isFavorite = track ? this.libraryService.isTrackFavorite(track) : false;

      this.updatePipDom(track, isPlaying, currentTime, duration, curLine?.text, nextLine?.text, isSynced, isFavorite);
    });
  }

  async togglePip() {
    if (this.isPipActive() || this.isFloatingFallbackActive()) {
      this.closePip();
    } else {
      await this.openPip();
    }
  }

  async openPip() {
    if (typeof window === 'undefined') return;

    if (this.isDocumentPipSupported()) {
      try {
        await this.openDocumentPip();
        return;
      } catch (err) {
        console.warn('[PipService] Document PiP failed, falling back to in-app floating player:', err);
      }
    }

    // Fallback для браузеров без Document PiP (например, Firefox):
    this.isFloatingFallbackActive.set(true);
    this.lyricsService.setExternalTracking(true);
  }

  closePip() {
    if (this.pipWindow) {
      try {
        this.pipWindow.close();
      } catch {}
      this.pipWindow = null;
    }
    this.dom = {
      coverImg: null,
      titleEl: null,
      artistEl: null,
      lineCurrentEl: null,
      lineNextEl: null,
      progressBar: null,
      progressFill: null,
      timeCurrentEl: null,
      timeTotalEl: null,
      btnPlayIcon: null,
      btnLike: null,
      backdropEl: null,
    };
    this.isPipActive.set(false);
    this.isFloatingFallbackActive.set(false);
    this.lyricsService.setExternalTracking(false);
  }

  private async openDocumentPip() {
    const docPip = (window as any).documentPictureInPicture;
    if (!docPip) return;

    // Закрываем предыдущее окно, если было открыто
    if (this.pipWindow) {
      try { this.pipWindow.close(); } catch {}
    }

    const pipWin = await docPip.requestWindow({
      width: 400,
      height: 200,
    });

    this.pipWindow = pipWin;
    this.isPipActive.set(true);
    this.lyricsService.setExternalTracking(true);

    pipWin.addEventListener('pagehide', () => {
      this.isPipActive.set(false);
      this.lyricsService.setExternalTracking(false);
      this.pipWindow = null;
    });

    // Настраиваем документ окна
    const doc = pipWin.document;
    doc.title = 'Recro Mini Player';

    this.injectStyles(doc);
    this.buildMarkup(doc, pipWin);
  }

  private injectStyles(doc: Document) {
    const style = doc.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
        user-select: none;
      }
      body {
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: #090a0f;
        color: #f8fafc;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        height: 100vh;
        width: 100vw;
        display: flex;
        flex-direction: column;
      }
      .pip-wrapper {
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        width: 100%;
        height: 100%;
        padding: 10px 14px;
        background: rgba(12, 14, 22, 0.94);
        overflow: hidden;
      }
      .pip-ambient-backdrop {
        position: absolute;
        inset: -20px;
        background-size: cover;
        background-position: center;
        filter: blur(35px) saturate(180%);
        opacity: 0.28;
        pointer-events: none;
        z-index: 0;
        transform: scale(1.1);
        transition: background-image 0.5s ease-out;
      }
      .pip-header {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .pip-cover {
        width: 36px;
        height: 36px;
        border-radius: 8px;
        object-fit: cover;
        flex-shrink: 0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        background: #1e2230;
      }
      .pip-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      .pip-title {
        font-size: 13px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.25;
      }
      .pip-artist {
        font-size: 11px;
        color: #94a3b8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.25;
        margin-top: 1px;
      }
      .pip-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .pip-icon-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        padding: 5px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background-color 0.15s, transform 0.1s;
      }
      .pip-icon-btn:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.1);
      }
      .pip-icon-btn:active {
        transform: scale(0.92);
      }
      .pip-icon-btn.liked {
        color: #f43f5e;
      }

      /* Karaoke Live Lyrics Area */
      .pip-lyrics-box {
        position: relative;
        z-index: 1;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 9px;
        padding: 6px 10px;
        margin: 6px 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        text-align: center;
        min-height: 48px;
        cursor: pointer;
        transition: background-color 0.2s, border-color 0.2s;
      }
      .pip-lyrics-box:hover {
        background: rgba(255, 255, 255, 0.09);
        border-color: rgba(255, 255, 255, 0.16);
      }
      .pip-line-current {
        font-size: 13.5px;
        font-weight: 700;
        color: #38bdf8;
        line-height: 1.25;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-shadow: 0 0 16px rgba(56, 189, 248, 0.4);
        transition: color 0.2s;
      }
      .pip-line-next {
        font-size: 10.5px;
        color: #64748b;
        line-height: 1.2;
        margin-top: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 90%;
      }
      .pip-line-placeholder {
        font-size: 12px;
        color: #94a3b8;
        font-style: italic;
      }

      /* Controls & Progress */
      .pip-bottom {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .pip-progress-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pip-time {
        font-size: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: #64748b;
        min-width: 28px;
      }
      .pip-time-total {
        text-align: right;
      }
      .pip-progress-track {
        flex: 1;
        height: 5px;
        background: rgba(255, 255, 255, 0.12);
        border-radius: 3px;
        cursor: pointer;
        position: relative;
        overflow: hidden;
      }
      .pip-progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #38bdf8, #818cf8);
        border-radius: 3px;
        pointer-events: none;
      }

      .pip-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 16px;
      }
      .pip-btn-play {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #ffffff;
        color: #090a0f;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 0.12s, background-color 0.15s;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      }
      .pip-btn-play:hover {
        transform: scale(1.08);
        background: #e2e8f0;
      }
      .pip-btn-play:active {
        transform: scale(0.95);
      }
      .pip-btn-ctrl {
        background: transparent;
        border: none;
        color: #cbd5e1;
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, transform 0.1s;
      }
      .pip-btn-ctrl:hover {
        color: #ffffff;
      }
      .pip-btn-ctrl:active {
        transform: scale(0.9);
      }
    `;
    doc.head.appendChild(style);
  }

  private buildMarkup(doc: Document, pipWin: Window) {
    const wrapper = doc.createElement('div');
    wrapper.className = 'pip-wrapper';

    // Ambient Backdrop
    const backdrop = doc.createElement('div');
    backdrop.className = 'pip-ambient-backdrop';
    wrapper.appendChild(backdrop);
    this.dom.backdropEl = backdrop;

    // Header
    const header = doc.createElement('div');
    header.className = 'pip-header';

    const cover = doc.createElement('img');
    cover.className = 'pip-cover';
    cover.alt = 'Cover';
    header.appendChild(cover);
    this.dom.coverImg = cover;

    const meta = doc.createElement('div');
    meta.className = 'pip-meta';
    const title = doc.createElement('div');
    title.className = 'pip-title';
    title.textContent = 'Recro Music';
    const artist = doc.createElement('div');
    artist.className = 'pip-artist';
    artist.textContent = 'Player';
    meta.appendChild(title);
    meta.appendChild(artist);
    header.appendChild(meta);
    this.dom.titleEl = title;
    this.dom.artistEl = artist;

    const actions = doc.createElement('div');
    actions.className = 'pip-header-actions';

    // Like Button
    const btnLike = doc.createElement('button');
    btnLike.type = 'button';
    btnLike.className = 'pip-icon-btn';
    btnLike.title = this.i18n.t('player.like');
    btnLike.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
      </svg>
    `;
    btnLike.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = this.audioService.currentTrack();
      if (cur) {
        const isNowFav = this.libraryService.toggleFavorite(cur.id, cur);
        this.audioService.updateTrackFavoriteStatus(cur.id, isNowFav, cur);
      }
    });
    actions.appendChild(btnLike);
    this.dom.btnLike = btnLike;

    // Expand to main lyrics button
    const btnExpand = doc.createElement('button');
    btnExpand.type = 'button';
    btnExpand.className = 'pip-icon-btn';
    btnExpand.title = this.i18n.t('player.pipExpand');
    btnExpand.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 3h6v6"></path>
        <path d="M10 14L21 3"></path>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      </svg>
    `;
    btnExpand.addEventListener('click', () => {
      try {
        window.focus();
        this.lyricsService.openLyrics();
      } catch {}
    });
    actions.appendChild(btnExpand);

    header.appendChild(actions);
    wrapper.appendChild(header);

    // Karaoke Box
    const lyricsBox = doc.createElement('div');
    lyricsBox.className = 'pip-lyrics-box';
    lyricsBox.title = this.i18n.t('player.pipExpand');
    lyricsBox.addEventListener('click', () => {
      try {
        window.focus();
        this.lyricsService.openLyrics();
      } catch {}
    });

    const lineCurrent = doc.createElement('div');
    lineCurrent.className = 'pip-line-current';
    lineCurrent.textContent = this.i18n.t('player.pipIntro');

    const lineNext = doc.createElement('div');
    lineNext.className = 'pip-line-next';

    lyricsBox.appendChild(lineCurrent);
    lyricsBox.appendChild(lineNext);
    wrapper.appendChild(lyricsBox);

    this.dom.lineCurrentEl = lineCurrent;
    this.dom.lineNextEl = lineNext;

    // Bottom Controls & Scrubber
    const bottom = doc.createElement('div');
    bottom.className = 'pip-bottom';

    const progRow = doc.createElement('div');
    progRow.className = 'pip-progress-row';

    const timeCurrent = doc.createElement('span');
    timeCurrent.className = 'pip-time';
    timeCurrent.textContent = '0:00';
    progRow.appendChild(timeCurrent);
    this.dom.timeCurrentEl = timeCurrent;

    const progTrack = doc.createElement('div');
    progTrack.className = 'pip-progress-track';
    const progFill = doc.createElement('div');
    progFill.className = 'pip-progress-fill';
    progTrack.appendChild(progFill);

    progTrack.addEventListener('click', (e) => {
      const rect = progTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const dur = this.audioService.duration();
      if (dur && dur > 0) {
        this.audioService.seek(pct * dur);
      }
    });

    progRow.appendChild(progTrack);
    this.dom.progressBar = progTrack;
    this.dom.progressFill = progFill;

    const timeTotal = doc.createElement('span');
    timeTotal.className = 'pip-time pip-time-total';
    timeTotal.textContent = '0:00';
    progRow.appendChild(timeTotal);
    this.dom.timeTotalEl = timeTotal;

    bottom.appendChild(progRow);

    // Playback buttons
    const controls = doc.createElement('div');
    controls.className = 'pip-controls';

    // Prev
    const btnPrev = doc.createElement('button');
    btnPrev.type = 'button';
    btnPrev.className = 'pip-btn-ctrl';
    btnPrev.title = this.i18n.t('player.prev');
    btnPrev.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="19 20 9 12 19 4 19 20"></polygon>
        <line x1="5" y1="19" x2="5" y2="5"></line>
      </svg>
    `;
    btnPrev.addEventListener('click', () => this.audioService.prev());
    controls.appendChild(btnPrev);

    // Play / Pause
    const btnPlay = doc.createElement('button');
    btnPlay.type = 'button';
    btnPlay.className = 'pip-btn-play';
    btnPlay.title = this.i18n.t('player.play');
    controls.appendChild(btnPlay);
    btnPlay.addEventListener('click', () => this.audioService.togglePlay());
    this.dom.btnPlayIcon = btnPlay;

    // Next
    const btnNext = doc.createElement('button');
    btnNext.type = 'button';
    btnNext.className = 'pip-btn-ctrl';
    btnNext.title = this.i18n.t('player.next');
    btnNext.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 4 15 12 5 20 5 4"></polygon>
        <line x1="19" y1="5" x2="19" y2="19"></line>
      </svg>
    `;
    btnNext.addEventListener('click', () => this.audioService.next());
    controls.appendChild(btnNext);

    bottom.appendChild(controls);
    wrapper.appendChild(bottom);

    // Global Keydown listeners inside PiP
    pipWin.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.audioService.togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        this.audioService.seek(Math.max(0, this.audioService.currentTime() - 5));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const dur = this.audioService.duration() || 0;
        this.audioService.seek(Math.min(dur, this.audioService.currentTime() + 5));
      } else if (e.code === 'Escape') {
        this.closePip();
      }
    });

    doc.body.appendChild(wrapper);
  }

  private updatePipDom(
    track: Track | null,
    isPlaying: boolean,
    currentTime: number,
    duration: number,
    curLineText?: string,
    nextLineText?: string,
    isSynced?: boolean,
    isFavorite?: boolean
  ) {
    if (!this.pipWindow) return;

    // Cover & Meta
    if (track) {
      const coverUrl = (this.libraryService.formatCoverUrl(track.coverUrl, track.title, track.artist) || track.coverUrl) || '';
      if (this.dom.coverImg && coverUrl && this.dom.coverImg.src !== coverUrl) {
        this.dom.coverImg.src = coverUrl;
        this.dom.coverImg.onerror = () => {
          if (this.dom.coverImg) {
            this.dom.coverImg.src = this.libraryService.getFallbackCoverUrl(track.title, track.artist);
          }
        };
      }
      if (this.dom.backdropEl && coverUrl) {
        this.dom.backdropEl.style.backgroundImage = `url('${coverUrl}')`;
      }
      if (this.dom.titleEl) this.dom.titleEl.textContent = track.title;
      if (this.dom.artistEl) this.dom.artistEl.textContent = track.artist || 'Unknown Artist';
    } else {
      if (this.dom.titleEl) this.dom.titleEl.textContent = this.i18n.t('player.noTrack');
      if (this.dom.artistEl) this.dom.artistEl.textContent = this.i18n.t('player.startListening');
    }

    // Play/Pause icon
    if (this.dom.btnPlayIcon) {
      if (isPlaying) {
        this.dom.btnPlayIcon.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <rect width="4" height="16" x="6" y="4" rx="1"></rect>
            <rect width="4" height="16" x="14" y="4" rx="1"></rect>
          </svg>
        `;
      } else {
        this.dom.btnPlayIcon.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 3 20 12 6 21 6 3"></polygon>
          </svg>
        `;
      }
    }

    // Like status
    if (this.dom.btnLike) {
      this.dom.btnLike.classList.toggle('liked', !!isFavorite);
    }

    // Progress
    const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
    if (this.dom.progressFill) {
      this.dom.progressFill.style.width = `${pct}%`;
    }
    if (this.dom.timeCurrentEl) {
      this.dom.timeCurrentEl.textContent = this.formatTime(currentTime);
    }
    if (this.dom.timeTotalEl) {
      this.dom.timeTotalEl.textContent = this.formatTime(duration);
    }

    // Lyrics Lines
    if (this.dom.lineCurrentEl && this.dom.lineNextEl) {
      if (isSynced) {
        if (curLineText) {
          this.dom.lineCurrentEl.textContent = curLineText;
          this.dom.lineCurrentEl.className = 'pip-line-current';
          this.dom.lineNextEl.textContent = nextLineText || '';
          this.dom.lineNextEl.style.display = nextLineText ? 'block' : 'none';
        } else {
          // Вокал ещё не начался (вступление)
          this.dom.lineCurrentEl.textContent = this.i18n.t('player.pipIntro');
          this.dom.lineCurrentEl.className = 'pip-line-current pip-line-placeholder';
          this.dom.lineNextEl.textContent = nextLineText || '';
          this.dom.lineNextEl.style.display = nextLineText ? 'block' : 'none';
        }
      } else {
        // Нет синхронизированного текста
        this.dom.lineCurrentEl.textContent = track ? track.title : this.i18n.t('player.pipInstrumental');
        this.dom.lineCurrentEl.className = 'pip-line-current pip-line-placeholder';
        this.dom.lineNextEl.textContent = track ? (track.artist || '') : '';
        this.dom.lineNextEl.style.display = track?.artist ? 'block' : 'none';
      }
    }
  }

  private formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
