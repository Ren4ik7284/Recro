import { Injectable, signal, computed, inject, effect, OnDestroy } from '@angular/core';
import { Track, Playlist, RadioStation, MixConfig, DEFAULT_MIX_CONFIG, ChartArtist, ChartSummary, ChartDetail, ReleaseItem, HomeExploreData } from '../models/track.model';
import { OfflineService } from './offline.service';
import { AuthService, HistoryItem, WrappedStats } from './auth.service';
import { CLUSTER_BACKENDS, resolveDefaultBackend, getClusterCandidates } from '../models/cluster.config';

export interface ExtractedResult {
  playlistTitle: string | null;
  tracks: Track[];
  mainVideo?: Track | null;
  isRadioMix?: boolean;
  hasChapters?: boolean;
}

export const BUILTIN_DISLIKED_ARTISTS: string[] = [
  'pharaoh',
  'фараон',
  'og buda',
  'оуджи буда',
  'оуджибуда',
  'big baby tape',
  'биг бейби тейп',
  'бигбейби тейп',
  'kizaru',
  'кизару',
  'серега пират',
  'серёга пират',
  'serega pirat',
  'kostromin',
  'костромин',
];

@Injectable({
  providedIn: 'root',
})
export class LibraryService implements OnDestroy {
  private get defaultBackendUrl(): string {
    return resolveDefaultBackend();
  }

  private activeBackendUrl = '';

  readonly offlineService = inject(OfflineService);
  readonly authService = inject(AuthService);

  // --- Ключи localStorage изолированы по user_id ---
  // Гость использует 'guest', авторизованный — свой UUID.
  // Это гарантирует что два пользователя на одном браузере видят только своё.
  private get storageUserId(): string {
    return this.authService.currentUser()?.id || 'guest';
  }

  private get STORAGE_KEY_TRACKS(): string {
    return `signal_tracks_${this.storageUserId}`;
  }
  private get STORAGE_KEY_FAVORITES(): string {
    return `signal_favs_${this.storageUserId}`;
  }
  private get STORAGE_KEY_PLAYLISTS(): string {
    return `signal_playlists_${this.storageUserId}`;
  }
  private get STORAGE_KEY_STATIONS(): string {
    return `signal_stations_${this.storageUserId}`;
  }
  private get STORAGE_KEY_UPDATED_AT(): string {
    return `signal_updated_at_${this.storageUserId}`;
  }
  private get STORAGE_KEY_MIX_CONFIG(): string {
    return `signal_mix_config_${this.storageUserId}`;
  }
  private get STORAGE_KEY_DISLIKES(): string {
    return `signal_dislikes_${this.storageUserId}`;
  }

  getStorageUserId(): string {
    return this.storageUserId;
  }

  readonly mixConfig = signal<MixConfig>(this.loadInitialMixConfig());
  readonly dislikedTrackIds = signal<Set<string>>(this.loadInitialDislikes());

  private loadInitialMixConfig(): MixConfig {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_MIX_CONFIG };
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_MIX_CONFIG);
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_MIX_CONFIG, ...parsed };
      }
    } catch {}
    return { ...DEFAULT_MIX_CONFIG };
  }

  private loadInitialDislikes(): Set<string> {
    const defaults = ['artist:pharaoh', 'artist:og buda', 'artist:big baby tape', 'artist:kizaru'];
    if (typeof localStorage === 'undefined') return new Set(defaults);
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_DISLIKES);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(
            (k) => typeof k === 'string' && !k.toLowerCase().includes('cupsize') && !k.toLowerCase().includes('капсайз')
          );
          return new Set([...defaults, ...filtered]);
        }
      }
    } catch {}
    return new Set(defaults);
  }

  setMixConfig(newConfig: Partial<MixConfig>) {
    const updated = { ...this.mixConfig(), ...newConfig };
    this.mixConfig.set(updated);
    try {
      localStorage.setItem(this.STORAGE_KEY_MIX_CONFIG, JSON.stringify(updated));
    } catch {}
    this.markUpdated();
  }

  isArtistDisliked(artist?: string): boolean {
    if (!artist) return false;
    const lower = artist.toLowerCase().trim();
    for (const b of BUILTIN_DISLIKED_ARTISTS) {
      if (lower.includes(b)) return true;
    }
    const dislikes = this.dislikedTrackIds();
    for (const entry of dislikes) {
      if (entry.startsWith('artist:')) {
        const art = entry.substring(7).trim().toLowerCase();
        if (art && (lower.includes(art) || art.includes(lower))) {
          return true;
        }
      }
    }
    return false;
  }

  dislikeArtist(artist: string) {
    if (!artist) return;
    const key = `artist:${artist.trim().toLowerCase()}`;
    this.dislikedTrackIds.update((set) => {
      const next = new Set(set);
      next.add(key);
      return next;
    });
    try {
      localStorage.setItem(this.STORAGE_KEY_DISLIKES, JSON.stringify(Array.from(this.dislikedTrackIds())));
    } catch {}
    this.markUpdated();
  }

  dislikeTrack(trackOrId: string | Track) {
    let trackId = typeof trackOrId === 'string' ? trackOrId : trackOrId.id;
    let trackObj = typeof trackOrId === 'object' ? trackOrId : this.tracks().find((t) => t.id === trackId);

    this.dislikedTrackIds.update((set) => {
      const next = new Set(set);
      next.add(trackId);
      if (trackObj && trackObj.artist) {
        if (trackObj.title) {
          const key = `${trackObj.artist.trim().toLowerCase()}::${trackObj.title.trim().toLowerCase()}`;
          next.add(key);
        }
        // Blacklist artist so they never play in recommendation mixes
        const artKey = `artist:${trackObj.artist.trim().toLowerCase()}`;
        next.add(artKey);
      }
      return next;
    });

    try {
      localStorage.setItem(this.STORAGE_KEY_DISLIKES, JSON.stringify(Array.from(this.dislikedTrackIds())));
    } catch {}

    const tr = this.tracks().find((t) => t.id === trackId);
    if (tr && tr.isFavorite) {
      this.toggleFavorite(trackId, tr);
    } else {
      this.markUpdated();
    }
  }

  isDisliked(trackOrId: string | Track): boolean {
    const dislikes = this.dislikedTrackIds();
    if (typeof trackOrId === 'string') {
      if (dislikes.has(trackOrId)) return true;
      const track = this.tracks().find((t) => t.id === trackOrId);
      if (track && track.artist && this.isArtistDisliked(track.artist)) return true;
      return false;
    }
    if (dislikes.has(trackOrId.id)) return true;
    if (trackOrId.artist) {
      if (this.isArtistDisliked(trackOrId.artist)) return true;
      if (trackOrId.title) {
        const key = `${trackOrId.artist.trim().toLowerCase()}::${trackOrId.title.trim().toLowerCase()}`;
        if (dislikes.has(key)) return true;
      }
    }
    return false;
  }

  readonly defaultTracks: Track[] = [];

  readonly defaultRadioStations: RadioStation[] = [
    { id: 'default-1', name: 'Radio Record', streamUrl: 'https://radiorecord.hostingradio.ru/rr_main96.aacp', genre: 'Dance / EDM', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-2', name: 'Europa Plus Top 40', streamUrl: 'https://hls-01-regions.emgsound.ru/11_top40/playlist.m3u8', genre: 'Pop / Top 40', country: 'RU', bitrate: '256k MP3' },
    { id: 'default-3', name: 'Europa Plus Live', streamUrl: 'https://hls-01-regions.emgsound.ru/11_msk/playlist.m3u8', genre: 'Pop / Hits', country: 'RU', bitrate: '128k MP3' },
    { id: 'default-4', name: 'Record Chill-Out', streamUrl: 'https://radiorecord.hostingradio.ru/chil96.aacp', genre: 'Chillout / Lounge', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-5', name: 'Record Deep', streamUrl: 'https://radiorecord.hostingradio.ru/deep96.aacp', genre: 'Deep House', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-6', name: 'DFM', streamUrl: 'https://dfm.hostingradio.ru/dfm96.aacp', genre: 'Club / Dance', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-7', name: 'Record Synthwave', streamUrl: 'https://radiorecord.hostingradio.ru/synth96.aacp', genre: 'Synthwave / Retro', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-8', name: 'Record Lo-Fi', streamUrl: 'https://radiorecord.hostingradio.ru/lofi96.aacp', genre: 'Lo-Fi / Beats', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-9', name: 'SomaFM: Groove Salad', streamUrl: 'https://ice4.somafm.com/groovesalad-128-mp3', genre: 'Ambient / Downtempo', country: 'US', bitrate: '128k Live' },
    { id: 'default-10', name: 'Record Russian Hits', streamUrl: 'https://radiorecord.hostingradio.ru/rus96.aacp', genre: 'Pop / Russian', country: 'RU', bitrate: '96k AAC' },
    { id: 'default-11', name: 'Радио Дача', streamUrl: 'https://stream.n340.com/14_dacha_64', genre: 'Pop / Retro / Hits', country: 'RU', bitrate: '64k AAC' },
  ];

  readonly tracks = signal<Track[]>([]);
  readonly playlists = signal<Playlist[]>([]);
  readonly radioStations = signal<RadioStation[]>([]);
  readonly searchQuery = signal<string>('');
  readonly selectedGenre = signal<string>('all');
  readonly selectedView = signal<'all' | 'favorites' | 'uploads' | 'streams' | 'playlist' | 'offline' | 'profile' | 'search' | 'charts' | 'library'>('all');
  readonly activePlaylistId = signal<string | null>(null);

  readonly onlineSearchResults = signal<Track[]>([]);
  readonly isSearchingOnline = signal<boolean>(false);
  readonly isBackendOnline = signal<boolean>(false);

  readonly availableGenres = computed(() => {
    const all = this.tracks().map((t) => t.genre).filter(Boolean);
    return ['all', ...Array.from(new Set(all))];
  });

  readonly offlineTracksCount = computed(() => {
    return this.tracks().filter((t) => this.offlineService.isTrackOffline(t.id)).length;
  });

  readonly allTracksCount = computed(() => {
    return this.tracks().filter((t) => !t.playlistOnly).length;
  });

  readonly filteredTracks = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const genre = this.selectedGenre();
    const view = this.selectedView();
    const playlistId = this.activePlaylistId();

    if (view === 'playlist' && playlistId) {
      const pl = this.playlists().find((p) => p.id === playlistId);
      if (!pl) return [];
      const trackMap = new Map(this.tracks().map((t) => [t.id, t]));
      const orderedTracks = pl.trackIds
        .map((id) => trackMap.get(id))
        .filter((t): t is Track => !!t);

      return orderedTracks.filter((track) => {
        if (genre !== 'all' && track.genre.toLowerCase() !== genre.toLowerCase()) {
          return false;
        }
        if (query) {
          const matchTitle = track.title.toLowerCase().includes(query);
          const matchArtist = track.artist.toLowerCase().includes(query);
          const matchAlbum = track.album?.toLowerCase().includes(query) ?? false;
          const matchGenre = track.genre.toLowerCase().includes(query);
          const matchUrl = track.audioUrl.toLowerCase().includes(query);
          if (!matchTitle && !matchArtist && !matchAlbum && !matchGenre && !matchUrl) {
            return false;
          }
        }
        return true;
      });
    }

    return this.tracks().filter((track) => {
      if ((view === 'all' || view === 'library') && track.playlistOnly) return false;
      if (view === 'favorites' && !track.isFavorite) return false;
      if (view === 'uploads' && !track.isLocalUpload) return false;
      if (view === 'streams' && !track.isLiveStream && track.format !== 'stream') return false;
      if (view === 'offline' && !this.offlineService.isTrackOffline(track.id)) return false;

      if (genre !== 'all' && track.genre.toLowerCase() !== genre.toLowerCase()) {
        return false;
      }

      if (query) {
        const matchTitle = track.title.toLowerCase().includes(query);
        const matchArtist = track.artist.toLowerCase().includes(query);
        const matchAlbum = track.album?.toLowerCase().includes(query) ?? false;
        const matchGenre = track.genre.toLowerCase().includes(query);
        const matchUrl = track.audioUrl.toLowerCase().includes(query);
        if (!matchTitle && !matchArtist && !matchAlbum && !matchGenre && !matchUrl) {
          return false;
        }
      }

      return true;
    });
  });

  readonly isCloudSynced = signal<boolean>(false);
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncPollInterval: ReturnType<typeof setInterval> | null = null;
  private visibilityHandler: (() => void) | null = null;
  private focusHandler: (() => void) | null = null;
  private eventSource: EventSource | null = null;
  private sseReconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.initLibrary();
    if (typeof window !== 'undefined') {
      setTimeout(() => {
        this.checkBackendHealth().then(() => {
          this.syncWithBackendOnStartup();
          this.startAutoSync();
        });
      }, 50);

      window.addEventListener('online', () => {
        this.checkBackendHealth();
      });
    } else {
      this.checkBackendHealth().then(() => {
        this.syncWithBackendOnStartup();
        this.startAutoSync();
      });
    }

    effect(() => {
      const isAuth = this.authService.isAuthenticated();
      if (isAuth) {
        this.connectRealtimeSync();
      } else {
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
      }
    });
  }

  ngOnDestroy(): void {
    if (this.syncPollInterval) clearInterval(this.syncPollInterval);
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.focusHandler) window.removeEventListener('focus', this.focusHandler);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
    }
  }

  connectRealtimeSync() {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (!this.authService.isAuthenticated()) return;

    const token = this.authService.getAuthToken();
    const backendUrl = this.getBackendUrl();
    const url = `${backendUrl}/api/sync/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

    try {
      this.eventSource = new EventSource(url, { withCredentials: true });

      this.eventSource.addEventListener('library_updated', () => {
        // Real-time synchronization triggered from another connected device
        this.syncWithBackendOnStartup(true);
      });

      this.eventSource.addEventListener('profile_updated', () => {
        // Real-time update for profile avatar/banner/tags
        this.authService.verifyRemoteSession(backendUrl);
      });

      this.eventSource.onerror = () => {
        if (this.eventSource) {
          this.eventSource.close();
          this.eventSource = null;
        }
        if (this.sseReconnectTimeout) clearTimeout(this.sseReconnectTimeout);
        this.sseReconnectTimeout = setTimeout(() => {
          if (this.authService.isAuthenticated()) {
            this.connectRealtimeSync();
          }
        }, 30000);
      };
    } catch (e) {
      console.warn('Real-time sync SSE failed to connect:', e);
    }
  }

  getBackendUrl(): string {
    return this.activeBackendUrl || this.defaultBackendUrl;
  }

  private lastSyncTime = 0;

  startAutoSync() {
    if (this.syncPollInterval || typeof window === 'undefined') return;

    // Регулярная авто-синхронизация как резерв для SSE (раз в 3 минуты, если SSE отключен)
    this.syncPollInterval = setInterval(() => {
      if (!this.eventSource || this.eventSource.readyState !== EventSource.OPEN) {
        this.syncAllWithBackend();
      }
    }, 180_000);

    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - this.lastSyncTime > 120_000) {
          this.lastSyncTime = now;
          this.syncAllWithBackend();
        }
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private initLibrary() {
    let savedTracks: Track[] = [];
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY_TRACKS);
      if (stored) savedTracks = JSON.parse(stored);
    } catch {
      savedTracks = [];
    }

    // Восстановление треков, если они были сохранены под гостевым ключом или до смены сессии
    if (typeof localStorage !== 'undefined') {
      const fallbackKeys = [
        'signal_tracks_guest',
        'signal_library_tracks',
        'signal_tracks',
      ];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('signal_tracks_') && k !== this.STORAGE_KEY_TRACKS) {
            fallbackKeys.push(k);
          }
        }
      } catch {}

      const candidateMap = new Map<string, Track>(savedTracks.map((t) => [t.id, t]));
      for (const key of fallbackKeys) {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              for (const pt of parsed) {
                if (pt && pt.id && !pt.id.startsWith('default-track-') && !candidateMap.has(pt.id)) {
                  candidateMap.set(pt.id, pt);
                }
              }
            }
          }
        } catch {}
      }

      // Восстанавливаем также сохраненные оффлайн-треки из базы
      try {
        const offlineList = this.offlineService.getOfflineTracks();
        if (offlineList && offlineList.length > 0) {
          for (const ot of offlineList) {
            if (ot && ot.id && !candidateMap.has(ot.id)) {
              candidateMap.set(ot.id, { ...ot, isOffline: true });
            }
          }
        }
      } catch {}

      savedTracks = Array.from(candidateMap.values());
    }

    let favIds: string[] = [];
    try {
      const storedFavs = localStorage.getItem(this.STORAGE_KEY_FAVORITES);
      if (storedFavs) favIds = JSON.parse(storedFavs);
    } catch {
      favIds = [];
    }

    let savedPlaylists: Playlist[] = [];
    try {
      const storedPl = localStorage.getItem(this.STORAGE_KEY_PLAYLISTS);
      if (storedPl) savedPlaylists = JSON.parse(storedPl);
    } catch {
      savedPlaylists = [];
    }

    let savedStations: RadioStation[] = [];
    try {
      const storedSt = localStorage.getItem(this.STORAGE_KEY_STATIONS);
      if (storedSt) savedStations = JSON.parse(storedSt);
    } catch {
      savedStations = [];
    }

    // Очищаем любые устаревшие демонстрационные треки
    savedTracks = (savedTracks || []).filter((t) => !t.id.startsWith('default-track-') && !t.id.startsWith('starter-'));
    savedTracks = this.sanitizeTracks(savedTracks);
    try {
      localStorage.setItem(this.STORAGE_KEY_TRACKS, JSON.stringify(savedTracks));
    } catch {}

    savedStations = this.sanitizeStations(savedStations);
    try {
      localStorage.setItem(this.STORAGE_KEY_STATIONS, JSON.stringify(savedStations));
    } catch {}

    const processedTracks = savedTracks.map((t) => ({
      ...t,
      isFavorite: favIds.includes(t.id),
    }));

    this.tracks.set(processedTracks);
    this.playlists.set(savedPlaylists);
    this.radioStations.set(savedStations);
  }

  private readonly coverUrlCache = new Map<string, string | undefined>();

  formatCoverUrl(coverUrl?: string, title?: string, artist?: string): string | undefined {
    const key = `${coverUrl || ''}|${title || ''}|${artist || ''}`;
    if (this.coverUrlCache.has(key)) {
      return this.coverUrlCache.get(key);
    }

    const activeBase = this.getBackendUrl();
    const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
    const queryParams: string[] = [];
    if (title) queryParams.push(`title=${encodeURIComponent(title)}`);
    if (artist) queryParams.push(`artist=${encodeURIComponent(artist)}`);
    const glue = queryParams.length > 0 ? `&${queryParams.join('&')}` : '';

    let result: string | undefined;

    if (!coverUrl) {
      if (title) {
        result = `${activeBase}/api/cover?title=${encodeURIComponent(title)}${artist ? `&artist=${encodeURIComponent(artist)}` : ''}`;
      } else {
        result = undefined;
      }
    } else if (coverUrl.includes('/api/cover')) {
      const idx = coverUrl.indexOf('/api/cover');
      result = `${activeBase}${coverUrl.slice(idx)}`;
    } else if (coverUrl.startsWith('/')) {
      result = `${activeBase}${coverUrl}`;
    } else if (
      coverUrl.includes('ytimg.com') ||
      coverUrl.includes('sndcdn.com') ||
      coverUrl.includes('soundcloud.com')
    ) {
      result = `${activeBase}/api/cover?url=${encodeURIComponent(coverUrl)}${glue}`;
    } else if (isHttps && coverUrl.startsWith('http://')) {
      result = coverUrl.replace(/^http:\/\//, 'https://');
    } else {
      result = coverUrl;
    }

    if (this.coverUrlCache.size < 3000) {
      this.coverUrlCache.set(key, result);
    }
    return result;
  }

  getFallbackCoverUrl(title?: string, artist?: string): string {
    const activeBase = this.getBackendUrl();
    return `${activeBase}/api/cover?title=${encodeURIComponent(title || 'Track')}&artist=${encodeURIComponent(artist || 'Artist')}`;
  }

  private activeHealthCheckPromise: Promise<string> | null = null;

  checkBackendHealth(): Promise<string> {
    if (this.activeHealthCheckPromise) {
      return this.activeHealthCheckPromise;
    }

    this.activeHealthCheckPromise = (async () => {
      try {
        const uniqueUrls = getClusterCandidates();

        try {
          const winner = await new Promise<string>((resolve, reject) => {
            let finished = false;
            let failCount = 0;
            const total = uniqueUrls.length;

            for (const testUrl of uniqueUrls) {
              fetch(`${testUrl}/api/health`, { signal: AbortSignal.timeout(1800) })
                .then((res) => {
                  if (res.ok && !finished) {
                    finished = true;
                    resolve(testUrl);
                  } else {
                    failCount++;
                    if (failCount >= total && !finished) {
                      reject(new Error('All nodes unreachable'));
                    }
                  }
                })
                .catch(() => {
                  failCount++;
                  if (failCount >= total && !finished) {
                    reject(new Error('All nodes unreachable'));
                  }
                });
            }
          });

          this.activeBackendUrl = winner;
          this.isBackendOnline.set(true);
          this.authService.setActiveBackendUrl(this.activeBackendUrl);
          this.authService.verifyRemoteSession(this.activeBackendUrl);
          return winner;
        } catch {
          const fallback = this.defaultBackendUrl;
          this.activeBackendUrl = fallback;
          this.isBackendOnline.set(true);
          this.authService.setActiveBackendUrl(this.activeBackendUrl);
          this.authService.verifyRemoteSession(this.activeBackendUrl);
          return fallback;
        }
      } finally {
        this.activeHealthCheckPromise = null;
      }
    })();

    return this.activeHealthCheckPromise;
  }

  async failoverBackend(): Promise<string> {
    const current = this.getBackendUrl();
    const cluster = getClusterCandidates();
    const curIdx = cluster.findIndex((b) => current.includes(b) || b.includes(current));
    const nextIdx = (curIdx + 1) % cluster.length;
    const alt = cluster[nextIdx] || cluster[0] || this.defaultBackendUrl;
    console.warn(`[LibraryService] Failing over backend from ${current} -> ${alt}`);
    this.activeBackendUrl = alt;
    this.authService.setActiveBackendUrl(alt);
    this.authService.verifyRemoteSession(alt);
    this.connectRealtimeSync();
    return alt;
  }

  async searchOnline(query: string): Promise<Track[]> {
    const q = query.trim();
    if (!q) {
      this.onlineSearchResults.set([]);
      return [];
    }

    this.isSearchingOnline.set(true);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.getBackendUrl()}/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
      } catch {
        const alt = await this.failoverBackend();
        res = await fetch(`${alt}/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error('Search failed after failover');
      }

      const data: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string }[] = await res.json();

      const tracks: Track[] = data
        .filter((item) => !item.id.startsWith('audius-') && !item.audio_url?.includes('audius.co'))
        .map((item) => ({
          id: item.id.startsWith('yt-') || item.id.startsWith('sc-') || item.id.startsWith('dz-') ? item.id : (item.id.length === 11 ? 'yt-' + item.id : item.id),
          title: item.title,
          artist: item.artist,
          duration: Math.round(item.duration),
          audioUrl: item.audio_url,
          coverUrl: this.formatCoverUrl(item.cover_url),
          genre: 'Online',
          format: 'mp3',
          bitrate: '192 kbps',
          plays: 0,
          isFavorite: false,
          addedAt: new Date().toISOString().split('T')[0],
        }));

      this.onlineSearchResults.set(tracks);
      return tracks;
    } catch (e) {
      console.warn('Online search error:', e);
      return [];
    } finally {
      this.isSearchingOnline.set(false);
    }
  }

  async getRecommendations(artist?: string, genre?: string, limit = 10, trackId?: string, fallbackGenre?: string): Promise<Track[]> {
    const a = (artist || '').trim();
    const g = (genre || '').trim();
    const tid = (trackId || '').trim();
    if (!a && !g && !tid) return [];

    try {
      const queryParams = new URLSearchParams();
      if (tid) queryParams.set('track_id', tid);
      if (a) queryParams.set('artist', a);
      if (g) queryParams.set('genre', g);
      queryParams.set('limit', limit.toString());

      const res = await fetch(`${this.getBackendUrl()}/api/recommendations?${queryParams.toString()}`);
      if (!res.ok) return [];

      const data: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string }[] = await res.json();

      return data
        .filter((item) => !item.id.startsWith('audius-') && !item.audio_url?.includes('audius.co'))
        .map((item) => ({
          id: item.id.startsWith('dz-') || item.id.startsWith('sc-') || item.id.startsWith('yt-') ? item.id : 'sc-' + item.id,
          title: item.title,
          artist: item.artist,
          duration: Math.round(item.duration),
          audioUrl: item.audio_url,
          coverUrl: this.formatCoverUrl(item.cover_url),
          genre: g || fallbackGenre || 'Discovery',
          format: 'mp3',
          bitrate: '192 kbps',
          plays: 0,
          isFavorite: false,
          addedAt: new Date().toISOString().split('T')[0],
        }));
    } catch (e) {
      console.warn('Get recommendations error:', e);
      return [];
    }
  }

  async getSoundCloudCharts(genre?: string, limit = 10): Promise<Track[]> {
    try {
      const queryParams = new URLSearchParams();
      queryParams.set('chart', 'soundcloud');
      if (genre) queryParams.set('genre', genre);
      queryParams.set('limit', limit.toString());

      const res = await fetch(`${this.getBackendUrl()}/api/recommendations?${queryParams.toString()}`);
      if (!res.ok) return [];

      const data: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string }[] = await res.json();

      return data
        .filter((item) => !item.id.startsWith('audius-') && !item.audio_url?.includes('audius.co'))
        .map((item) => ({
          id: item.id.startsWith('dz-') || item.id.startsWith('sc-') || item.id.startsWith('yt-') ? item.id : 'sc-' + item.id,
          title: item.title,
          artist: item.artist,
          duration: Math.round(item.duration),
          audioUrl: item.audio_url,
          coverUrl: this.formatCoverUrl(item.cover_url),
          genre: genre || 'SoundCloud Chart',
          format: 'mp3',
          bitrate: '192 kbps',
          plays: 0,
          isFavorite: false,
          addedAt: new Date().toISOString().split('T')[0],
        }));
    } catch (e) {
      console.warn('Get SoundCloud charts error:', e);
      return [];
    }
  }

  async getSimilarTracks(title: string, artist: string, limit = 10, fallbackGenre?: string): Promise<Track[]> {
    const t = (title || '').trim();
    const a = (artist || '').trim();
    if (!t && !a) return [];

    try {
      const queryParams = new URLSearchParams();
      if (t) queryParams.set('title', t);
      if (a) queryParams.set('artist', a);
      queryParams.set('limit', limit.toString());

      const res = await fetch(`${this.getBackendUrl()}/api/similar-tracks?${queryParams.toString()}`);
      if (!res.ok) return [];

      const data: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string }[] = await res.json();

      return data
        .filter((item) => !item.id.startsWith('audius-') && !item.audio_url?.includes('audius.co'))
        .map((item) => ({
          id: item.id.startsWith('dz-') || item.id.startsWith('sc-') || item.id.startsWith('yt-') || item.id.startsWith('lfm-') ? item.id : 'dz-' + item.id,
          title: item.title,
          artist: item.artist,
          duration: Math.round(item.duration),
          audioUrl: item.audio_url,
          coverUrl: this.formatCoverUrl(item.cover_url),
          genre: fallbackGenre || 'Similar',
          format: 'mp3' as const,
          bitrate: '192 kbps',
          plays: 0,
          isFavorite: false,
          addedAt: new Date().toISOString().split('T')[0],
        }));
    } catch (e) {
      console.warn('Get similar tracks error:', e);
      return [];
    }
  }

  async extractFromUrl(url: string): Promise<ExtractedResult> {
    const targetUrl = url.trim();
    if (!targetUrl) return { playlistTitle: null, tracks: [] };

    const res = await fetch(`${this.getBackendUrl()}/api/extract?url=${encodeURIComponent(targetUrl)}`);
    if (!res.ok) throw new Error('Extract failed');

    const data: {
      playlist_title: string | null;
      tracks: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string }[];
      main_video?: { id: string; title: string; artist: string; duration: number; audio_url: string; cover_url?: string } | null;
      is_radio_mix?: boolean;
      has_chapters?: boolean;
    } = await res.json();

    const seenIds = new Set<string>();
    const tracks: Track[] = [];

    for (const item of data.tracks || []) {
      const cleanId = 'yt-' + item.id;
      if (seenIds.has(cleanId)) continue;
      seenIds.add(cleanId);

      tracks.push({
        id: cleanId,
        title: item.title,
        artist: item.artist,
        duration: Math.round(item.duration),
        audioUrl: item.audio_url,
        coverUrl: this.formatCoverUrl(item.cover_url),
        genre: 'YouTube',
        format: 'mp3',
        bitrate: '192 kbps',
        plays: 0,
        isFavorite: false,
        addedAt: new Date().toISOString().split('T')[0],
      });
    }

    let mainVideo: Track | null = null;
    if (data.main_video) {
      mainVideo = {
        id: 'yt-' + data.main_video.id,
        title: data.main_video.title,
        artist: data.main_video.artist,
        duration: Math.round(data.main_video.duration),
        audioUrl: data.main_video.audio_url,
        coverUrl: this.formatCoverUrl(data.main_video.cover_url),
        genre: 'YouTube Mix',
        format: 'mp3',
        bitrate: '192 kbps',
        plays: 0,
        isFavorite: false,
        addedAt: new Date().toISOString().split('T')[0],
      };
    }

    return {
      playlistTitle: data.playlist_title,
      tracks,
      mainVideo,
      isRadioMix: !!data.is_radio_mix,
      hasChapters: !!data.has_chapters,
    };
  }

  importPlaylist(title: string, tracks: Track[]): Playlist {
    const newTracks: Track[] = [];
    const finalTrackIds: string[] = [];

    for (const t of tracks) {
      const existing = this.tracks().find((x) => x.id === t.id || x.audioUrl === t.audioUrl);
      if (existing) {
        finalTrackIds.push(existing.id);
      } else {
        const playlistTrack: Track = { ...t, playlistOnly: true };
        newTracks.push(playlistTrack);
        finalTrackIds.push(playlistTrack.id);
      }
    }

    if (newTracks.length > 0) {
      this.tracks.update((current) => [...newTracks, ...current]);
      this.persistTracks();
    }

    const playlist = this.createPlaylist(title, `Импортировано: ${finalTrackIds.length} треков`);

    this.playlists.update((pls) =>
      pls.map((p) => (p.id === playlist.id ? { ...p, trackIds: finalTrackIds } : p))
    );
    this.persistPlaylists();

    return playlist;
  }

  private getLocalUpdatedAt(): number {
    try {
      const v = localStorage.getItem(this.STORAGE_KEY_UPDATED_AT);
      return v ? parseInt(v, 10) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private markUpdated() {
    try {
      localStorage.setItem(this.STORAGE_KEY_UPDATED_AT, Date.now().toString());
    } catch {}
    this.scheduleCloudSync();
  }

  private persistTracks() {
    const persistable = this.tracks().filter((t) => !t.audioUrl.startsWith('blob:'));
    try {
      localStorage.setItem(this.STORAGE_KEY_TRACKS, JSON.stringify(persistable));
    } catch (e) {
      console.warn('Failed to save tracks to localStorage:', e);
    }
    this.markUpdated();
  }

  private persistPlaylists() {
    try {
      localStorage.setItem(this.STORAGE_KEY_PLAYLISTS, JSON.stringify(this.playlists()));
    } catch (e) {
      console.warn('Failed to save playlists to localStorage:', e);
    }
    this.markUpdated();
  }

  private persistStations() {
    try {
      localStorage.setItem(this.STORAGE_KEY_STATIONS, JSON.stringify(this.radioStations()));
    } catch (e) {
      console.warn('Failed to save stations to localStorage:', e);
    }
    this.markUpdated();
  }

  private saveLocalWithoutCloudSync() {
    const persistable = this.tracks().filter((t) => !t.audioUrl.startsWith('blob:'));
    try {
      localStorage.setItem(this.STORAGE_KEY_TRACKS, JSON.stringify(persistable));
      localStorage.setItem(this.STORAGE_KEY_PLAYLISTS, JSON.stringify(this.playlists()));
      localStorage.setItem(this.STORAGE_KEY_STATIONS, JSON.stringify(this.radioStations()));
      const favs = persistable.filter((t) => t.isFavorite).map((t) => t.id);
      localStorage.setItem(this.STORAGE_KEY_FAVORITES, JSON.stringify(favs));
    } catch (e) {
      console.warn('Local save error:', e);
    }
  }

  scheduleCloudSync() {
    this.isCloudSynced.set(false);
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.pushLibraryToBackend();
    }, 1500);
  }

  async pushLibraryToBackend() {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    if (!this.isBackendOnline()) return;
    if (!this.authService.isAuthenticated()) return;

    try {
      const updatedAt = Date.now();
      try {
        localStorage.setItem(this.STORAGE_KEY_UPDATED_AT, updatedAt.toString());
      } catch {}

      const payload = {
        updated_at: updatedAt,
        tracks: this.tracks().filter((t) => !t.audioUrl.startsWith('blob:')),
        playlists: this.playlists(),
        radio_stations: this.radioStations(),
        mix_config: this.mixConfig(),
        disliked_ids: Array.from(this.dislikedTrackIds()),
      };

      const res = await fetch(`${this.getBackendUrl()}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authService.getAuthHeaders(),
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        console.warn('[LibraryService] /api/sync POST returned 401, preserving local library.');
        return;
      }

      if (res.ok) {
        this.isCloudSynced.set(true);
      }
    } catch (e) {
      console.warn('Background sync failed:', e);
    }
  }

  async syncAllWithBackend(forceCloud = false): Promise<void> {
    if (!this.authService.isAuthenticated()) return;
    const backendUrl = this.getBackendUrl();
    await Promise.allSettled([
      this.syncWithBackendOnStartup(forceCloud),
      this.authService.verifyRemoteSession(backendUrl),
    ]);
  }

  async resizeImageFile(file: File, maxDimension = 500, quality = 0.85): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(reader.result as string);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          let mime = 'image/webp';
          try {
            if (!canvas.toDataURL('image/webp').startsWith('data:image/webp')) {
              mime = 'image/jpeg';
            }
          } catch {
            mime = 'image/jpeg';
          }
          resolve(canvas.toDataURL(mime, quality));
        };
        img.onerror = () => reject(new Error('Image failed to load'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('File reading failed'));
      reader.readAsDataURL(file);
    });
  }

  async syncWithBackendOnStartup(forceCloud = false) {
    if (!this.isBackendOnline()) return;
    if (!this.authService.isAuthenticated()) return;

    try {
      const res = await fetch(`${this.getBackendUrl()}/api/sync`, {
        headers: this.authService.getAuthHeaders(),
        credentials: 'include',
      });
      if (res.status === 401) {
        console.warn('[LibraryService] /api/sync GET returned 401, preserving local library.');
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      if (!data) return;

      if (data.mix_config) {
        const mergedConfig: MixConfig = { ...DEFAULT_MIX_CONFIG, ...data.mix_config };
        this.mixConfig.set(mergedConfig);
        try {
          localStorage.setItem(this.STORAGE_KEY_MIX_CONFIG, JSON.stringify(mergedConfig));
        } catch {}
      }
      if (Array.isArray(data.disliked_ids)) {
        const mergedDislikes = new Set([...this.dislikedTrackIds(), ...data.disliked_ids]);
        this.dislikedTrackIds.set(mergedDislikes);
        try {
          localStorage.setItem(this.STORAGE_KEY_DISLIKES, JSON.stringify(Array.from(mergedDislikes)));
        } catch {}
      }

      const cloudUpdatedAt = typeof data.updated_at === 'number' ? data.updated_at : 0;
      const localTracks = this.tracks();

      if (Array.isArray(data.tracks)) {
        const rawTracks: Track[] = data.tracks;
        const cloudTracks: Track[] = this.sanitizeTracks(
          rawTracks.filter((t: Track) => !t.id.startsWith('default-track-'))
        );
        const cloudPlaylists: Playlist[] = Array.isArray(data.playlists)
          ? data.playlists.map((p: any) => ({
              ...p,
              coverUrl: typeof p.coverUrl === 'string' && p.coverUrl.trim() ? p.coverUrl.trim() : undefined,
            }))
          : [];
        const cloudStations: RadioStation[] = this.sanitizeStations(
          Array.isArray(data.radio_stations) && data.radio_stations.length > 0
            ? data.radio_stations
            : [...this.defaultRadioStations]
        );

        // If cloud library has never been populated (new account) and local device has tracks, upload them
        if (cloudTracks.length === 0 && localTracks.length > 0 && cloudUpdatedAt === 0) {
          await this.pushLibraryToBackend();
          this.isCloudSynced.set(true);
          return;
        }

        const localUpdatedAt = parseInt(localStorage.getItem(this.STORAGE_KEY_UPDATED_AT) || '0', 10);

        // Bidirectional smart merge between local and cloud tracks
        const { merged: finalTracks, hasNewLocal } = this.mergeTrackLists(localTracks, cloudTracks);
        const { mergedPlaylists, hasNewLocalPlaylists } = this.mergePlaylistLists(this.playlists(), cloudPlaylists);

        const stationsToSet = cloudStations.length > 0 ? cloudStations : this.radioStations();

        this.tracks.set(finalTracks);
        this.playlists.set(mergedPlaylists);
        this.radioStations.set(stationsToSet);
        this.saveLocalWithoutCloudSync();

        try {
          const maxUpdated = Math.max(cloudUpdatedAt, localUpdatedAt, Date.now());
          localStorage.setItem(this.STORAGE_KEY_UPDATED_AT, maxUpdated.toString());
        } catch {}

        if (hasNewLocal || hasNewLocalPlaylists || (finalTracks.length > cloudTracks.length && !forceCloud)) {
          // Device had tracks or playlists that cloud lacked - push merged state to cloud
          await this.pushLibraryToBackend();
        }

        try {
          const offlineSvc = this.offlineService;
          for (const t of finalTracks) {
            if (t.isOffline && !offlineSvc.isTrackOffline(t.id) && !offlineSvc.isDownloading(t.id)) {
              if (t.audioUrl && !t.audioUrl.startsWith('blob:')) {
                offlineSvc.saveTrackOffline(t).catch(() => {});
              }
            }
          }
        } catch {}

        this.isCloudSynced.set(true);
      }
    } catch (e) {
      console.warn('Sync error:', e);
    }
  }

  private mergeTrackLists(localTracks: Track[], cloudTracks: Track[]): { merged: Track[]; hasNewLocal: boolean } {
    const keyOf = (t: Track): string => {
      if (t.id && !t.id.startsWith('default-track-')) {
        return t.id;
      }
      const a = (t.artist || '').trim().toLowerCase();
      const tit = (t.title || '').trim().toLowerCase();
      return `${a}::${tit}`;
    };

    const secondaryKeyOf = (t: Track): string => {
      const a = (t.artist || '').trim().toLowerCase();
      const tit = (t.title || '').trim().toLowerCase();
      return `${a}::${tit}`;
    };

    const mergedMap = new Map<string, Track>();
    const titleArtistMap = new Map<string, string>();

    // 1. Put cloud tracks into map
    for (const ct of cloudTracks) {
      if (ct.id.startsWith('default-track-')) continue;
      const primaryKey = keyOf(ct);
      const secKey = secondaryKeyOf(ct);
      mergedMap.set(primaryKey, { ...ct });
      if (secKey && secKey !== '::') {
        titleArtistMap.set(secKey, primaryKey);
      }
    }

    let hasNewLocal = false;

    // 2. Union merge local tracks
    for (const lt of localTracks) {
      if (lt.id.startsWith('default-track-')) continue;
      const primaryKey = keyOf(lt);
      const secKey = secondaryKeyOf(lt);

      let existingKey = mergedMap.has(primaryKey) ? primaryKey : null;
      if (!existingKey && secKey && titleArtistMap.has(secKey)) {
        existingKey = titleArtistMap.get(secKey)!;
      }

      if (existingKey) {
        const existing = mergedMap.get(existingKey)!;
        const mergedTrack: Track = {
          ...existing,
          isFavorite: Boolean(existing.isFavorite || lt.isFavorite),
          plays: Math.max(existing.plays || 0, lt.plays || 0),
          isOffline: Boolean(existing.isOffline || lt.isOffline),
          audioUrl: existing.audioUrl && !existing.audioUrl.startsWith('blob:') ? existing.audioUrl : lt.audioUrl,
          coverUrl: existing.coverUrl || lt.coverUrl,
          album: existing.album || lt.album,
          genre: existing.genre || lt.genre,
        };
        mergedMap.set(existingKey, mergedTrack);
      } else {
        mergedMap.set(primaryKey, { ...lt });
        if (secKey && secKey !== '::') {
          titleArtistMap.set(secKey, primaryKey);
        }
        hasNewLocal = true;
      }
    }

    return {
      merged: Array.from(mergedMap.values()),
      hasNewLocal,
    };
  }

  private mergePlaylistLists(local: Playlist[], cloud: Playlist[]): { mergedPlaylists: Playlist[]; hasNewLocalPlaylists: boolean } {
    const plMap = new Map<string, Playlist>();
    for (const cp of cloud) {
      if (cp.id) plMap.set(cp.id, { ...cp });
    }
    let hasNewLocalPlaylists = false;
    for (const lp of local) {
      if (!lp.id) continue;
      if (!plMap.has(lp.id)) {
        plMap.set(lp.id, { ...lp });
        hasNewLocalPlaylists = true;
      } else {
        const existing = plMap.get(lp.id)!;
        const combinedIds = Array.from(new Set([...(existing.trackIds || []), ...(lp.trackIds || [])]));
        plMap.set(lp.id, {
          ...existing,
          title: existing.title || lp.title,
          coverUrl: existing.coverUrl || lp.coverUrl,
          description: existing.description || lp.description,
          trackIds: combinedIds,
        });
      }
    }
    return {
      mergedPlaylists: Array.from(plMap.values()),
      hasNewLocalPlaylists,
    };
  }

  updateTrackOfflineStatus(trackId: string, isOffline: boolean) {
    this.tracks.update((current) =>
      current.map((t) => (t.id === trackId ? { ...t, isOffline } : t))
    );
    this.persistTracks();
    this.pushLibraryToBackend();
  }

  isTrackFavorite(track: Track | null | undefined): boolean {
    if (!track || !track.id) return false;
    const all = this.tracks();
    const tId = track.id;

    const match = all.find((t) => t.id === tId);
    if (match) return !!match.isFavorite;
    return !!track.isFavorite;
  }

  toggleFavorite(trackId: string, trackObj?: Track): boolean {
    if (!trackId) return false;
    const all = this.tracks();
    const existing = all.find((t) => t.id === trackId);

    let newStatus = true;
    if (!existing && trackObj) {
      const newTrack: Track = { ...trackObj, id: trackId, isFavorite: true, playlistOnly: false };
      trackObj.isFavorite = true;
      this.tracks.update((cur) => [newTrack, ...cur]);
      newStatus = true;
    } else if (existing) {
      newStatus = !existing.isFavorite;
      existing.isFavorite = newStatus;
      if (trackObj) {
        trackObj.isFavorite = newStatus;
      }
      this.tracks.update((current) =>
        current.map((t) => {
          if (t.id === trackId) {
            return { ...t, isFavorite: newStatus };
          }
          return t;
        })
      );
    } else if (trackObj) {
      const newTrack: Track = { ...trackObj, id: trackId, isFavorite: true, playlistOnly: false };
      trackObj.isFavorite = true;
      this.tracks.update((cur) => [newTrack, ...cur]);
      newStatus = true;
    }

    const favs = this.tracks()
      .filter((t) => t.isFavorite)
      .map((t) => t.id);
    try {
      localStorage.setItem(this.STORAGE_KEY_FAVORITES, JSON.stringify(favs));
    } catch {}
    this.persistTracks();
    this.pushLibraryToBackend();
    return newStatus;
  }

  addTrackToLibrary(track: Track) {
    const existing = this.tracks().find((t) => t.id === track.id || t.audioUrl === track.audioUrl);
    if (!existing) {
      this.tracks.update((cur) => [{ ...track, playlistOnly: false }, ...cur]);
      this.persistTracks();
      this.pushLibraryToBackend();
    } else if (existing.playlistOnly || (track.isOffline && !existing.isOffline)) {
      this.tracks.update((cur) =>
        cur.map((t) => (t.id === existing.id ? { ...t, playlistOnly: false, isOffline: track.isOffline || t.isOffline } : t))
      );
      this.persistTracks();
      this.pushLibraryToBackend();
    }
  }

  addMultipleTracks(tracks: Track[]) {
    const toAdd: Track[] = [];
    const idsToUnmarkPlaylistOnly = new Set<string>();

    for (const t of tracks) {
      const existing = this.tracks().find((x) => x.id === t.id || x.audioUrl === t.audioUrl);
      if (!existing) {
        toAdd.push({ ...t, playlistOnly: false });
      } else if (existing.playlistOnly) {
        idsToUnmarkPlaylistOnly.add(existing.id);
      }
    }

    if (toAdd.length > 0 || idsToUnmarkPlaylistOnly.size > 0) {
      this.tracks.update((cur) => {
        let updated = cur;
        if (idsToUnmarkPlaylistOnly.size > 0) {
          updated = updated.map((t) => (idsToUnmarkPlaylistOnly.has(t.id) ? { ...t, playlistOnly: false } : t));
        }
        return [...toAdd, ...updated];
      });
      this.persistTracks();
      this.pushLibraryToBackend();
    }
  }

  addRadioStation(station: { name: string; streamUrl: string; genre?: string; country?: string; bitrate?: string }) {
    const cleanUrl = station.streamUrl.trim();
    if (!cleanUrl) return;

    const newStation: RadioStation = {
      id: 'custom-' + Date.now(),
      name: station.name.trim() || 'Пользовательская станция',
      streamUrl: cleanUrl,
      genre: station.genre?.trim() || 'Radio',
      country: station.country?.trim() || 'Custom',
      bitrate: station.bitrate?.trim() || 'Live',
      isCustom: true,
    };

    this.radioStations.update((cur) => [newStation, ...cur]);
    this.persistStations();
  }

  removeRadioStation(stationId: string) {
    this.radioStations.update((cur) => cur.filter((s) => s.id !== stationId));
    this.persistStations();
  }

  sanitizeStations(stations: RadioStation[]): RadioStation[] {
    if (!Array.isArray(stations) || stations.length === 0) {
      return [...this.defaultRadioStations];
    }

    const isBroken = (url: string) =>
      !url ||
      url.includes(':8052') ||
      url.includes('wostreaming.net') ||
      url.includes('stream.zeno.fm') ||
      url.includes('ep256.hostingradio.ru') ||
      url.includes('europaplus256.mp3') ||
      url.includes('streamr.ru') ||
      url.includes('hostingradio.ru:8014') ||
      url.includes('gkvr.ru');

    const sanitized = stations
      .map((st) => {
        const lowerName = (st.name || '').toLowerCase();
        if (lowerName.includes('dacha') || lowerName.includes('дача') || st.id === 'default-11' || (st.streamUrl && st.streamUrl.includes('gkvr.ru'))) {
          return {
            ...st,
            streamUrl: 'https://stream.n340.com/14_dacha_64',
            bitrate: '64k AAC'
          };
        }
        if (lowerName.includes('europa plus') || st.id === 'default-2' || st.id === 'default-3' || isBroken(st.streamUrl)) {
          if (lowerName.includes('top 40') || st.id === 'default-2') {
            return {
              ...st,
              streamUrl: 'https://hls-01-regions.emgsound.ru/11_top40/playlist.m3u8',
              bitrate: '256k MP3'
            };
          }
          if (lowerName.includes('europa plus')) {
            return {
              ...st,
              streamUrl: 'https://hls-01-regions.emgsound.ru/11_msk/playlist.m3u8',
              bitrate: '128k MP3'
            };
          }
        }
        return st;
      })
      .filter((st) => !isBroken(st.streamUrl));

    // Ensure all default radio stations exist
    for (const def of this.defaultRadioStations) {
      if (!sanitized.some((s) => s.id === def.id || (s.name && s.name.toLowerCase() === def.name.toLowerCase()))) {
        sanitized.push(def);
      }
    }

    return sanitized;
  }

  sanitizeTracks(tracks: Track[]): Track[] {
    if (!Array.isArray(tracks)) return [];
    const backendUrl = this.getBackendUrl();
    const isBroken = (url: string) =>
      !url ||
      url.includes(':8052') ||
      url.includes('wostreaming.net') ||
      url.includes('stream.zeno.fm') ||
      url.includes('ep256.hostingradio.ru') ||
      url.includes('europaplus256.mp3') ||
      url.includes('streamr.ru') ||
      url.includes('hostingradio.ru:8014') ||
      url.includes('gkvr.ru');

    return tracks.map((t) => {
      let audioUrl = t.audioUrl || '';
      let coverUrl = t.coverUrl;

      // Rewrites all /api/ endpoints (e.g. /api/stream, /api/cover) to current backendUrl,
      // regardless of whether they were originally stored with localhost, raw IP (80.87.202.157), or another domain
      if (backendUrl) {
        const idx = audioUrl.indexOf('/api/');
        if (idx !== -1) {
          audioUrl = `${backendUrl}${audioUrl.slice(idx)}`;
        }
        if (coverUrl && coverUrl.indexOf('/api/') !== -1) {
          const idx = coverUrl.indexOf('/api/');
          coverUrl = `${backendUrl}${coverUrl.slice(idx)}`;
        }
      }

      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      if (isHttps) {
        if (audioUrl.startsWith('http://') && !audioUrl.includes('localhost') && !audioUrl.includes('127.0.0.1')) {
          audioUrl = audioUrl.replace(/^http:\/\//, 'https://');
        }
        if (coverUrl && coverUrl.startsWith('http://')) {
          coverUrl = coverUrl.replace(/^http:\/\//, 'https://');
        }
      }

      const lowerTitle = (t.title || '').toLowerCase();
      const isRadio = t.isLiveStream || t.id.startsWith('radio-') || lowerTitle.includes('европа плюс') || lowerTitle.includes('europa plus') || lowerTitle.includes('дача') || lowerTitle.includes('dacha');
      if (isRadio && (lowerTitle.includes('дача') || lowerTitle.includes('dacha') || t.id.includes('default-11') || audioUrl.includes('gkvr.ru'))) {
        return {
          ...t,
          audioUrl: 'https://stream.n340.com/14_dacha_64',
          coverUrl,
          bitrate: '64k AAC',
          isLiveStream: true,
        };
      }
      if (isRadio && isBroken(audioUrl)) {
        const isTop = lowerTitle.includes('top 40') || t.id.includes('default-2') || audioUrl.includes('top');
        const newUrl = isTop
          ? 'https://hls-01-regions.emgsound.ru/11_top40/playlist.m3u8'
          : 'https://hls-01-regions.emgsound.ru/11_msk/playlist.m3u8';
        return {
          ...t,
          audioUrl: newUrl,
          coverUrl,
          bitrate: isTop ? '256k MP3' : '128k MP3',
          isLiveStream: true,
        };
      }
      return {
        ...t,
        audioUrl,
        coverUrl,
      };
    });
  }

  resetDefaultStations() {
    this.radioStations.set([...this.defaultRadioStations]);
    this.persistStations();
  }

  createTrackFromStation(station: RadioStation): Track {
    const track: Track = {
      id: 'radio-' + station.id,
      title: station.name,
      artist: station.country ? `Радио (${station.country})` : 'Интернет-радио',
      album: 'Live Radio Stations',
      duration: 0,
      audioUrl: station.streamUrl,
      coverUrl: station.favicon,
      genre: station.genre || 'Radio',
      format: 'stream',
      bitrate: station.bitrate || 'Live Stream',
      plays: 0,
      isFavorite: false,
      addedAt: new Date().toISOString().split('T')[0],
      isLiveStream: true,
    };
    this.addTrackToLibrary(track);
    return track;
  }

  async searchRadioBrowser(query: string): Promise<RadioStation[]> {
    const q = query.trim();
    if (!q) return [];

    try {
      const res = await fetch(`https://de1.api.radio-browser.info/json/stations/byname/${encodeURIComponent(q)}?limit=20`);
      if (!res.ok) throw new Error('Radio search failed');

      const data: any[] = await res.json();
      return data.map((item) => ({
        id: 'rb-' + (item.stationuuid || Math.random()),
        name: item.name,
        streamUrl: item.url_resolved || item.url,
        genre: item.tags ? item.tags.split(',').slice(0, 2).join(' / ') : 'Radio',
        country: item.countrycode || item.country || '',
        bitrate: item.bitrate ? `${item.bitrate}k` : 'Live',
        favicon: item.favicon || undefined,
        isCustom: false,
      }));
    } catch {
      return [];
    }
  }

  async addStreamTrack(
    url: string,
    customTitle?: string,
    customArtist?: string,
    customGenre?: string,
    isLive = false
  ): Promise<Track> {
    const cleanUrl = url.trim();

    let format: Track['format'] = 'stream';
    if (cleanUrl.endsWith('.flac')) format = 'flac';
    else if (cleanUrl.endsWith('.wav')) format = 'wav';
    else if (cleanUrl.endsWith('.ogg')) format = 'ogg';
    else if (cleanUrl.endsWith('.m4a')) format = 'm4a';
    else if (cleanUrl.endsWith('.mp3')) format = 'mp3';

    let title = customTitle?.trim();
    if (!title) {
      try {
        const pathname = new URL(cleanUrl).pathname;
        const lastPart = pathname.split('/').pop() || 'Web Stream';
        title = decodeURIComponent(lastPart.replace(/\.[^/.]+$/, '')) || 'Web Audio Stream';
      } catch {
        title = 'Web Audio Stream';
      }
    }

    const artist = customArtist?.trim() || (isLive ? 'Live Radio' : 'Network Stream');
    const genre = customGenre?.trim() || (isLive ? 'Radio' : 'Web Stream');

    const isYtOrSc =
      cleanUrl.includes('youtube.com') ||
      cleanUrl.includes('youtu.be') ||
      cleanUrl.includes('soundcloud.com');

    let finalAudioUrl = cleanUrl;
    if (isYtOrSc) {
      finalAudioUrl = `/api/stream?url=${encodeURIComponent(cleanUrl)}&title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`;
    }

    let duration = 0;
    if (!isLive && !isYtOrSc) {
      duration = await new Promise<number>((resolve) => {
        const probeAudio = new Audio(cleanUrl);
        probeAudio.addEventListener('loadedmetadata', () => {
          const d = probeAudio.duration;
          resolve(isFinite(d) && d > 0 ? Math.round(d) : 0);
        });
        probeAudio.addEventListener('error', () => resolve(0));
        setTimeout(() => resolve(0), 2000);
      });
    }

    const isLossless = format === 'flac' || format === 'wav';
    const newTrack: Track = {
      id: 'stream-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title,
      artist,
      album: isLive ? 'Live Radio Stations' : 'Web Streams',
      duration: duration || 0,
      audioUrl: finalAudioUrl,
      genre,
      year: new Date().getFullYear(),
      format,
      bitrate: isLossless ? '1411 kbps (Lossless FLAC)' : (isLive ? 'Live Stream' : 'Direct URL'),
      isLossless,
      plays: 0,
      isFavorite: false,
      addedAt: new Date().toISOString().split('T')[0],
      isLiveStream: isLive || duration === 0,
    };

    this.tracks.update((current) => [newTrack, ...current]);
    this.persistTracks();
    this.pushLibraryToBackend();
    return newTrack;
  }

  async addUploadedFile(
    file: File,
    customTitle?: string,
    customArtist?: string,
    customGenre?: string
  ): Promise<Track> {
    const audioUrl = URL.createObjectURL(file);

    const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3';
    const validFormat: Track['format'] = ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)
      ? (ext as Track['format'])
      : 'mp3';

    const rawName = file.name.replace(/\.[^/.]+$/, '');
    let title = customTitle || rawName;
    let artist = customArtist || 'Локальный файл';

    if (!customTitle && rawName.includes(' - ')) {
      const parts = rawName.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }

    const duration = await new Promise<number>((resolve) => {
      const tempAudio = new Audio(audioUrl);
      tempAudio.addEventListener('loadedmetadata', () => {
        resolve(Math.round(tempAudio.duration) || 0);
      });
      tempAudio.addEventListener('error', () => {
        resolve(0);
      });
    });

    const isLossless = validFormat === 'flac' || validFormat === 'wav';
    const computedBitrate = isLossless
      ? (validFormat === 'flac' ? '1411 kbps (Lossless FLAC)' : '1411 kbps (Lossless WAV)')
      : Math.round((file.size * 8) / (duration || 180) / 1000) + ' kbps';

    const newTrack: Track = {
      id: 'upload-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title,
      artist,
      album: 'Локальные файлы',
      duration,
      audioUrl,
      genre: customGenre || 'Audio',
      year: new Date().getFullYear(),
      format: validFormat,
      bitrate: computedBitrate,
      isLossless,
      bitDepth: isLossless ? 16 : undefined,
      sampleRate: isLossless ? 44100 : undefined,
      plays: 0,
      isFavorite: false,
      addedAt: new Date().toISOString().split('T')[0],
      isLocalUpload: true,
      isOffline: true,
    };

    await this.offlineService.saveBlobOffline(newTrack, file);

    this.tracks.update((current) => [newTrack, ...current]);
    this.persistTracks();
    return newTrack;
  }

  deleteTrack(trackId: string) {
    this.tracks.update((current) => current.filter((t) => t.id !== trackId));
    this.playlists.update((pls) =>
      pls.map((p) => ({
        ...p,
        trackIds: p.trackIds.filter((id) => id !== trackId),
      }))
    );
    this.offlineService.removeTrackOffline(trackId).catch(() => {});
    this.persistTracks();
    this.persistPlaylists();
    this.pushLibraryToBackend();
  }

  removeTrackFromPlaylist(playlistId: string, trackId: string) {
    this.playlists.update((pls) =>
      pls.map((p) => (p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((id) => id !== trackId) } : p))
    );
    this.persistPlaylists();

    const otherTrackIds = new Set(this.playlists().flatMap((p) => p.trackIds));
    if (!otherTrackIds.has(trackId)) {
      this.tracks.update((tracks) => tracks.filter((t) => !(t.id === trackId && t.playlistOnly)));
      this.persistTracks();
    }
    this.pushLibraryToBackend();
  }

  clearAllTracks() {
    this.tracks.set([]);
    this.playlists.update((pls) => pls.map((p) => ({ ...p, trackIds: [] })));
    this.persistTracks();
    this.persistPlaylists();
    this.pushLibraryToBackend();
  }

  createPlaylist(title: string, description?: string, coverUrl?: string): Playlist {
    const cleanTitle = title.trim();
    const coverText = cleanTitle.slice(0, 2).toUpperCase();
    const newPl: Playlist = {
      id: 'pl-' + Date.now(),
      title: cleanTitle,
      description: description?.trim() || 'Пользовательский плейлист',
      trackIds: [],
      coverText,
      coverUrl: coverUrl?.trim() || undefined,
    };
    this.playlists.update((pls) => [...pls, newPl]);
    this.persistPlaylists();
    this.pushLibraryToBackend();
    return newPl;
  }

  updatePlaylistCover(playlistId: string, coverUrl: string) {
    this.playlists.update((pls) =>
      pls.map((p) => (p.id === playlistId ? { ...p, coverUrl: coverUrl.trim() || undefined } : p))
    );
    this.persistPlaylists();
    this.pushLibraryToBackend();
  }


  deletePlaylist(playlistId: string) {
    const pl = this.playlists().find((p) => p.id === playlistId);
    this.playlists.update((pls) => pls.filter((p) => p.id !== playlistId));
    if (this.activePlaylistId() === playlistId) {
      this.activePlaylistId.set(null);
      this.selectedView.set('all');
    }
    this.persistPlaylists();

    if (pl && pl.trackIds.length > 0) {
      const otherTrackIds = new Set(this.playlists().flatMap((p) => p.trackIds));
      this.tracks.update((tracks) =>
        tracks.filter((t) => !(t.playlistOnly && pl.trackIds.includes(t.id) && !otherTrackIds.has(t.id)))
      );
      this.persistTracks();
    }
    this.pushLibraryToBackend();
  }

  toggleTrackInPlaylist(playlistId: string, trackId: string): boolean {
    let isAdded = false;
    this.playlists.update((pls) =>
      pls.map((p) => {
        if (p.id === playlistId) {
          if (p.trackIds.includes(trackId)) {
            isAdded = false;
            return { ...p, trackIds: p.trackIds.filter((id) => id !== trackId) };
          } else {
            isAdded = true;
            return { ...p, trackIds: [...p.trackIds, trackId] };
          }
        }
        return p;
      })
    );
    this.persistPlaylists();
    this.pushLibraryToBackend();
    return isAdded;
  }

  reorderTracksInPlaylist(
    playlistId: string, 
    fromTrackIdOrIndex: string | number, 
    toTrackIdOrIndex: string | number, 
    position: 'before' | 'after' = 'before'
  ): boolean {
    let success = false;
    this.playlists.update((pls) =>
      pls.map((p) => {
        if (p.id === playlistId) {
          const fromIdx = typeof fromTrackIdOrIndex === 'number'
            ? fromTrackIdOrIndex
            : p.trackIds.indexOf(fromTrackIdOrIndex);

          const toIdx = typeof toTrackIdOrIndex === 'number'
            ? toTrackIdOrIndex
            : p.trackIds.indexOf(toTrackIdOrIndex);

          if (fromIdx < 0 || fromIdx >= p.trackIds.length || toIdx < 0 || toIdx >= p.trackIds.length || fromIdx === toIdx) {
            return p;
          }

          const updated = [...p.trackIds];
          const [moved] = updated.splice(fromIdx, 1);
          let insertIdx = typeof toTrackIdOrIndex === 'string' 
            ? updated.indexOf(toTrackIdOrIndex) 
            : (toIdx > fromIdx ? toIdx - 1 : toIdx);

          if (position === 'after') {
            insertIdx += 1;
          }
          const finalIdx = Math.max(0, Math.min(updated.length, insertIdx));
          updated.splice(finalIdx, 0, moved);
          success = true;
          return { ...p, trackIds: updated };
        }
        return p;
      })
    );
    if (success) {
      this.persistPlaylists();
      this.pushLibraryToBackend();
    }
    return success;
  }

  exportLibrary() {
    const backupData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      tracks: this.tracks().filter((t) => !t.audioUrl.startsWith('blob:')),
      playlists: this.playlists(),
      radioStations: this.radioStations(),
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recro-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  importLibrary(content: string): { tracksCount: number; playlistsCount: number; stationsCount: number } {
    let data: any;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error('Некорректный JSON файл бэкапа — не удалось разобрать файл');
    }
    if (!data || typeof data !== 'object') throw new Error('Некорректный формат файла бэкапа');

    let importedTracks = 0;
    if (Array.isArray(data.tracks)) {
      const current = this.tracks();
      const newTracks: Track[] = [];
      for (const t of data.tracks) {
        if (t && t.id && t.title && !current.some((x) => x.id === t.id || x.audioUrl === t.audioUrl)) {
          newTracks.push(t);
        }
      }
      if (newTracks.length > 0) {
        this.tracks.update((cur) => [...newTracks, ...cur]);
        this.persistTracks();
      }
      importedTracks = newTracks.length;
    }

    let importedPlaylists = 0;
    if (Array.isArray(data.playlists)) {
      const current = this.playlists();
      const newPlaylists: Playlist[] = [];
      for (const p of data.playlists) {
        if (p && p.id && p.title && !current.some((x) => x.id === p.id)) {
          newPlaylists.push(p);
        }
      }
      if (newPlaylists.length > 0) {
        this.playlists.update((cur) => [...cur, ...newPlaylists]);
        this.persistPlaylists();
      }
      importedPlaylists = newPlaylists.length;
    }

    let importedStations = 0;
    if (Array.isArray(data.radioStations)) {
      const current = this.radioStations();
      const newStations: RadioStation[] = [];
      for (const s of data.radioStations) {
        if (s && s.id && s.name && s.streamUrl && !current.some((x) => x.id === s.id || x.streamUrl === s.streamUrl)) {
          newStations.push(s);
        }
      }
      if (newStations.length > 0) {
        this.radioStations.update((cur) => [...cur, ...newStations]);
        this.persistStations();
      }
      importedStations = newStations.length;
    }

    return {
      tracksCount: importedTracks,
      playlistsCount: importedPlaylists,
      stationsCount: importedStations,
    };
  }

  private get STORAGE_KEY_HISTORY(): string {
    return `signal_history_${this.storageUserId}`;
  }

  getLocalHistory(): HistoryItem[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_HISTORY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {}
    return [];
  }

  private saveLocalHistory(list: HistoryItem[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.STORAGE_KEY_HISTORY, JSON.stringify(list.slice(0, 500)));
    } catch {}
  }

  async recordHistoryPlay(track: Track) {
    if (!track || !track.title) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const newItem: HistoryItem = {
      id: Date.now(),
      track_id: track.id,
      track_title: track.title,
      track_artist: track.artist || 'Unknown Artist',
      track_genre: track.genre || 'Music',
      cover_url: track.coverUrl,
      duration: track.duration || 0,
      played_at: nowSec,
    };

    // 1. Всегда надежно сохраняем в локальную историю устройства
    const currentList = this.getLocalHistory();
    // Исключаем дубликаты за последние 3 секунды (защита от дребезга)
    const filtered = currentList.filter(
      (item) => !(item.track_id === track.id && Math.abs(item.played_at - nowSec) < 3)
    );
    filtered.unshift(newItem);
    this.saveLocalHistory(filtered);

    // 2. Если авторизован и бэкенд на связи, синхронизируем с бэкендом
    if (this.isBackendOnline() && this.authService.isAuthenticated()) {
      try {
        await fetch(`${this.getBackendUrl()}/api/history`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.authService.getAuthHeaders(),
          },
          credentials: 'include',
          body: JSON.stringify({
            track_id: track.id,
            title: track.title,
            artist: track.artist,
            genre: track.genre,
            cover_url: track.coverUrl,
            duration: track.duration,
          }),
        });
      } catch {}
    }
  }

  async getHistory(): Promise<HistoryItem[]> {
    const local = this.getLocalHistory();
    if (!this.isBackendOnline() || !this.authService.isAuthenticated()) {
      return local;
    }
    try {
      const res = await fetch(`${this.getBackendUrl()}/api/history`, {
        headers: this.authService.getAuthHeaders(),
        credentials: 'include',
      });
      if (res.ok) {
        const remote: HistoryItem[] = await res.json();
        // Объединяем удаленные и локальные данные
        const map = new Map<string, HistoryItem>();
        for (const item of [...remote, ...local]) {
          const key = `${item.track_id}_${item.played_at}`;
          if (!map.has(key)) {
            map.set(key, item);
          }
        }
        const merged = Array.from(map.values()).sort((a, b) => b.played_at - a.played_at).slice(0, 500);
        this.saveLocalHistory(merged);
        return merged;
      }
    } catch {}
    return local;
  }

  async clearHistory(): Promise<boolean> {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(this.STORAGE_KEY_HISTORY);
      } catch {}
    }
    if (this.isBackendOnline() && this.authService.isAuthenticated()) {
      try {
        await fetch(`${this.getBackendUrl()}/api/history`, {
          method: 'DELETE',
          headers: this.authService.getAuthHeaders(),
          credentials: 'include',
        });
      } catch {}
    }
    return true;
  }

  async getWrappedStats(): Promise<WrappedStats | null> {
    // 1. Пробуем бэкенд для авторизованного пользователя
    if (this.isBackendOnline() && this.authService.isAuthenticated()) {
      try {
        const res = await fetch(`${this.getBackendUrl()}/api/stats/wrapped`, {
          headers: this.authService.getAuthHeaders(),
          credentials: 'include',
        });
        if (res.ok) {
          const stats = await res.json();
          if (stats && stats.total_plays > 0) {
            return stats;
          }
        }
      } catch {}
    }

    // 2. Если бэкенд не вернул данные, рассчитываем Музыкальный итог на клиенте из локальной истории!
    const history = await this.getHistory();
    const username = this.authService.currentUser()?.username || (typeof localStorage !== 'undefined' && localStorage.getItem('signal_custom_username')) || 'Слушатель';

    if (!history || history.length === 0) {
      return {
        username,
        total_plays: 0,
        total_minutes: 0,
        unique_tracks: 0,
        unique_artists: 0,
        top_tracks: [],
        top_artists: [],
        top_genres: [],
        personality: {
          title: 'Исследователь Частот',
          tag: '#EXPLORER',
          description: 'Вы только формируете свой звуковой почерк в экосистеме Recro.',
        },
      };
    }

    const total_plays = history.length;
    const total_duration_secs = history.reduce((acc, h) => acc + (h.duration || 180), 0);
    const total_minutes = Math.round(total_duration_secs / 60);

    const trackCounts = new Map<string, { item: HistoryItem; count: number }>();
    const artistCounts = new Map<string, number>();
    const genreCounts = new Map<string, number>();

    for (const h of history) {
      // Tracks
      const trackKey = h.track_id || `${h.track_artist} - ${h.track_title}`;
      const tEntry = trackCounts.get(trackKey);
      if (tEntry) {
        tEntry.count++;
      } else {
        trackCounts.set(trackKey, { item: h, count: 1 });
      }

      // Artists
      if (h.track_artist && h.track_artist.trim()) {
        const a = h.track_artist.trim();
        artistCounts.set(a, (artistCounts.get(a) || 0) + 1);
      }

      // Genres
      if (h.track_genre && h.track_genre.trim() && h.track_genre.toLowerCase() !== 'unknown') {
        const g = h.track_genre.trim();
        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      }
    }

    const unique_tracks = trackCounts.size;
    const unique_artists = artistCounts.size;

    const top_tracks = Array.from(trackCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(({ item, count }) => ({
        track_id: item.track_id,
        title: item.track_title,
        artist: item.track_artist,
        cover_url: item.cover_url,
        plays: count,
      }));

    const top_artists = Array.from(artistCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([artist, plays]) => ({
        artist,
        plays,
      }));

    const totalGenrePlays = Array.from(genreCounts.values()).reduce((a, b) => a + b, 0);
    const top_genres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genre, plays]) => ({
        genre,
        plays,
        percentage: totalGenrePlays > 0 ? Math.round((plays / totalGenrePlays) * 1000) / 10 : 0,
      }));

    const primaryGenre = (top_genres[0]?.genre || '').toLowerCase();
    let personality = {
      title: 'Исследователь Частот',
      tag: '#EXPLORER',
      description: 'Вы только формируете свой звуковой почерк в экосистеме Recro.',
    };

    if (primaryGenre.includes('electron') || primaryGenre.includes('synth') || primaryGenre.includes('techno')) {
      personality = {
        title: 'Кибер-Архитектор',
        tag: '#CYBER_SOUND',
        description: 'Ваш пульс синхронизирован с синтезаторами и цифровым потоком Recro.',
      };
    } else if (primaryGenre.includes('ambient') || primaryGenre.includes('chill') || primaryGenre.includes('lounge')) {
      personality = {
        title: 'Космический Дрейфующий',
        tag: '#DEEP_DRIFT',
        description: 'Глубокие текстуры и медитативное спокойствие определяют ваше музыкальное поле.',
      };
    } else if (primaryGenre.includes('hip') || primaryGenre.includes('rap') || primaryGenre.includes('trap')) {
      personality = {
        title: 'Ритмический Стратег',
        tag: '#BEAT_DOMINATION',
        description: 'Вы цените панчи, бас и честный флоу без лишних компромиссов.',
      };
    } else if (primaryGenre.includes('rock') || primaryGenre.includes('metal')) {
      personality = {
        title: 'Перегруженный Драйвер',
        tag: '#HIGH_VOLTAGE',
        description: 'Максимальная энергия и чистый драйв звучат в каждом вашем треке.',
      };
    } else if (total_plays > 20) {
      personality = {
        title: 'Аудио-Сингулярность',
        tag: '#INFINITE_AUDIO',
        description: 'Музыка звучит бесконечно, исследуя десятки различных жанров и миров.',
      };
    }

    return {
      username,
      total_plays,
      total_minutes,
      unique_tracks,
      unique_artists,
      top_tracks,
      top_artists,
      top_genres,
      personality,
    };
  }

  async getTopArtists(force = false): Promise<ChartArtist[]> {
    try {
      const url = force
        ? `${this.getBackendUrl()}/api/top-artists?force=true`
        : `${this.getBackendUrl()}/api/top-artists`;
      const res = await fetch(url);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  private readonly STORAGE_KEY_HOME_CACHE = 'recro_cached_home_data';

  getCachedHomeExplore(): HomeExploreData | null {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY_HOME_CACHE);
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  async getHomeExplore(): Promise<HomeExploreData | null> {
    try {
      const res = await fetch(`${this.getBackendUrl()}/api/home`);
      if (!res.ok) return null;
      const data = await res.json();
      const popular_tracks: Track[] = (data.popular_tracks || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        duration: Math.round(item.duration || 0),
        audioUrl: item.audio_url,
        coverUrl: this.formatCoverUrl(item.cover_url),
        genre: 'Top',
        format: 'mp3',
        bitrate: '320 kbps',
        plays: item.plays || 0,
        isFavorite: this.isTrackInLibrary(item.id),
        addedAt: new Date().toISOString().split('T')[0],
      }));

      const popular_albums: ReleaseItem[] = (data.popular_albums || []).map((item: any) => ({
        ...item,
        cover_url: this.formatCoverUrl(item.cover_url),
      }));

      const result: HomeExploreData = {
        ...data,
        popular_tracks,
        popular_albums,
      };

      try {
        localStorage.setItem(this.STORAGE_KEY_HOME_CACHE, JSON.stringify(result));
      } catch {}

      return result;
    } catch {
      return null;
    }
  }

  async getCharts(): Promise<ChartSummary[]> {
    try {
      const res = await fetch(`${this.getBackendUrl()}/api/charts`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async getChartDetail(chartId: string): Promise<ChartDetail | null> {
    try {
      const res = await fetch(`${this.getBackendUrl()}/api/charts/${encodeURIComponent(chartId)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const tracks: Track[] = (data.tracks || []).map((item: any) => ({
        id: item.id,
        title: item.title,
        artist: item.artist,
        duration: Math.round(item.duration || 0),
        audioUrl: item.audio_url,
        coverUrl: this.formatCoverUrl(item.cover_url),
        genre: 'Chart',
        format: 'mp3',
        bitrate: '320 kbps',
        plays: item.plays || 0,
        isFavorite: false,
        addedAt: new Date().toISOString().split('T')[0],
      }));
      return {
        ...data,
        tracks,
      };
    } catch {
      return null;
    }
  }

  isTrackInLibrary(trackId: string): boolean {
    return this.tracks().some((t) => (t.id === trackId || (trackId && t.id.endsWith(trackId))) && !t.playlistOnly);
  }

  toggleTrackInLibrary(track: Track) {
    if (this.isTrackInLibrary(track.id)) {
      this.deleteTrack(track.id);
    } else {
      this.addTrackToLibrary(track);
    }
  }


  async onUserLoggedIn() {
    this.tracks.set([]);
    this.playlists.set([]);
    this.activePlaylistId.set(null);

    // 1. Проверяем наличие треков, добавленных до авторизации (в гостевом режиме)
    let guestTracks: Track[] = [];
    let guestPlaylists: Playlist[] = [];
    let guestFavs: string[] = [];
    try {
      const gTr = localStorage.getItem('signal_tracks_guest') || localStorage.getItem('signal_tracks');
      if (gTr) guestTracks = JSON.parse(gTr);
      const gPl = localStorage.getItem('signal_playlists_guest') || localStorage.getItem('signal_playlists');
      if (gPl) guestPlaylists = JSON.parse(gPl);
      const gFav = localStorage.getItem('signal_favs_guest') || localStorage.getItem('signal_favs');
      if (gFav) guestFavs = JSON.parse(gFav);
    } catch {}

    guestTracks = (guestTracks || []).filter((t) => !t.id.startsWith('default-track-'));

    // 2. Загружаем локальный кэш вошедшего пользователя
    this.initLibrary();

    // 3. Если были гостевые треки, мигрируем их в профиль пользователя
    if (guestTracks.length > 0) {
      const existingIds = new Set(this.tracks().map((t) => t.id));
      const existingUrls = new Set(this.tracks().map((t) => t.audioUrl));
      const toAdd = guestTracks
        .filter((t) => !existingIds.has(t.id) && !existingUrls.has(t.audioUrl))
        .map((t) => ({ ...t, isFavorite: guestFavs.includes(t.id) || t.isFavorite }));

      if (toAdd.length > 0) {
        this.tracks.update((cur) => [...cur, ...toAdd]);
        this.persistTracks();
      }

      if (guestPlaylists.length > 0) {
        const existingPlIds = new Set(this.playlists().map((p) => p.id));
        const plToAdd = guestPlaylists.filter((p) => !existingPlIds.has(p.id));
        if (plToAdd.length > 0) {
          this.playlists.update((cur) => [...cur, ...plToAdd]);
          this.persistPlaylists();
        }
      }
    }

    // 4. Очищаем гостевой кэш, чтобы при выходе из аккаунта музыка не оставалась
    try {
      localStorage.removeItem('signal_tracks_guest');
      localStorage.removeItem('signal_tracks');
      localStorage.removeItem('signal_favs_guest');
      localStorage.removeItem('signal_favs');
      localStorage.removeItem('signal_playlists_guest');
      localStorage.removeItem('signal_playlists');
    } catch {}

    // 5. Синхронизируем с облачной базой данных
    await this.syncWithBackendOnStartup(true);

    // 6. Если появились новые треки, сохраняем в облако
    if (this.tracks().length > 0) {
      await this.pushLibraryToBackend();
    }
  }

  onUserLoggedOut() {
    this.tracks.set([]);
    this.playlists.set([]);
    this.activePlaylistId.set(null);
    this.radioStations.set([...this.defaultRadioStations]);
    this.isCloudSynced.set(false);

    try {
      localStorage.removeItem('signal_tracks_guest');
      localStorage.removeItem('signal_tracks');
      localStorage.removeItem('signal_favs_guest');
      localStorage.removeItem('signal_favs');
      localStorage.removeItem('signal_playlists_guest');
      localStorage.removeItem('signal_playlists');
    } catch {}
  }
}
