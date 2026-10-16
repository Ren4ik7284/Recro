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

  // Cached DOM elements in PiP window for smooth updates without reflow
  private dom = {
    coverImg: null as HTMLImageElement | null,
    titleEl: null as HTMLElement | null,
    artistEl: null as HTMLElement | null,
    lineCurrentEl: null as HTMLElement | null,
    progressBar: null as HTMLElement | null,
    progressFill: null as HTMLElement | null,
    timeCurrentEl: null as HTMLElement | null,
    timeTotalEl: null as HTMLElement | null,
    btnPlayIcon: null as HTMLElement | null,
    btnLike: null as HTMLElement | null,
    btnDislike: null as HTMLElement | null,
    btnMute: null as HTMLElement | null,
    backdropEl: null as HTMLElement | null,
  };

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.closePip();
      });
    }

    // Reactive DOM sync for Document PiP
    effect(() => {
      if (!this.isPipActive() || !this.pipWindow) return;

      const track = this.audioService.currentTrack();
      const isPlaying = this.audioService.isPlaying();
      const currentTime = this.audioService.currentTime();
      const duration = this.audioService.duration() || 0;
      const lyrics = this.lyricsService.currentLyrics();
      const curLine = this.lyricsService.currentLyricLine();
      const isSynced = !!lyrics?.isSynced;
      const isFavorite = track ? this.libraryService.isTrackFavorite(track) : false;
      const isDisliked = track ? this.libraryService.isDisliked(track) : false;
      const isMuted = this.audioService.isMuted() || this.audioService.volume() === 0;

      this.updatePipDom(
        track,
        isPlaying,
        currentTime,
        duration,
        curLine?.text,
        isSynced,
        isFavorite,
        isDisliked,
        isMuted
      );
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

    // Fallback for browsers without Document PiP
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
      progressBar: null,
      progressFill: null,
      timeCurrentEl: null,
      timeTotalEl: null,
      btnPlayIcon: null,
      btnLike: null,
      btnDislike: null,
      btnMute: null,
      backdropEl: null,
    };
    this.isPipActive.set(false);
    this.isFloatingFallbackActive.set(false);
    this.lyricsService.setExternalTracking(false);
  }

  private async openDocumentPip() {
    const docPip = (window as any).documentPictureInPicture;
    if (!docPip) return;

    if (this.pipWindow) {
      try { this.pipWindow.close(); } catch {}
    }

    const pipWin = await docPip.requestWindow({
      width: 230,
      height: 380,
    });

    this.pipWindow = pipWin;
    this.isPipActive.set(true);
    this.lyricsService.setExternalTracking(true);

    pipWin.addEventListener('pagehide', () => {
      this.isPipActive.set(false);
      this.lyricsService.setExternalTracking(false);
      this.pipWindow = null;
    });

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
        padding: 10px 12px;
        background: rgba(12, 14, 22, 0.96);
        overflow: hidden;
        gap: 6px;
      }
      .pip-ambient-backdrop {
        position: absolute;
        inset: -20px;
        background-size: cover;
        background-position: center;
        filter: blur(40px) saturate(200%);
        opacity: 0.28;
        pointer-events: none;
        z-index: 0;
        transform: scale(1.1);
        transition: background-image 0.5s ease-out;
      }
      .pip-topbar {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .pip-brand {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 9.5px;
        font-weight: 700;
        letter-spacing: 0.8px;
        color: #94a3b8;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .pip-brand-dot {
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: #38bdf8;
        box-shadow: 0 0 6px #38bdf8;
      }
      .pip-top-actions {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .pip-top-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        padding: 3px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s, background-color 0.15s;
      }
      .pip-top-btn:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.1);
      }

      /* Square 1:1 Album Cover */
      .pip-cover-wrap {
        position: relative;
        z-index: 1;
        width: 100%;
        aspect-ratio: 1 / 1;
        border-radius: 10px;
        overflow: hidden;
        background: #141622;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.08);
        cursor: pointer;
        flex-shrink: 0;
      }
      .pip-cover {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .pip-meta {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .pip-title {
        font-size: 12px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.25;
      }
      .pip-artist {
        font-size: 10px;
        color: #94a3b8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.25;
      }

      /* Karaoke Live Lyrics Area */
      .pip-lyrics-box {
        position: relative;
        z-index: 1;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 6px;
        padding: 3px 6px;
        min-height: 22px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        cursor: pointer;
      }
      .pip-line-current {
        font-size: 10.5px;
        font-weight: 700;
        color: #38bdf8;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
      }
      .pip-line-placeholder {
        font-size: 9.5px;
        color: #64748b;
        font-weight: 500;
        text-shadow: none;
      }

      /* Controls & Progress */
      .pip-bottom {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pip-progress-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .pip-time {
        font-size: 9px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        color: #64748b;
        min-width: 22px;
      }
      .pip-time-total {
        text-align: right;
      }
      .pip-progress-track {
        flex: 1;
        height: 4px;
        background: rgba(255, 255, 255, 0.12);
        border-radius: 2px;
        cursor: pointer;
        position: relative;
        overflow: hidden;
      }
      .pip-progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #38bdf8, #818cf8);
        border-radius: 2px;
        pointer-events: none;
      }

      /* 6 Buttons in a single balanced row */
      .pip-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 0;
      }
      .pip-btn-play {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: #ffffff;
        color: #090a0f;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 0.12s, background-color 0.15s;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        flex-shrink: 0;
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
        border-radius: 4px;
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
      .pip-btn-ctrl.disliked {
        color: #ef4444;
      }
      .pip-btn-ctrl.liked {
        color: #f43f5e;
      }
      .pip-btn-ctrl.muted {
        color: #ef4444;
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

    // Top Bar
    const topbar = doc.createElement('div');
    topbar.className = 'pip-topbar';

    const brand = doc.createElement('div');
    brand.className = 'pip-brand';
    const dot = doc.createElement('span');
    dot.className = 'pip-brand-dot';
    const brandText = doc.createElement('span');
    brandText.textContent = 'RECRO MINI';
    brand.appendChild(dot);
    brand.appendChild(brandText);
    topbar.appendChild(brand);

    const topActions = doc.createElement('div');
    topActions.className = 'pip-top-actions';

    // Expand button
    const btnExpand = doc.createElement('button');
    btnExpand.type = 'button';
    btnExpand.className = 'pip-top-btn';
    btnExpand.title = this.i18n.t('player.pipExpand');
    btnExpand.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 3 21 3 21 9"/>
        <polyline points="9 21 3 21 3 15"/>
        <line x1="21" y1="3" x2="14" y2="10"/>
        <line x1="3" y1="21" x2="10" y2="14"/>
      </svg>
    `;
    btnExpand.addEventListener('click', () => {
      try {
        window.focus();
        this.lyricsService.openLyrics();
      } catch {}
    });
    topActions.appendChild(btnExpand);

    // Close button
    const btnClose = doc.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'pip-top-btn';
    btnClose.title = this.i18n.t('player.pipClose');
    btnClose.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
    btnClose.addEventListener('click', () => this.closePip());
    topActions.appendChild(btnClose);

    topbar.appendChild(topActions);
    wrapper.appendChild(topbar);

    // Square 1:1 Album Cover
    const coverWrap = doc.createElement('div');
    coverWrap.className = 'pip-cover-wrap';
    coverWrap.title = this.i18n.t('player.pipExpand');
    coverWrap.addEventListener('click', () => {
      try {
        window.focus();
        this.lyricsService.openLyrics();
      } catch {}
    });

    const cover = doc.createElement('img');
    cover.className = 'pip-cover';
    cover.alt = 'Cover';
    coverWrap.appendChild(cover);
    wrapper.appendChild(coverWrap);
    this.dom.coverImg = cover;

    // Track Meta
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
    wrapper.appendChild(meta);
    this.dom.titleEl = title;
    this.dom.artistEl = artist;

    // Compact Karaoke Box
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
    lineCurrent.className = 'pip-line-current pip-line-placeholder';
    lineCurrent.textContent = this.i18n.t('player.pipIntro');
    lyricsBox.appendChild(lineCurrent);
    wrapper.appendChild(lyricsBox);
    this.dom.lineCurrentEl = lineCurrent;

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

    // Playback Controls (6 buttons: Dislike, Prev, Play, Next, Like, Mute)
    const controls = doc.createElement('div');
    controls.className = 'pip-controls';

    // 1. Dislike
    const btnDislike = doc.createElement('button');
    btnDislike.type = 'button';
    btnDislike.className = 'pip-btn-ctrl';
    btnDislike.title = this.i18n.t('player.dislike');
    btnDislike.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
      </svg>
    `;
    btnDislike.addEventListener('click', () => {
      this.audioService.dislikeCurrentTrack();
    });
    controls.appendChild(btnDislike);
    this.dom.btnDislike = btnDislike;

    // 2. Prev
    const btnPrev = doc.createElement('button');
    btnPrev.type = 'button';
    btnPrev.className = 'pip-btn-ctrl';
    btnPrev.title = this.i18n.t('player.prev');
    btnPrev.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="19 20 9 12 19 4 19 20"></polygon>
        <line x1="5" y1="19" x2="5" y2="5"></line>
      </svg>
    `;
    btnPrev.addEventListener('click', () => this.audioService.prev());
    controls.appendChild(btnPrev);

    // 3. Play / Pause
    const btnPlay = doc.createElement('button');
    btnPlay.type = 'button';
    btnPlay.className = 'pip-btn-play';
    btnPlay.title = this.i18n.t('player.play');
    controls.appendChild(btnPlay);
    btnPlay.addEventListener('click', () => this.audioService.togglePlay());
    this.dom.btnPlayIcon = btnPlay;

    // 4. Next
    const btnNext = doc.createElement('button');
    btnNext.type = 'button';
    btnNext.className = 'pip-btn-ctrl';
    btnNext.title = this.i18n.t('player.next');
    btnNext.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polygon points="5 4 15 12 5 20 5 4"></polygon>
        <line x1="19" y1="5" x2="19" y2="19"></line>
      </svg>
    `;
    btnNext.addEventListener('click', () => this.audioService.next());
    controls.appendChild(btnNext);

    // 5. Like
    const btnLike = doc.createElement('button');
    btnLike.type = 'button';
    btnLike.className = 'pip-btn-ctrl';
    btnLike.title = this.i18n.t('player.like');
    btnLike.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
    controls.appendChild(btnLike);
    this.dom.btnLike = btnLike;

    // 6. Mute / Volume
    const btnMute = doc.createElement('button');
    btnMute.type = 'button';
    btnMute.className = 'pip-btn-ctrl';
    btnMute.title = this.i18n.t('player.muteShortcut');
    btnMute.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      </svg>
    `;
    btnMute.addEventListener('click', () => {
      this.audioService.toggleMute();
    });
    controls.appendChild(btnMute);
    this.dom.btnMute = btnMute;

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
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        this.audioService.toggleMute();
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
    isSynced?: boolean,
    isFavorite?: boolean,
    isDisliked?: boolean,
    isMuted?: boolean
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect width="4" height="16" x="6" y="4" rx="1"></rect>
            <rect width="4" height="16" x="14" y="4" rx="1"></rect>
          </svg>
        `;
      } else {
        this.dom.btnPlayIcon.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 3 20 12 6 21 6 3"></polygon>
          </svg>
        `;
      }
    }

    // Dislike status
    if (this.dom.btnDislike) {
      this.dom.btnDislike.classList.toggle('disliked', !!isDisliked);
    }

    // Like status
    if (this.dom.btnLike) {
      this.dom.btnLike.classList.toggle('liked', !!isFavorite);
      this.dom.btnLike.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
        </svg>
      `;
    }

    // Mute status
    if (this.dom.btnMute) {
      this.dom.btnMute.classList.toggle('muted', !!isMuted);
      if (isMuted) {
        this.dom.btnMute.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="22" y1="9" x2="16" y2="15"/>
            <line x1="16" y1="9" x2="22" y2="15"/>
          </svg>
        `;
      } else {
        this.dom.btnMute.innerHTML = `
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
        `;
      }
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

    // Lyrics
    if (this.dom.lineCurrentEl) {
      if (isSynced && curLineText) {
        this.dom.lineCurrentEl.textContent = curLineText;
        this.dom.lineCurrentEl.className = 'pip-line-current';
      } else {
        this.dom.lineCurrentEl.textContent = track ? track.title : this.i18n.t('player.pipInstrumental');
        this.dom.lineCurrentEl.className = 'pip-line-current pip-line-placeholder';
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
