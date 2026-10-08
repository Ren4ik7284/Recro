import { Injectable, signal } from '@angular/core';

export type AppTab = 'all' | 'favorites' | 'uploads' | 'streams' | 'playlist' | 'offline' | 'profile';
export type AppOverlay =
  | 'lyrics'
  | 'visualizer'
  | 'player'
  | 'queue'
  | 'add'
  | 'playlists'
  | 'playlist-new'
  | 'playlist-add'
  | 'history'
  | 'mix-settings'
  | 'auth'
  | 'wrapped'
  | 'pwa'
  | 'timer'
  | 'timer-finish'
  | 'profile';

export interface RouteState {
  tab: AppTab;
  playlistId?: string | null;
  overlay?: AppOverlay | null;
}

const KNOWN_OVERLAYS = new Set<string>([
  'lyrics', 'visualizer', 'player', 'queue', 'add', 'playlists',
  'playlist-new', 'playlist-add', 'history', 'mix-settings', 'auth', 'wrapped', 'pwa',
  'timer', 'timer-finish', 'profile',
]);
const KNOWN_TABS = new Set<string>(['all', 'favorites', 'uploads', 'streams', 'playlist', 'offline', 'profile']);

@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  readonly currentTab = signal<AppTab>('all');
  readonly currentPlaylistId = signal<string | null>(null);
  readonly currentOverlay = signal<AppOverlay | null>(null);

  private isNavigatingInternally = false;
  private onStateChangeCallback?: (state: RouteState) => void;
  private appHistoryDepth = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', () => this.handleLocationChange());
      window.addEventListener('hashchange', () => this.handleLocationChange());
    }
  }

  init(onStateChange: (state: RouteState) => void) {
    this.onStateChangeCallback = onStateChange;
    if (typeof window !== 'undefined') {
      const parsed = this.parseHash(window.location.hash);
      const state = window.history.state;
      if (state && typeof state.depth === 'number') {
        this.appHistoryDepth = state.depth;
      } else {
        this.appHistoryDepth = 0;
        const initialHash = window.location.hash || this.buildHash(parsed.tab, parsed.playlistId, parsed.overlay);
        window.history.replaceState(
          { signalApp: true, depth: 0, tab: parsed.tab, playlistId: parsed.playlistId, overlay: parsed.overlay },
          '',
          initialHash
        );
      }
      this.handleLocationChange(true);
    }
  }

  parseHash(hash: string): RouteState {
    const clean = hash.replace(/^#\/?/, '').trim();
    if (!clean) return { tab: 'all', overlay: null };

    const parts = clean.split('/').filter(Boolean);

    // Прямой оверлей без префикса вкладки (например #/lyrics)
    if (KNOWN_OVERLAYS.has(parts[0])) {
      return { tab: this.currentTab() || 'all', overlay: parts[0] as AppOverlay };
    }

    // Вкладка плейлиста: #/playlist/:id или #/playlist/:id/lyrics
    if (parts[0] === 'playlist') {
      const plId = parts[1] || null;
      const overlay = parts[2] && KNOWN_OVERLAYS.has(parts[2]) ? (parts[2] as AppOverlay) : null;
      return { tab: 'playlist', playlistId: plId, overlay };
    }

    // Обычная вкладка: #/favorites или #/favorites/lyrics
    if (KNOWN_TABS.has(parts[0])) {
      const overlay = parts[1] && KNOWN_OVERLAYS.has(parts[1]) ? (parts[1] as AppOverlay) : null;
      return { tab: parts[0] as AppTab, overlay };
    }

    return { tab: 'all', overlay: null };
  }

  buildHash(tab: AppTab, playlistId?: string | null, overlay?: AppOverlay | null): string {
    let path = tab === 'all' && !overlay && !playlistId ? '' : `/${tab}`;
    if (tab === 'playlist' && playlistId) {
      path = `/playlist/${playlistId}`;
    }
    if (overlay) {
      path = `${path || ''}/${overlay}`;
    }
    return '#' + (path.startsWith('/') ? path : '/' + path);
  }

  setTab(tab: AppTab, playlistId?: string | null, pushState = true) {
    let currentOverlay = this.currentOverlay();
    if (currentOverlay === 'playlists') {
      currentOverlay = null;
      this.currentOverlay.set(null);
    }
    const newHash = this.buildHash(tab, playlistId, currentOverlay);

    this.currentTab.set(tab);
    this.currentPlaylistId.set(playlistId || null);

    if (pushState && typeof window !== 'undefined') {
      this.isNavigatingInternally = true;
      if (window.location.hash !== newHash) {
        this.appHistoryDepth++;
        window.history.pushState(
          { signalApp: true, depth: this.appHistoryDepth, tab, playlistId, overlay: currentOverlay },
          '',
          newHash
        );
      }
      setTimeout(() => (this.isNavigatingInternally = false), 50);
    }
  }

  pushOverlay(overlay: AppOverlay) {
    if (this.currentOverlay() === overlay) return;
    this.currentOverlay.set(overlay);

    if (typeof window !== 'undefined') {
      const newHash = this.buildHash(this.currentTab(), this.currentPlaylistId(), overlay);
      this.isNavigatingInternally = true;
      this.appHistoryDepth++;
      window.history.pushState(
        { signalApp: true, depth: this.appHistoryDepth, tab: this.currentTab(), playlistId: this.currentPlaylistId(), overlay },
        '',
        newHash
      );
      setTimeout(() => (this.isNavigatingInternally = false), 50);
    }
  }

  closeOverlay(overlay?: AppOverlay) {
    const active = this.currentOverlay();
    if (!active || (overlay && active !== overlay)) return;

    if (typeof window !== 'undefined') {
      const currentHash = window.location.hash;
      if (currentHash.includes(active) && this.appHistoryDepth > 0) {
        window.history.back();
        return;
      }
    }

    this.currentOverlay.set(null);
    if (typeof window !== 'undefined') {
      const newHash = this.buildHash(this.currentTab(), this.currentPlaylistId(), null);
      window.history.replaceState(
        { signalApp: true, depth: this.appHistoryDepth, tab: this.currentTab(), playlistId: this.currentPlaylistId(), overlay: null },
        '',
        newHash
      );
    }
  }

  private handleLocationChange(isInitial = false) {
    if (this.isNavigatingInternally || typeof window === 'undefined') return;

    const state = window.history.state;
    if (state && typeof state.depth === 'number') {
      this.appHistoryDepth = state.depth;
    }

    const parsed = this.parseHash(window.location.hash);
    this.currentTab.set(parsed.tab);
    this.currentPlaylistId.set(parsed.playlistId || null);
    this.currentOverlay.set(parsed.overlay || null);

    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(parsed);
    }
  }
}
