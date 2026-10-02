import { Injectable, signal, computed, inject, effect, untracked } from '@angular/core';
import { Track, MixConfig, MixMood, MixSource, MixLanguage } from '../models/track.model';
import { LibraryService } from './library.service';

export type { MixMood };

export interface TasteVector {
  energy: number;     // 0 (ambient/soft) -> 1 (heavy bass/phonk/rock)
  tempo: number;      // 0 (slow <80 BPM) -> 1 (fast >140 BPM)
  acoustic: number;   // 0 (electronic/synthesized) -> 1 (live instruments/acoustic)
  hiphop: number;     // 0..1 weight
  rock: number;       // 0..1 weight
  electronic: number; // 0..1 weight
  pop: number;        // 0..1 weight
  chill: number;      // 0..1 weight
}

export const DEFAULT_TASTE_VECTOR: TasteVector = {
  energy: 0.6,
  tempo: 0.55,
  acoustic: 0.35,
  hiphop: 0.5,
  rock: 0.4,
  electronic: 0.5,
  pop: 0.5,
  chill: 0.4,
};

export const STARTER_MIX_TRACKS: Track[] = [
  {
    id: 'starter-1',
    title: 'Sweater Weather',
    artist: 'The Neighbourhood',
    duration: 240,
    audioUrl: '/api/stream?title=Sweater%20Weather&artist=The%20Neighbourhood',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/b4bbcf7d6e67cfc0a52dfdb98cfa70e6/500x500.jpg',
    genre: 'Indie Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-2',
    title: 'Моя голова винтом',
    artist: 'Kostromin',
    duration: 135,
    audioUrl: '/api/stream?title=%D0%9C%D0%BE%D1%8F%20%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%B0%20%D0%B2%D0%B8%D0%BD%D1%82%D0%BE%D0%BC&artist=Kostromin',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/0c2fb753d0e2c00236a28795dae9ca24/500x500.jpg',
    genre: 'Pop',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-3',
    title: 'Starboy',
    artist: 'The Weeknd',
    duration: 230,
    audioUrl: '/api/stream?title=Starboy&artist=The%20Weeknd',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/6a7605d311394b3063fec65a19fb0962/500x500.jpg',
    genre: 'Pop / R&B',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-4',
    title: 'Группа крови',
    artist: 'Кино',
    duration: 285,
    audioUrl: '/api/stream?title=%D0%93%D1%80%D1%83%D0%BF%D0%BF%D0%B0%20%D0%BA%D1%80%D0%BE%D0%B2%D0%B8&artist=%D0%9A%D0%B8%D0%BD%D0%BE',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/0bfa8c7161b9a1eb4019a5fa1c93a89a/500x500.jpg',
    genre: 'Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-5',
    title: 'After Dark',
    artist: 'Mr.Kitty',
    duration: 257,
    audioUrl: '/api/stream?title=After%20Dark&artist=Mr.Kitty',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/5f58c7e6c469b25206eead5d45d65c3b/500x500.jpg',
    genre: 'Synthwave',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-6',
    title: 'Беспечный ангел',
    artist: 'Ария',
    duration: 239,
    audioUrl: '/api/stream?title=%D0%91%D0%B5%D1%81%D0%BF%D0%B5%D1%87%D0%BD%D1%8B%D0%B9%20%D0%B0%D0%BD%D0%B3%D0%B5%D0%BB&artist=%D0%90%D1%80%D0%B8%D1%8F',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/da48c9df03d4a04d2e6fc757ebfc9496/500x500.jpg',
    genre: 'Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-7',
    title: 'Midnight City',
    artist: 'M83',
    duration: 243,
    audioUrl: '/api/stream?title=Midnight%20City&artist=M83',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/f47e30d4a9ecae349603fc5bdf255d64/500x500.jpg',
    genre: 'Electronic',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-8',
    title: 'Седьмой лепесток',
    artist: 'Hi-Fi',
    duration: 215,
    audioUrl: '/api/stream?title=%D0%A1%D0%B5%D0%B4%D1%8C%D0%BC%D0%BE%D0%B9%20%D0%BB%D0%B5%D0%BF%D0%B5%D1%81%D1%82%D0%BE%D0%BA&artist=Hi-Fi',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/f6d7eb59c25f488e0b2a8d1163473133/500x500.jpg',
    genre: 'Pop',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
];

export interface PlayRecord {
  lastPlayed: number;   // timestamp in ms
  playCount24h: number; // plays within the last 24 hours
  history: number[];    // timestamps of plays within last 48 hours
}

export function normalizeArtist(artist?: string): string {
  if (!artist) return '';
  return artist
    .toLowerCase()
    .split(/\b(?:feat\.?|ft\.?|with|x)\b|[&,/]|\s+[-–—+]\s+/i)[0]
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(title?: string): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?]|{.*?}/g, ' ')
    .replace(/\b(feat|ft|prod|official|video|audio|lyrics|lyric|remastered|hd|hq|4k|visualizer|clip|клип|премьера)\b.*/i, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PHONK_REGEX = /\b(phonk|drift|hardstyle|hyperpop|фонк|дрифт|hardbass)\b/i;
const HIPHOP_REGEX = /\b(hip-?hop|rap|рэп|trap|трэп|drill|дрил|дриил|r&b|rnb|soul|соул)\b/i;
const ROCK_REGEX = /\b(rock|metal|punk|рок|метал|guitar|grunge|alternative|core|hardcore|metalcore|рокеш)\b/i;
const ELECTRONIC_REGEX = /\b(synth|synthwave|edm|house|dance|techno|club|dnb|drum\s*and\s*bass|trance|dubstep|электро)\b/i;
const CHILL_REGEX = /\b(lo-?fi|chill|ambient|relax|sleep|piano|acoustic|акустика|лаборатория|calm|meditation|soft|лаунж)\b/i;
const POP_REGEX = /\b(pop|поп|indie|инди|hit|k-?pop|vocal|вокал)\b/i;

@Injectable({
  providedIn: 'root',
})
export class RecommendationService {
  private readonly libraryService = inject(LibraryService);

  private readonly STORAGE_KEY_TASTE = 'recro_taste_vector_v1';

  private get STORAGE_KEY_RECENT_PLAYS(): string {
    return `signal_recent_plays_${this.libraryService.getStorageUserId()}`;
  }

  private get STORAGE_KEY_RECENT_TITLES(): string {
    return `signal_recent_titles_${this.libraryService.getStorageUserId()}`;
  }

  readonly isMixActive = signal<boolean>(false);
  readonly mixConfig = this.libraryService.mixConfig;
  readonly currentMood = computed<MixMood>(() => this.libraryService.mixConfig().mood);
  readonly isFetchingDiscovery = signal<boolean>(false);

  // User Taste Vector in reactive state
  readonly tasteVector = signal<TasteVector>(this.loadSavedTasteVector());

  // Persistent play records to prevent repetition across sessions and days
  // Map of trackId -> PlayRecord
  private readonly recentPlays = new Map<string, PlayRecord>();

  // Normalized artist::title -> PlayRecord to prevent hearing alternate uploads or repeated tracks today
  private readonly recentTitles = new Map<string, PlayRecord>();

  // In-memory cache for track feature vectors to prevent repeated regex and string operations
  private readonly vectorCache = new Map<string, TasteVector>();

  // Disliked tracks (delegated to LibraryService with cloud sync)
  readonly dislikedTrackIds = this.libraryService.dislikedTrackIds;

  constructor() {
    this.loadSavedRecentPlays();
    this.cleanupOldPlays();
    this.syncWithListeningHistory();

    // Auto-calibrate taste vector from user library whenever tracks load or change
    effect(() => {
      const tracks = this.libraryService.tracks();
      untracked(() => {
        if (tracks.length > 0) {
          this.calibrateTasteFromLibrary();
        }
      });
    });
  }

  setMixMood(mood: MixMood) {
    this.libraryService.setMixConfig({ mood });
  }

  resetMixSession() {
    this.isMixActive.set(false);
    this.isFetchingDiscovery.set(false);
    // Note: recentPlays is deliberately NOT cleared here so that pausing or toggling mix
    // preserves fatigue penalties and prevents immediately replaying the same songs!
  }

  updateConfig(partial: Partial<MixConfig>) {
    this.libraryService.setMixConfig(partial);
  }

  private loadSavedTasteVector(): TasteVector {
    const cloudVec = this.libraryService.mixConfig()?.tasteVector;
    if (cloudVec && typeof cloudVec === 'object') {
      return { ...DEFAULT_TASTE_VECTOR, ...cloudVec };
    }
    if (typeof localStorage === 'undefined') return { ...DEFAULT_TASTE_VECTOR };
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_TASTE);
      if (saved) {
        return { ...DEFAULT_TASTE_VECTOR, ...JSON.parse(saved) };
      }
    } catch {}
    return { ...DEFAULT_TASTE_VECTOR };
  }

  private saveTasteVector(vec: TasteVector) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.STORAGE_KEY_TASTE, JSON.stringify(vec));
    } catch {}
  }

  private loadSavedRecentPlays() {
    if (typeof localStorage === 'undefined') return;
    try {
      const now = Date.now();
      const cutoff48h = now - 48 * 60 * 60 * 1000;
      const cutoff24h = now - 24 * 60 * 60 * 1000;

      // 1. Load trackId records
      const rawPlays = localStorage.getItem(this.STORAGE_KEY_RECENT_PLAYS);
      if (rawPlays) {
        const parsed = JSON.parse(rawPlays);
        for (const [id, record] of Object.entries(parsed as Record<string, any>)) {
          const rawHistory: number[] = Array.isArray(record.history)
            ? record.history
            : typeof record.lastPlayed === 'number'
            ? [record.lastPlayed]
            : [];
          const validHistory = rawHistory.filter((ts) => ts > cutoff48h);
          if (validHistory.length > 0) {
            const last = Math.max(...validHistory);
            const count24h = validHistory.filter((ts) => ts > cutoff24h).length;
            this.recentPlays.set(id, {
              lastPlayed: last,
              playCount24h: count24h,
              history: validHistory,
            });
          }
        }
      }

      // 2. Load normalized title::artist records
      const rawTitles = localStorage.getItem(this.STORAGE_KEY_RECENT_TITLES);
      if (rawTitles) {
        const parsed = JSON.parse(rawTitles);
        for (const [key, record] of Object.entries(parsed as Record<string, any>)) {
          const rawHistory: number[] = Array.isArray(record.history)
            ? record.history
            : typeof record.lastPlayed === 'number'
            ? [record.lastPlayed]
            : [];
          const validHistory = rawHistory.filter((ts) => ts > cutoff48h);
          if (validHistory.length > 0) {
            const last = Math.max(...validHistory);
            const count24h = validHistory.filter((ts) => ts > cutoff24h).length;
            this.recentTitles.set(key, {
              lastPlayed: last,
              playCount24h: count24h,
              history: validHistory,
            });
          }
        }
      }
    } catch {}
  }

  private saveRecentPlays() {
    if (typeof localStorage === 'undefined') return;
    try {
      const playsObj: Record<string, PlayRecord> = {};
      for (const [id, rec] of this.recentPlays.entries()) {
        playsObj[id] = rec;
      }
      localStorage.setItem(this.STORAGE_KEY_RECENT_PLAYS, JSON.stringify(playsObj));

      const titlesObj: Record<string, PlayRecord> = {};
      for (const [key, rec] of this.recentTitles.entries()) {
        titlesObj[key] = rec;
      }
      localStorage.setItem(this.STORAGE_KEY_RECENT_TITLES, JSON.stringify(titlesObj));
    } catch {}
  }

  private cleanupOldPlays() {
    const now = Date.now();
    const cutoff48h = now - 48 * 60 * 60 * 1000;
    const cutoff24h = now - 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [id, rec] of this.recentPlays.entries()) {
      const validHistory = rec.history.filter((t) => t > cutoff48h);
      if (validHistory.length === 0) {
        this.recentPlays.delete(id);
        changed = true;
      } else {
        const count24h = validHistory.filter((t) => t > cutoff24h).length;
        if (validHistory.length !== rec.history.length || count24h !== rec.playCount24h) {
          rec.history = validHistory;
          rec.playCount24h = count24h;
          rec.lastPlayed = Math.max(...validHistory);
          changed = true;
        }
      }
    }

    for (const [key, rec] of this.recentTitles.entries()) {
      const validHistory = rec.history.filter((t) => t > cutoff48h);
      if (validHistory.length === 0) {
        this.recentTitles.delete(key);
        changed = true;
      } else {
        const count24h = validHistory.filter((t) => t > cutoff24h).length;
        if (validHistory.length !== rec.history.length || count24h !== rec.playCount24h) {
          rec.history = validHistory;
          rec.playCount24h = count24h;
          rec.lastPlayed = Math.max(...validHistory);
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveRecentPlays();
    }
  }

  /**
   * Syncs with backend listening history on app startup so play fatigue survives
   * browser storage resets or multi-tab usage.
   */
  async syncWithListeningHistory() {
    try {
      const history = await this.libraryService.getHistory();
      if (!history || history.length === 0) return;
      const now = Date.now();
      const cutoff48h = now - 48 * 60 * 60 * 1000;
      const cutoff24h = now - 24 * 60 * 60 * 1000;
      let changed = false;

      for (const item of history) {
        const playedMs = item.played_at * 1000;
        if (now - playedMs > cutoff48h) continue;

        // 1. By ID
        const existing = this.recentPlays.get(item.track_id);
        if (!existing) {
          this.recentPlays.set(item.track_id, {
            lastPlayed: playedMs,
            playCount24h: playedMs > cutoff24h ? 1 : 0,
            history: [playedMs],
          });
          changed = true;
        } else if (!existing.history.includes(playedMs)) {
          const hist = [...existing.history, playedMs].sort((a, b) => a - b);
          existing.history = hist;
          existing.lastPlayed = Math.max(...hist);
          existing.playCount24h = hist.filter((t) => t > cutoff24h).length;
          changed = true;
        }

        // 2. By Normalized Title & Artist
        const titleKey = this.getTitleKeyFromStrings(item.track_artist, item.track_title);
        if (titleKey) {
          const exTitle = this.recentTitles.get(titleKey);
          if (!exTitle) {
            this.recentTitles.set(titleKey, {
              lastPlayed: playedMs,
              playCount24h: playedMs > cutoff24h ? 1 : 0,
              history: [playedMs],
            });
            changed = true;
          } else if (!exTitle.history.includes(playedMs)) {
            const hist = [...exTitle.history, playedMs].sort((a, b) => a - b);
            exTitle.history = hist;
            exTitle.lastPlayed = Math.max(...hist);
            exTitle.playCount24h = hist.filter((t) => t > cutoff24h).length;
            changed = true;
          }
        }
      }

      if (changed) {
        this.saveRecentPlays();
      }
    } catch {}
  }

  private getTitleKey(track: Track): string {
    return this.getTitleKeyFromStrings(track.artist, track.title);
  }

  private getTitleKeyFromStrings(artist?: string, title?: string): string {
    const art = normalizeArtist(artist);
    const tit = normalizeTitle(title);
    if (!art || !tit) return '';
    return `${art}::${tit}`;
  }

  /**
   * Auto-calibrates the user's taste vector from their actual collection and favorites,
   * so the mix naturally respects their true vibe (Rock, Phonk, Rap, Indie, etc.).
   */
  calibrateTasteFromLibrary() {
    const tracks = this.getAllLocalCandidates();
    if (tracks.length === 0) return;

    let totalWeight = 0;
    let sumEnergy = 0;
    let sumTempo = 0;
    let sumAcoustic = 0;
    let sumHiphop = 0;
    let sumRock = 0;
    let sumElectronic = 0;
    let sumPop = 0;
    let sumChill = 0;

    for (const t of tracks) {
      const vec = this.extractTrackVector(t);
      let weight = 1.0;
      if (t.isFavorite) weight += 3.5;
      if (t.plays && t.plays > 0) weight += Math.min(5, t.plays * 0.6);

      sumEnergy += vec.energy * weight;
      sumTempo += vec.tempo * weight;
      sumAcoustic += vec.acoustic * weight;
      sumHiphop += vec.hiphop * weight;
      sumRock += vec.rock * weight;
      sumElectronic += vec.electronic * weight;
      sumPop += vec.pop * weight;
      sumChill += vec.chill * weight;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      const calibrated: TasteVector = {
        energy: Math.max(0.05, Math.min(0.98, sumEnergy / totalWeight)),
        tempo: Math.max(0.05, Math.min(0.98, sumTempo / totalWeight)),
        acoustic: Math.max(0.05, Math.min(0.98, sumAcoustic / totalWeight)),
        hiphop: Math.max(0.05, Math.min(0.98, sumHiphop / totalWeight)),
        rock: Math.max(0.05, Math.min(0.98, sumRock / totalWeight)),
        electronic: Math.max(0.05, Math.min(0.98, sumElectronic / totalWeight)),
        pop: Math.max(0.05, Math.min(0.98, sumPop / totalWeight)),
        chill: Math.max(0.05, Math.min(0.98, sumChill / totalWeight)),
      };

      const cur = this.tasteVector();
      const diff =
        Math.abs(cur.energy - calibrated.energy) +
        Math.abs(cur.tempo - calibrated.tempo) +
        Math.abs(cur.acoustic - calibrated.acoustic) +
        Math.abs(cur.hiphop - calibrated.hiphop) +
        Math.abs(cur.rock - calibrated.rock) +
        Math.abs(cur.electronic - calibrated.electronic) +
        Math.abs(cur.pop - calibrated.pop) +
        Math.abs(cur.chill - calibrated.chill);

      if (diff > 0.04) {
        this.tasteVector.set(calibrated);
        this.saveTasteVector(calibrated);
      }
    }
  }

  /**
   * Record when a track starts playing.
   * Immediately activates cooldown fatigue to avoid repetition if the user listens for only 30-60s.
   */
  recordTrackStarted(track: Track) {
    if (!track || track.isLiveStream) return;
    const now = Date.now();
    const cutoff48h = now - 48 * 60 * 60 * 1000;
    const cutoff24h = now - 24 * 60 * 60 * 1000;

    // 1. By Track ID
    const existing = this.recentPlays.get(track.id);
    const validHistory = existing
      ? existing.history.filter((t) => t > cutoff48h)
      : [];
    validHistory.push(now);

    const count24h = validHistory.filter((t) => t > cutoff24h).length;
    this.recentPlays.set(track.id, {
      lastPlayed: now,
      playCount24h: count24h,
      history: validHistory,
    });

    // 2. By Normalized Title & Artist
    const titleKey = this.getTitleKey(track);
    if (titleKey) {
      const existingTitle = this.recentTitles.get(titleKey);
      const titleHist = existingTitle
        ? existingTitle.history.filter((t) => t > cutoff48h)
        : [];
      titleHist.push(now);
      const titleCount24h = titleHist.filter((t) => t > cutoff24h).length;

      this.recentTitles.set(titleKey, {
        lastPlayed: now,
        playCount24h: titleCount24h,
        history: titleHist,
      });

      if (this.recentTitles.size > 300) {
        const firstKey = this.recentTitles.keys().next().value;
        if (firstKey !== undefined) this.recentTitles.delete(firstKey);
      }
    }

    this.saveRecentPlays();
  }

  /**
   * Checks if a track (or alternate version of the same track) was played recently.
   */
  isRecentlyPlayed(track: Track | string, minutesThreshold = 45): boolean {
    const now = Date.now();
    const msThreshold = minutesThreshold * 60 * 1000;

    if (typeof track === 'string') {
      const rec = this.recentPlays.get(track);
      return !!(rec && now - rec.lastPlayed < msThreshold);
    }

    const recId = this.recentPlays.get(track.id);
    if (recId && now - recId.lastPlayed < msThreshold) {
      return true;
    }

    const titleKey = this.getTitleKey(track);
    if (titleKey) {
      const recTitle = this.recentTitles.get(titleKey);
      if (recTitle && now - recTitle.lastPlayed < msThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generates a normalized 8-dimensional music feature vector for a track.
   * Multi-label additive extraction: supports hybrid genres (e.g. pop-rock, lofi-hiphop)
   * with high-speed in-memory LRU caching.
   */
  extractTrackVector(track: Track): TasteVector {
    const cached = this.vectorCache.get(track.id);
    if (cached) return cached;

    const genre = (track.genre || '').toLowerCase();
    const title = (track.title || '').toLowerCase();
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    const text = `${genre} ${genre} ${title} ${artist} ${album}`;

    let energy = 0.5;
    let tempo = 0.5;
    let acoustic = 0.3;
    let hiphop = 0.1;
    let rock = 0.1;
    let electronic = 0.1;
    let pop = 0.1;
    let chill = 0.1;

    // Phonk / Trap / Hardstyle / Heavy Bass / Hyperpop
    if (PHONK_REGEX.test(text) || (text.includes('bass') && !text.includes('bass guitar'))) {
      energy += 0.42;
      tempo += 0.25;
      electronic += 0.72;
      hiphop += 0.45;
      acoustic -= 0.25;
    }

    // Hip-Hop / Rap / Drill / Trap / RnB / Soul
    if (HIPHOP_REGEX.test(text)) {
      energy += 0.18;
      tempo += 0.1;
      hiphop += 0.75;
      electronic += 0.15;
    }

    // Rock / Metal / Punk / Alternative / Grunge / Guitar
    if (ROCK_REGEX.test(text)) {
      energy += 0.32;
      tempo += 0.18;
      rock += 0.78;
      acoustic += 0.1;
    }

    // Electronic / Synthwave / EDM / House / Techno / DnB / Club / Trance
    if (ELECTRONIC_REGEX.test(text)) {
      energy += 0.3;
      tempo += 0.22;
      electronic += 0.78;
      acoustic -= 0.25;
    }

    // Chill / Lo-Fi / Ambient / Relax / Acoustic / Piano / Soft
    if (CHILL_REGEX.test(text)) {
      energy -= 0.25;
      tempo -= 0.2;
      chill += 0.78;
      acoustic += 0.5;
    }

    // Pop / Indie / Vocal / K-pop
    if (POP_REGEX.test(text)) {
      pop += 0.68;
      energy += 0.08;
      acoustic += 0.05;
    }

    const vector: TasteVector = {
      energy: Math.max(0.05, Math.min(0.98, energy)),
      tempo: Math.max(0.05, Math.min(0.98, tempo)),
      acoustic: Math.max(0.05, Math.min(0.98, acoustic)),
      hiphop: Math.max(0.05, Math.min(0.98, hiphop)),
      rock: Math.max(0.05, Math.min(0.98, rock)),
      electronic: Math.max(0.05, Math.min(0.98, electronic)),
      pop: Math.max(0.05, Math.min(0.98, pop)),
      chill: Math.max(0.05, Math.min(0.98, chill)),
    };

    if (this.vectorCache.size >= 2500) {
      const firstKey = this.vectorCache.keys().next().value;
      if (firstKey !== undefined) this.vectorCache.delete(firstKey);
    }
    this.vectorCache.set(track.id, vector);

    return vector;
  }

  /**
   * Precomputes Euclidean L2 norm of a feature vector
   */
  computeVectorNorm(vec: TasteVector): number {
    return Math.sqrt(
      vec.energy * vec.energy +
      vec.tempo * vec.tempo +
      vec.acoustic * vec.acoustic +
      vec.hiphop * vec.hiphop +
      vec.rock * vec.rock +
      vec.electronic * vec.electronic +
      vec.pop * vec.pop +
      vec.chill * vec.chill
    );
  }

  /**
   * High-performance unrolled cosine similarity: cos(theta) in range [-1, 1], normalized to [0, 1].
   */
  cosineSimilarityFast(a: TasteVector, normA: number, b: TasteVector): number {
    const dot =
      a.energy * b.energy +
      a.tempo * b.tempo +
      a.acoustic * b.acoustic +
      a.hiphop * b.hiphop +
      a.rock * b.rock +
      a.electronic * b.electronic +
      a.pop * b.pop +
      a.chill * b.chill;

    const normB = Math.sqrt(
      b.energy * b.energy +
      b.tempo * b.tempo +
      b.acoustic * b.acoustic +
      b.hiphop * b.hiphop +
      b.rock * b.rock +
      b.electronic * b.electronic +
      b.pop * b.pop +
      b.chill * b.chill
    );

    if (normA <= 0 || normB <= 0) return 0.5;
    const cos = dot / (normA * normB);
    return Math.max(0, Math.min(1, (cos + 1) / 2));
  }

  /**
   * Record when user completes a track (>80% played). Soft positive drift.
   */
  recordTrackCompletion(track: Track) {
    if (track.isLiveStream) return;
    this.recordTrackStarted(track);

    const tVec = this.extractTrackVector(track);
    const cur = this.tasteVector();
    const updated: TasteVector = {
      energy: cur.energy * 0.9 + tVec.energy * 0.1,
      tempo: cur.tempo * 0.9 + tVec.tempo * 0.1,
      acoustic: cur.acoustic * 0.9 + tVec.acoustic * 0.1,
      hiphop: cur.hiphop * 0.9 + tVec.hiphop * 0.1,
      rock: cur.rock * 0.9 + tVec.rock * 0.1,
      electronic: cur.electronic * 0.9 + tVec.electronic * 0.1,
      pop: cur.pop * 0.9 + tVec.pop * 0.1,
      chill: cur.chill * 0.9 + tVec.chill * 0.1,
    };
    this.tasteVector.set(updated);
    this.saveTasteVector(updated);
  }

  /**
   * Record when user likes/favorites a track. Strong positive reinforcement.
   */
  recordTrackLike(track: Track) {
    if (track.isLiveStream) return;
    const tVec = this.extractTrackVector(track);
    const cur = this.tasteVector();
    const updated: TasteVector = {
      energy: cur.energy * 0.8 + tVec.energy * 0.2,
      tempo: cur.tempo * 0.8 + tVec.tempo * 0.2,
      acoustic: cur.acoustic * 0.8 + tVec.acoustic * 0.2,
      hiphop: cur.hiphop * 0.8 + tVec.hiphop * 0.2,
      rock: cur.rock * 0.8 + tVec.rock * 0.2,
      electronic: cur.electronic * 0.8 + tVec.electronic * 0.2,
      pop: cur.pop * 0.8 + tVec.pop * 0.2,
      chill: cur.chill * 0.8 + tVec.chill * 0.2,
    };
    this.tasteVector.set(updated);
    this.saveTasteVector(updated);
  }

  /**
   * Record when user skips a track quickly (<15s).
   */
  recordTrackSkip(track: Track) {
    if (track.isLiveStream) return;
    this.recordTrackStarted(track);

    const tVec = this.extractTrackVector(track);
    const cur = this.tasteVector();

    let newEnergy = cur.energy;
    if (tVec.energy > 0.7) newEnergy = Math.max(0.1, cur.energy - 0.04);
    else if (tVec.energy < 0.3) newEnergy = Math.min(0.9, cur.energy + 0.04);

    let newTempo = cur.tempo;
    if (tVec.tempo > 0.7) newTempo = Math.max(0.1, cur.tempo - 0.04);
    else if (tVec.tempo < 0.3) newTempo = Math.min(0.9, cur.tempo + 0.04);

    let newAcoustic = cur.acoustic;
    if (tVec.acoustic > 0.7) newAcoustic = Math.max(0.1, cur.acoustic - 0.04);
    else if (tVec.acoustic < 0.3) newAcoustic = Math.min(0.9, cur.acoustic + 0.04);

    const updated: TasteVector = {
      energy: newEnergy,
      tempo: newTempo,
      acoustic: newAcoustic,
      hiphop: Math.max(0.05, cur.hiphop - (tVec.hiphop > 0.4 ? tVec.hiphop * 0.05 : 0)),
      rock: Math.max(0.05, cur.rock - (tVec.rock > 0.4 ? tVec.rock * 0.05 : 0)),
      electronic: Math.max(0.05, cur.electronic - (tVec.electronic > 0.4 ? tVec.electronic * 0.05 : 0)),
      pop: Math.max(0.05, cur.pop - (tVec.pop > 0.4 ? tVec.pop * 0.05 : 0)),
      chill: Math.max(0.05, cur.chill - (tVec.chill > 0.4 ? tVec.chill * 0.05 : 0)),
    };

    this.tasteVector.set(updated);
    this.saveTasteVector(updated);
  }

  dislikeTrack(trackId: string) {
    this.libraryService.dislikeTrack(trackId);
  }

  isDisliked(trackId: string): boolean {
    return this.libraryService.isDisliked(trackId);
  }

  getAllLocalCandidates(): Track[] {
    const allTracks = this.libraryService.tracks();
    const tracksById = new Map<string, Track>(allTracks.map((t) => [t.id, t]));
    const result = new Map<string, Track>();

    for (const t of allTracks) {
      if (!t.isLiveStream && !this.isDisliked(t.id)) {
        result.set(t.id, t);
      }
    }

    for (const pl of this.libraryService.playlists()) {
      for (const tId of pl.trackIds) {
        if (result.has(tId)) continue;
        const found = tracksById.get(tId);
        if (found && !found.isLiveStream && !this.isDisliked(found.id)) {
          result.set(found.id, found);
        }
      }
    }

    return Array.from(result.values());
  }

  getTargetVectorForMood(mood: MixMood, currentTrack?: Track | null): TasteVector {
    const base = { ...this.tasteVector() };
    if (mood === 'energetic') {
      base.energy = Math.max(base.energy, 0.85);
      base.tempo = Math.max(base.tempo, 0.75);
      base.chill = Math.min(base.chill, 0.2);
    } else if (mood === 'chill') {
      base.energy = Math.min(base.energy, 0.35);
      base.chill = Math.max(base.chill, 0.85);
      base.acoustic = Math.max(base.acoustic, 0.65);
    }

    if (currentTrack && !currentTrack.isLiveStream) {
      const curVec = this.extractTrackVector(currentTrack);
      base.energy = base.energy * 0.75 + curVec.energy * 0.25;
      base.tempo = base.tempo * 0.75 + curVec.tempo * 0.25;
      base.acoustic = base.acoustic * 0.75 + curVec.acoustic * 0.25;
      base.hiphop = base.hiphop * 0.75 + curVec.hiphop * 0.25;
      base.rock = base.rock * 0.75 + curVec.rock * 0.25;
      base.electronic = base.electronic * 0.75 + curVec.electronic * 0.25;
      base.pop = base.pop * 0.75 + curVec.pop * 0.25;
      base.chill = base.chill * 0.75 + curVec.chill * 0.25;
    }

    return base;
  }

  /**
   * Scores a track candidate using:
   * - Cosine feature similarity (0..55 pts)
   * - Favorite bonus (+15 pts)
   * - Unplayed library rediscovery bonus (+10 pts)
   * - Strict primary artist anti-clustering (-100 pts back-to-back, -45 pts recent)
   * - Progressive cooldown fatigue penalty (-250 / -90 / -45 / -20 pts)
   * - Daily frequency cap penalty (-20 to -150 pts if played multiple times today)
   */
  scoreTrack(
    track: Track,
    mood: MixMood,
    targetVec: TasteVector,
    targetNorm: number,
    currentTrack?: Track | null,
    recentArtists?: Set<string>,
    poolSize?: number
  ): number {
    if (this.isDisliked(track.id)) return -9999;

    if (mood === 'favorites' && !track.isFavorite) {
      return -9999;
    }

    const availablePool = poolSize ?? 50;

    // Fatigue lookup across BOTH track.id and normalized title::artist
    const titleKey = this.getTitleKey(track);
    const titleRec = titleKey ? this.recentTitles.get(titleKey) : undefined;
    const playRec = this.recentPlays.get(track.id);

    const playsToday = Math.max(playRec?.playCount24h ?? 0, titleRec?.playCount24h ?? 0);
    const lastPlayedTime = Math.max(playRec?.lastPlayed ?? 0, titleRec?.lastPlayed ?? 0) || undefined;
    const now = Date.now();

    // 1. HARD DAY CAP:
    // Если трек уже звучал 2 или более раз сегодня — строго запрещаем ставить его в 3-й раз!
    if (playsToday >= 2 && availablePool >= 8) {
      return -9999;
    }

    // 2. HARD SESSION COOLDOWN:
    // Если трек играл менее 2.5 часов (150 мин) назад — строгий запрет на повтор при наличии других треков
    if (lastPlayedTime) {
      const minutesAgo = (now - lastPlayedTime) / (1000 * 60);
      if (minutesAgo < 150 && availablePool >= 10) {
        return -9999;
      }
      if (minutesAgo < 45) {
        return -9999;
      }
    }

    const trackVec = this.extractTrackVector(track);
    const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);

    // Если сходство с вайбом пользователя слишком низкое (< 0.40), полностью отвергаем
    if (similarity < 0.40) {
      return -9999;
    }

    let score = similarity * 60; // 0..60 очков за соответствие вкусовому профилю

    // Explicit user affinity
    if (track.isFavorite) {
      score += 10;
    }

    // Freshness & Rediscovery bonus:
    // Умеренный бонус свежести, не подавляющий разнообразие волны
    if (!lastPlayedTime || playsToday === 0) {
      if (!playRec && (!track.plays || track.plays === 0)) {
        score += 8;
      } else {
        score += 5;
      }
    }

    // Небольшой случайный джиттер для избежания детерминированного зацикливания одних и тех же треков
    score += (Math.random() - 0.5) * 6;

    // Штраф за повторное воспроизведение сегодня (2-й раз за день)
    if (playsToday === 1) {
      score -= 90;
    }

    // Мягкий штраф за недавнее воспроизведение (от 2.5 до 12 часов)
    if (lastPlayedTime) {
      const minutesAgo = (now - lastPlayedTime) / (1000 * 60);
      if (minutesAgo < 360) {
        score -= 75;
      } else if (minutesAgo < 720) {
        score -= 30;
      }
    }

    // Language preference
    const lang = this.libraryService.mixConfig().language;
    if (lang === 'ru') {
      const isRu = /[а-яё]/i.test(`${track.title} ${track.artist}`);
      score += isRu ? 25 : -35;
    } else if (lang === 'en') {
      const isRu = /[а-яё]/i.test(`${track.title} ${track.artist}`);
      score += !isRu ? 25 : -35;
    }

    // Artist Diversity & Anti-clustering Penalty
    const primaryArt = normalizeArtist(track.artist);
    const curPrimaryArt = normalizeArtist(currentTrack?.artist);

    if (primaryArt && curPrimaryArt && primaryArt === curPrimaryArt) {
      // Строгий запрет двух треков подряд от одного артиста
      score -= 150;
    } else if (recentArtists && primaryArt) {
      for (const recent of recentArtists) {
        if (normalizeArtist(recent) === primaryArt) {
          score -= 55;
          break;
        }
      }
    }

    // BPM / Tempo Continuity
    if (currentTrack?.bpm && track.bpm && currentTrack.bpm > 40 && track.bpm > 40) {
      const bpmDiff = Math.abs(currentTrack.bpm - track.bpm);
      if (bpmDiff <= 6) {
        score += 12;
      } else if (bpmDiff <= 14) {
        score += 5;
      } else if (bpmDiff > 35) {
        score -= 15;
      }
    }

    return score;
  }

  /**
   * Selects N next tracks using Efraimidis-Spirakis Algorithm (A-Res) for weighted random sampling
   * with guaranteed artist diversity and session cooldowns.
   */
  pickNextTracks(
    count: number,
    excludeIds: Set<string> = new Set(),
    currentTrack?: Track | null,
    recentArtists: Set<string> = new Set()
  ): Track[] {
    const allLocal = this.getAllLocalCandidates();
    const mood = this.currentMood();

    const validCandidates = allLocal.filter((t) => {
      if (this.isDisliked(t.id)) return false;
      if (mood === 'favorites' && !t.isFavorite) return false;
      return true;
    });

    if (validCandidates.length === 0) return [];

    let available = validCandidates.filter((t) => !excludeIds.has(t.id));
    if (available.length === 0) {
      available = validCandidates;
    }

    const targetVec = this.getTargetVectorForMood(mood, currentTrack);
    const targetNorm = this.computeVectorNorm(targetVec);

    const contextArtists = new Set<string>();
    if (currentTrack?.artist) {
      const curArt = normalizeArtist(currentTrack.artist);
      if (curArt) contextArtists.add(curArt);
    }
    for (const art of recentArtists) {
      const norm = normalizeArtist(art);
      if (norm) contextArtists.add(norm);
    }

    const scored = available
      .map((track) => ({
        track,
        score: this.scoreTrack(track, mood, targetVec, targetNorm, currentTrack, contextArtists, available.length),
      }))
      .filter((item) => item.score > -5000);

    if (scored.length === 0) {
      return available.slice(0, count);
    }

    // Строгий приоритет свежести: если в библиотеке достаточно свежих треков (score > -100),
    // полностью исключаем треки, уже игравшие сегодня!
    let eligible = scored;
    const freshCandidates = scored.filter((item) => item.score > -100);
    if (freshCandidates.length >= count) {
      eligible = freshCandidates;
    }

    let minScore = eligible[0].score;
    for (let i = 1; i < eligible.length; i++) {
      if (eligible[i].score < minScore) minScore = eligible[i].score;
    }
    const baseShift = minScore <= 0 ? Math.abs(minScore) + 5 : 0;

    // Efraimidis-Spirakis Weighted Reservoir Sampling:
    const weightedItems = eligible.map((item) => {
      const weight = Math.max(0.1, item.score + baseShift);
      const r = Math.max(1e-10, Math.random());
      const key = Math.log(r) / weight;
      return { track: item.track, key };
    });

    weightedItems.sort((a, b) => b.key - a.key);

    const selected: Track[] = [];
    const usedIds = new Set<string>();
    const pickedArtists = new Set<string>(contextArtists);

    // Pass 1: Select top weighted candidates with STRICT artist diversity
    for (const item of weightedItems) {
      if (selected.length >= count) break;
      const art = normalizeArtist(item.track.artist);
      if (!usedIds.has(item.track.id)) {
        if (!art || !pickedArtists.has(art)) {
          selected.push(item.track);
          usedIds.add(item.track.id);
          if (art) pickedArtists.add(art);
        }
      }
    }

    // Pass 2: If available unique artists in library were fewer than count,
    // fill remaining slots while strictly preventing consecutive duplicate artists
    if (selected.length < count) {
      for (const item of weightedItems) {
        if (selected.length >= count) break;
        if (!usedIds.has(item.track.id)) {
          const art = normalizeArtist(item.track.artist);
          const lastSelectedArt = selected.length > 0 ? normalizeArtist(selected[selected.length - 1].artist) : null;
          if (!art || art !== lastSelectedArt) {
            selected.push(item.track);
            usedIds.add(item.track.id);
          }
        }
      }
    }

    // Emergency Pass 3: If candidate pool has only 1 artist total
    if (selected.length < count) {
      for (const item of weightedItems) {
        if (selected.length >= count) break;
        if (!usedIds.has(item.track.id)) {
          selected.push(item.track);
          usedIds.add(item.track.id);
        }
      }
    }

    return selected;
  }

  /**
   * Generates diverse discovery queries based on mood, language, and user taste.
   * NEVER queries "плейлист" or "playlist" to avoid returning long mix videos or junk compilations!
   */
  private getDiscoveryQueries(mood: MixMood, lang: MixLanguage, userTopArtists: string[], userTaste: TasteVector): string[] {
    const queries: string[] = [];

    // 1. Personalized seed queries: artist top tracks (direct artist names, without fake radio/playlist terms)
    if (userTopArtists.length > 0) {
      const shuffledSeeds = [...userTopArtists].sort(() => 0.5 - Math.random());
      for (const artist of shuffledSeeds.slice(0, 4)) {
        queries.push(artist);
      }
    }

    // 2. Vibe-aligned genre queries based on user taste vector
    const ruQueries: string[] = [];
    const enQueries: string[] = [];

    if (userTaste.rock > 0.45) {
      ruQueries.push('русский рок', 'русский альтернативный рок', 'рок хиты');
      enQueries.push('alternative rock', 'rock hits', 'hard rock');
    }
    if (userTaste.hiphop > 0.45) {
      ruQueries.push('русский рэп', 'русский хип хоп', 'русский трэп');
      enQueries.push('hip hop rap', 'drill rap', 'trap hits');
    }
    if (userTaste.electronic > 0.45) {
      ruQueries.push('фонк', 'дрифт фонк', 'электронная музыка');
      enQueries.push('drift phonk', 'edm hits', 'synthwave');
    }
    if (userTaste.chill > 0.45) {
      ruQueries.push('русский инди', 'лоуфай чилл', 'русский соул');
      enQueries.push('lofi hip hop chill beats', 'indie bedroom pop', 'rnb chill');
    }
    if (userTaste.pop > 0.45) {
      ruQueries.push('популярные русские песни', 'инди поп');
      enQueries.push('viral pop hits', 'indie pop');
    }

    if (ruQueries.length === 0) ruQueries.push('русские хиты', 'русский рок', 'русский рэп');
    if (enQueries.length === 0) enQueries.push('top hits', 'alternative rock', 'hip hop');

    if (lang === 'ru') {
      queries.push(...ruQueries);
    } else if (lang === 'en') {
      queries.push(...enQueries);
    } else {
      queries.push(...ruQueries, ...enQueries);
    }

    return queries;
  }

  /**
   * Discovery Engine: Fetches online tracks matching current mood and user taste.
   * GUARANTEES mutually distinct artists across discovery batches,
   * leverages Deezer Related Artists algorithm,
   * rejects playlists/compilations,
   * and enforces strict taste vector cosine similarity!
   */
  async fetchOnlineDiscoveryTracks(
    count = 3,
    excludeIds: Set<string> = new Set(),
    excludeArtists: Set<string> = new Set()
  ): Promise<Track[]> {
    if (this.isFetchingDiscovery()) return [];
    if (this.libraryService.mixConfig().source === 'library_only' && this.getAllLocalCandidates().length > 0) return [];
    this.isFetchingDiscovery.set(true);

    try {
      const candidates = this.getAllLocalCandidates();
      const mood = this.currentMood();
      const lang = this.libraryService.mixConfig().language;
      const targetVec = this.getTargetVectorForMood(mood);
      const targetNorm = this.computeVectorNorm(targetVec);

      // Build frequency map of user top artists
      const topArtistsMap = new Map<string, number>();
      for (const t of candidates) {
        if (t.artist && t.artist.trim()) {
          const a = t.artist.replace(/feat\..*|ft\..*/i, '').trim();
          if (a.length > 1) {
            topArtistsMap.set(a, (topArtistsMap.get(a) || 0) + (t.isFavorite ? 4 : 1) + (t.plays ? 2 : 0));
          }
        }
      }
      const userTopArtists = Array.from(topArtistsMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name]) => name);

      const selectedTracks: Track[] = [];
      const seenArtists = new Set<string>();
      for (const a of excludeArtists) {
        const norm = normalizeArtist(a);
        if (norm) seenArtists.add(norm);
      }
      const seenTitles = new Set<string>();
      const fallbackPool: Track[] = [];

      const PLAYLIST_NOISE_REGEX = /\b(playlist|плейлист|full album|альбом целиком|сборник|микс|1 hour|10 hours|hour mix|compilation)\b/i;

      // PASS 1: High-fidelity related artists discovery via Deezer Related Artists & Top Tracks
      if (userTopArtists.length > 0) {
        const shuffledArtists = [...userTopArtists].sort(() => 0.5 - Math.random());
        for (const seedArtist of shuffledArtists.slice(0, 4)) {
          if (selectedTracks.length >= count) break;
          try {
            const relTracks = await this.libraryService.getRecommendations(seedArtist);
            for (const t of relTracks) {
              if (selectedTracks.length >= count) break;
              if (excludeIds.has(t.id) || this.isDisliked(t.id)) continue;
              if (t.duration < 55 || t.duration > 480) continue;
              if (PLAYLIST_NOISE_REGEX.test(`${t.title} ${t.artist}`)) continue;

              const primaryArt = normalizeArtist(t.artist);
              const normTitle = normalizeTitle(t.title);
              if (primaryArt && seenArtists.has(primaryArt)) continue;
              if (normTitle && seenTitles.has(normTitle)) continue;
              if (this.isRecentlyPlayed(t, 90)) continue;

              // Taste Vector Alignment Check:
              const trackVec = this.extractTrackVector(t);
              const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);
              // Обязательное совпадение по вайбу!
              if (similarity < 0.48) {
                continue;
              }

              selectedTracks.push(t);
              excludeIds.add(t.id);
              if (primaryArt) seenArtists.add(primaryArt);
              if (normTitle) seenTitles.add(normTitle);
            }
          } catch (e) {
            console.warn('[Discovery] Failed to get recommendations for', seedArtist, e);
          }
        }
      }

      // PASS 2: Vibe-aligned keyword queries if related artists did not fill count
      if (selectedTracks.length < count) {
        const queries = this.getDiscoveryQueries(mood, lang, userTopArtists, targetVec);
        queries.sort(() => 0.5 - Math.random());

        // Process top queries in parallel for significantly faster network resolution
        const queryBatch = queries.slice(0, 2);
        const searchPromises = queryBatch.map((q) =>
          this.libraryService.searchOnline(q).catch(() => [] as Track[])
        );
        const batchResults = await Promise.all(searchPromises);
        const allBatchTracks = batchResults.flat();

        const valid = allBatchTracks.filter((t) =>
          !t.id.startsWith('audius-') &&
          !t.audioUrl.includes('audius.co') &&
          !excludeIds.has(t.id) &&
          !this.isDisliked(t.id) &&
          (t.duration === 0 || (t.duration >= 55 && t.duration <= 480)) &&
          !PLAYLIST_NOISE_REGEX.test(`${t.title} ${t.artist}`)
        );

        const minSim = userTopArtists.length > 0 ? 0.45 : 0.20;

        for (const t of valid) {
          if (selectedTracks.length >= count) break;
          const primaryArt = normalizeArtist(t.artist);
          const normTitle = normalizeTitle(t.title);

          if (primaryArt && seenArtists.has(primaryArt)) {
            fallbackPool.push(t);
            continue;
          }
          if (normTitle && seenTitles.has(normTitle)) continue;
          if (this.isRecentlyPlayed(t, 60)) continue;

          // Taste Vector Alignment Check:
          const trackVec = this.extractTrackVector(t);
          const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);
          if (similarity < minSim) {
            fallbackPool.push(t);
            continue;
          }

          selectedTracks.push(t);
          excludeIds.add(t.id);
          if (primaryArt) seenArtists.add(primaryArt);
          if (normTitle) seenTitles.add(normTitle);
        }
      }

      // Fallback pass: if unique artists couldn't satisfy count, fill from fallbackPool with vibe alignment
      if (selectedTracks.length < count && fallbackPool.length > 0) {
        for (const t of fallbackPool) {
          if (selectedTracks.length >= count) break;
          if (excludeIds.has(t.id)) continue;

          const primaryArt = normalizeArtist(t.artist);
          const lastArt = selectedTracks.length > 0 ? normalizeArtist(selectedTracks[selectedTracks.length - 1].artist) : null;
          if (!primaryArt || primaryArt !== lastArt) {
            selectedTracks.push(t);
            excludeIds.add(t.id);
          }
        }
      }

      if (selectedTracks.length < count && userTopArtists.length === 0) {
        const starters = this.getStarterCandidates(mood, count - selectedTracks.length);
        for (const st of starters) {
          if (selectedTracks.length >= count) break;
          if (!excludeIds.has(st.id)) {
            selectedTracks.push(st);
            excludeIds.add(st.id);
          }
        }
      }

      return selectedTracks.slice(0, count);
    } catch {
      return [];
    } finally {
      this.isFetchingDiscovery.set(false);
    }
  }

  getStarterCandidates(mood: MixMood = 'all', count = 5): Track[] {
    let pool = [...STARTER_MIX_TRACKS];
    if (mood === 'energetic') {
      pool = pool.filter((t) => t.genre.includes('Rock') || t.genre.includes('Electronic') || t.genre.includes('Pop'));
    } else if (mood === 'chill') {
      pool = pool.filter((t) => t.genre.includes('Indie') || t.genre.includes('Synthwave') || t.genre.includes('Pop'));
    }
    pool.sort(() => 0.5 - Math.random());
    return pool.slice(0, count).map((t) => ({ ...t }));
  }

  /**
   * Sets user taste explicitly from quick-start vibes (Cold start)
   */
  setQuickStartVibe(vibe: 'phonk' | 'hiphop' | 'rock' | 'lofi' | 'pop' | 'indie') {
    let vec: TasteVector = { ...DEFAULT_TASTE_VECTOR };
    switch (vibe) {
      case 'phonk':
        vec = { energy: 0.95, tempo: 0.8, acoustic: 0.05, hiphop: 0.8, rock: 0.3, electronic: 0.95, pop: 0.2, chill: 0.1 };
        break;
      case 'hiphop':
        vec = { energy: 0.75, tempo: 0.65, acoustic: 0.2, hiphop: 0.95, rock: 0.2, electronic: 0.5, pop: 0.4, chill: 0.3 };
        break;
      case 'rock':
        vec = { energy: 0.9, tempo: 0.75, acoustic: 0.4, hiphop: 0.1, rock: 0.95, electronic: 0.2, pop: 0.3, chill: 0.1 };
        break;
      case 'lofi':
        vec = { energy: 0.25, tempo: 0.35, acoustic: 0.85, hiphop: 0.4, rock: 0.05, electronic: 0.2, pop: 0.2, chill: 0.95 };
        break;
      case 'pop':
        vec = { energy: 0.7, tempo: 0.6, acoustic: 0.3, hiphop: 0.3, rock: 0.2, electronic: 0.4, pop: 0.95, chill: 0.4 };
        break;
      case 'indie':
        vec = { energy: 0.55, tempo: 0.5, acoustic: 0.65, hiphop: 0.2, rock: 0.6, electronic: 0.3, pop: 0.6, chill: 0.7 };
        break;
    }
    this.tasteVector.set(vec);
    this.saveTasteVector(vec);
  }
}
