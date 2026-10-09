import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { AudioService } from './audio.service';
import { LibraryService } from './library.service';
import { AuthService } from './auth.service';

export interface BadgeItem {
  id: string;
  name: string;
  desc: string;
  code: string;
  target: number;
  current: number;
  unlocked: boolean;
  claimed: boolean;
  equipped: boolean;
  unit: string;
}

export interface ProfileStatsSummary {
  hoursTotal: number;
  timeText: string;
  totalSeconds: number;
  completedPlays: number;
  nightPlays: number;
  noSkipStreak: number;
  maxNoSkipStreak: number;
  totalSavedTracks: number;
  uniqueArtists: number;
}

@Injectable({
  providedIn: 'root',
})
export class ProfileStatsService {
  private audioService = inject(AudioService);
  private libraryService = inject(LibraryService);
  private authService = inject(AuthService);

  // v2: Честная IRL телеметрия со сбросом старых моковых данных в 0
  private readonly STORAGE_STATS_KEY = 'recro_stats_v2_irl_';
  private readonly STORAGE_BADGES_KEY = 'recro_badges_v2_irl_';

  // Counters
  readonly totalListeningSeconds = signal<number>(0);
  readonly completedTracksCount = signal<number>(0);
  readonly nightTracksCount = signal<number>(0);
  readonly currentNoSkipStreak = signal<number>(0);
  readonly maxNoSkipStreak = signal<number>(0);

  // Claimed & equipped badges
  readonly claimedBadges = signal<string[]>([]);
  readonly equippedBadges = signal<string[]>([]);

  // Pinned playlists IDs
  readonly pinnedPlaylistIds = signal<string[]>([]);

  private lastTrackId: string | null = null;
  private hasTrackCompletedThisPlay = false;
  private lastObservedCurrentTime = -1;
  private lastObservedTimestamp = 0;

  constructor() {
    this.loadState();
    this.startLiveTracking();

    // Cross-device auto sync: реагируем на обновление пользователя с бэкенда (телефон / браузер)
    effect(() => {
      const u = this.authService.currentUser();
      if (u) {
        this.hydrateFromProfileData();
      }
    });

    // Автоматическое отслеживание смены трека для честной серии без скипов
    effect(() => {
      const curTrack = this.audioService.currentTrack();
      this.handleTrackChanged(curTrack?.id || null);
    });
  }

  private getUserId(): string {
    return this.authService.currentUser()?.id || 'guest';
  }

  loadState() {
    if (typeof localStorage === 'undefined') return;
    const uid = this.getUserId();

    // 1. Try local storage v2
    try {
      const savedStats = localStorage.getItem(`${this.STORAGE_STATS_KEY}${uid}`);
      if (savedStats) {
        const parsed = JSON.parse(savedStats);
        if (parsed && parsed.v === 2) {
          this.totalListeningSeconds.set(parsed.totalSeconds || 0);
          this.completedTracksCount.set(parsed.completedTracks || 0);
          this.nightTracksCount.set(parsed.nightTracks || 0);
          this.currentNoSkipStreak.set(parsed.currentStreak || 0);
          this.maxNoSkipStreak.set(parsed.maxStreak || 0);
        }
      }

      const savedBadges = localStorage.getItem(`${this.STORAGE_BADGES_KEY}${uid}`);
      if (savedBadges) {
        const parsed = JSON.parse(savedBadges);
        this.claimedBadges.set(parsed.claimed || []);
        this.equippedBadges.set(parsed.equipped || []);
      }

      const savedPins = localStorage.getItem(`recro_pinned_pl_${uid}`);
      if (savedPins) {
        const parsed = JSON.parse(savedPins);
        if (Array.isArray(parsed)) {
          this.pinnedPlaylistIds.set(parsed);
        }
      }
    } catch {}

    // 2. Hydrate from user profile_tags (cross-device sync with phone/other browser)
    this.hydrateFromProfileData();
  }

  hydrateFromProfileData() {
    const user = this.authService.currentUser();
    if (!user || !user.profile_tags) return;

    try {
      const parsed = JSON.parse(user.profile_tags);
      if (parsed && typeof parsed === 'object') {
        if (parsed.stats && typeof parsed.stats === 'object' && parsed.stats.v === 2) {
          // Merge stats taking higher values so listening on multiple devices accumulates
          if ((parsed.stats.totalSeconds || 0) > this.totalListeningSeconds()) {
            this.totalListeningSeconds.set(parsed.stats.totalSeconds);
          }
          if ((parsed.stats.completedTracks || 0) > this.completedTracksCount()) {
            this.completedTracksCount.set(parsed.stats.completedTracks);
          }
          if ((parsed.stats.nightTracks || 0) > this.nightTracksCount()) {
            this.nightTracksCount.set(parsed.stats.nightTracks);
          }
          if ((parsed.stats.maxStreak || 0) > this.maxNoSkipStreak()) {
            this.maxNoSkipStreak.set(parsed.stats.maxStreak);
          }
        }

        if (parsed.badges && typeof parsed.badges === 'object') {
          if (Array.isArray(parsed.badges.claimed)) {
            this.claimedBadges.set(parsed.badges.claimed);
          }
          if (Array.isArray(parsed.badges.equipped)) {
            this.equippedBadges.set(parsed.badges.equipped);
          }
        }

        if (Array.isArray(parsed.pinnedPlaylists)) {
          this.pinnedPlaylistIds.set(parsed.pinnedPlaylists);
        }
      }
    } catch {}
  }

  saveState() {
    if (typeof localStorage === 'undefined') return;
    const uid = this.getUserId();

    const statsObj = {
      v: 2,
      totalSeconds: this.totalListeningSeconds(),
      completedTracks: this.completedTracksCount(),
      nightTracks: this.nightTracksCount(),
      currentStreak: this.currentNoSkipStreak(),
      maxStreak: this.maxNoSkipStreak(),
    };

    const badgesObj = {
      claimed: this.claimedBadges(),
      equipped: this.equippedBadges(),
    };

    try {
      localStorage.setItem(`${this.STORAGE_STATS_KEY}${uid}`, JSON.stringify(statsObj));
      localStorage.setItem(`${this.STORAGE_BADGES_KEY}${uid}`, JSON.stringify(badgesObj));
      localStorage.setItem(`recro_pinned_pl_${uid}`, JSON.stringify(this.pinnedPlaylistIds()));
    } catch {}

    // Cloud push to account for cross-device synchronization (Phone / Tablet / PC)
    if (this.authService.isAuthenticated()) {
      try {
        let existingMeta: any = {};
        const curTags = this.authService.currentUser()?.profile_tags;
        if (curTags) {
          try {
            existingMeta = JSON.parse(curTags);
          } catch {}
        }

        const mergedPayload = {
          ...existingMeta,
          stats: statsObj,
          badges: badgesObj,
          pinnedPlaylists: this.pinnedPlaylistIds(),
        };

        this.authService.updateProfile(
          { profile_tags: JSON.stringify(mergedPayload) },
          this.libraryService.getBackendUrl()
        );
      } catch {}
    }
  }

  private startLiveTracking() {
    if (typeof window === 'undefined') return;

    window.setInterval(() => {
      const isPlaying = this.audioService.isPlaying();
      const curTime = this.audioService.currentTime();
      const dur = this.audioService.duration();
      const curTrack = this.audioService.currentTrack();

      if (isPlaying && curTrack) {
        const now = Date.now();
        const timeDiff = Math.abs(curTime - this.lastObservedCurrentTime);
        const wallDiff = (now - this.lastObservedTimestamp) / 1000;

        // Честный подсчет в IRL: секунда засчитывается только если аудио реально воспроизводится и двигается
        if (this.lastObservedCurrentTime >= 0 && (timeDiff > 0.1 || (wallDiff >= 0.8 && wallDiff <= 1.5))) {
          this.totalListeningSeconds.update((s) => s + 1);

          // Честное завершение трека в IRL: прослушано не менее 85% длительности (при длине трека > 15с)
          if (dur > 15 && curTime >= dur * 0.85 && !this.hasTrackCompletedThisPlay) {
            this.hasTrackCompletedThisPlay = true;
            this.registerTrackCompleted(curTrack);
          }

          // Периодическое автосохранение раз в 15 реальных секунд прослушивания
          if (this.totalListeningSeconds() % 15 === 0) {
            this.saveState();
          }
        }

        this.lastObservedCurrentTime = curTime;
        this.lastObservedTimestamp = now;
      } else {
        this.lastObservedCurrentTime = -1;
      }
    }, 1000);
  }

  handleTrackChanged(newTrackId: string | null) {
    if (this.lastTrackId && this.lastTrackId !== newTrackId) {
      // Честная серия без скипов: если прошлый трек играл более 7с и был переключен без завершения — сброс серии
      if (!this.hasTrackCompletedThisPlay && this.audioService.currentTime() > 7) {
        this.currentNoSkipStreak.set(0);
        this.saveState();
      }
    }
    this.lastTrackId = newTrackId;
    this.hasTrackCompletedThisPlay = false;
    this.lastObservedCurrentTime = -1;
  }

  private registerTrackCompleted(track: any) {
    this.completedTracksCount.update((c) => c + 1);
    
    // Ночной эфир: только реальное прослушивание в интервале 01:00 — 05:00
    const hour = new Date().getHours();
    if (hour >= 1 && hour < 5) {
      this.nightTracksCount.update((n) => n + 1);
    }

    // Инкремент серии без скипов
    const newStreak = this.currentNoSkipStreak() + 1;
    this.currentNoSkipStreak.set(newStreak);
    if (newStreak > this.maxNoSkipStreak()) {
      this.maxNoSkipStreak.set(newStreak);
    }

    this.saveState();
  }

  // Badges Definitions
  readonly allBadges = computed<BadgeItem[]>(() => {
    const hours = +(this.totalListeningSeconds() / 3600).toFixed(1);
    const completed = this.completedTracksCount();
    const night = this.nightTracksCount();
    const streak = Math.max(this.currentNoSkipStreak(), this.maxNoSkipStreak());
    const libraryTracks = this.libraryService.tracks().length;

    const claimed = this.claimedBadges();
    const equipped = this.equippedBadges();

    const defs = [
      {
        id: 'endurance',
        name: 'Марафонец',
        desc: '100 часов суммарного времени в эфире',
        code: '100H',
        target: 100,
        current: Math.min(100, hours),
        unit: 'ч.',
      },
      {
        id: 'midnight',
        name: 'Ночной эфир',
        desc: '50 треков в промежутке 01:00 — 05:00',
        code: '01-05',
        target: 50,
        current: Math.min(50, night),
        unit: 'тр.',
      },
      {
        id: 'perfectionist',
        name: 'Перфекционист',
        desc: '30 треков подряд от начала и до конца без скипов',
        code: '30X',
        target: 30,
        current: Math.min(30, streak),
        unit: 'тр.',
      },
      {
        id: 'archivist',
        name: 'Архивариус',
        desc: 'Собрать коллекцию из 200+ треков в медиатеке',
        code: '200+',
        target: 200,
        current: Math.min(200, libraryTracks),
        unit: 'тр.',
      },
      {
        id: 'audiophile',
        name: 'Аудиофил',
        desc: '1 000 полностью завершенных прослушиваний',
        code: '1000',
        target: 1000,
        current: Math.min(1000, completed),
        unit: 'тр.',
      },
    ];

    return defs.map((d) => {
      const unlocked = d.current >= d.target;
      const isClaimed = claimed.includes(d.id);
      const isEquipped = equipped.includes(d.id);

      return {
        ...d,
        unlocked,
        claimed: isClaimed,
        equipped: isEquipped,
      };
    });
  });

  readonly unlockedCount = computed<number>(() => {
    return this.allBadges().filter((b) => b.unlocked).length;
  });

  readonly claimedCount = computed<number>(() => {
    return this.allBadges().filter((b) => b.claimed).length;
  });

  claimBadge(badgeId: string) {
    const b = this.allBadges().find((item) => item.id === badgeId);
    if (!b || !b.unlocked) return;

    if (!this.claimedBadges().includes(badgeId)) {
      this.claimedBadges.update((list) => [...list, badgeId]);
      // Auto-equip if less than 3 equipped
      if (this.equippedBadges().length < 3) {
        this.equippedBadges.update((list) => [...list, badgeId]);
      }
      this.saveState();
    }
  }

  toggleEquipBadge(badgeId: string) {
    if (!this.claimedBadges().includes(badgeId)) return;

    const currentEquipped = this.equippedBadges();
    if (currentEquipped.includes(badgeId)) {
      this.equippedBadges.set(currentEquipped.filter((id) => id !== badgeId));
    } else {
      if (currentEquipped.length >= 3) {
        // Replace oldest
        this.equippedBadges.set([...currentEquipped.slice(1), badgeId]);
      } else {
        this.equippedBadges.set([...currentEquipped, badgeId]);
      }
    }
    this.saveState();
  }

  togglePinPlaylist(playlistId: string) {
    const pins = this.pinnedPlaylistIds();
    if (pins.includes(playlistId)) {
      this.pinnedPlaylistIds.set(pins.filter((id) => id !== playlistId));
    } else {
      this.pinnedPlaylistIds.set([...pins, playlistId]);
    }
    this.saveState();
  }

  isPlaylistPinned(playlistId: string): boolean {
    return this.pinnedPlaylistIds().includes(playlistId);
  }

  // Summary stats
  readonly statsSummary = computed<ProfileStatsSummary>(() => {
    const totalSec = this.totalListeningSeconds();
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    let timeText = '0с';
    if (hours > 0) {
      timeText = `${hours}ч ${mins}м`;
    } else if (mins > 0) {
      timeText = `${mins}м ${secs}с`;
    } else {
      timeText = `${secs}с`;
    }

    const completed = this.completedTracksCount();
    const night = this.nightTracksCount();
    const streak = this.currentNoSkipStreak();
    const tracksList = this.libraryService.tracks();
    const totalTracks = tracksList.length;

    // Artists count
    const artists = new Set(
      tracksList
        .map((t) => (t && t.artist ? t.artist.trim().toLowerCase() : ''))
        .filter(Boolean)
    );

    return {
      hoursTotal: +(totalSec / 3600).toFixed(1),
      timeText,
      totalSeconds: totalSec,
      completedPlays: completed,
      nightPlays: night,
      noSkipStreak: streak,
      maxNoSkipStreak: this.maxNoSkipStreak(),
      totalSavedTracks: totalTracks,
      uniqueArtists: artists.size,
    };
  });
}
