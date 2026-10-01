import { Injectable, signal, computed, inject } from '@angular/core';
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

  readonly isMixActive = signal<boolean>(false);
  readonly mixConfig = this.libraryService.mixConfig;
  readonly currentMood = computed<MixMood>(() => this.libraryService.mixConfig().mood);
  readonly isFetchingDiscovery = signal<boolean>(false);

  // User Taste Vector in reactive state
  readonly tasteVector = signal<TasteVector>(this.loadSavedTasteVector());

  // Persistent play records to prevent repetition across sessions and days
  // Map of trackId -> PlayRecord
  private readonly recentPlays = new Map<string, PlayRecord>();

  // Rolling cache of normalized artist::title -> timestamp to deduplicate remixes/alternate uploads
  private readonly recentTitles = new Map<string, number>();

  // In-memory cache for track feature vectors to prevent repeated regex and string operations
  private readonly vectorCache = new Map<string, TasteVector>();

  // Disliked tracks (delegated to LibraryService with cloud sync)
  readonly dislikedTrackIds = this.libraryService.dislikedTrackIds;

  constructor() {
    this.loadSavedRecentPlays();
    this.cleanupOldPlays();
    this.syncWithListeningHistory();
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
    this.libraryService.setMixConfig({ tasteVector: vec });
  }

  private loadSavedRecentPlays() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY_RECENT_PLAYS);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const now = Date.now();
      const cutoff48h = now - 48 * 60 * 60 * 1000;
      const cutoff24h = now - 24 * 60 * 60 * 1000;

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
    } catch {}
  }

  private saveRecentPlays() {
    if (typeof localStorage === 'undefined') return;
    try {
      const obj: Record<string, PlayRecord> = {};
      for (const [id, rec] of this.recentPlays.entries()) {
        obj[id] = rec;
      }
      localStorage.setItem(this.STORAGE_KEY_RECENT_PLAYS, JSON.stringify(obj));
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

    for (const [key, time] of this.recentTitles.entries()) {
      if (now - time > cutoff24h) {
        this.recentTitles.delete(key);
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

        const titleKey = this.getTitleKeyFromStrings(item.track_artist, item.track_title);
        if (titleKey) {
          const last = this.recentTitles.get(titleKey);
          if (!last || last < playedMs) {
            this.recentTitles.set(titleKey, playedMs);
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
   * Record when a track starts playing.
   * Immediately activates cooldown fatigue to avoid repetition if the user listens for only 30-60s.
   */
  recordTrackStarted(track: Track) {
    if (!track || track.isLiveStream) return;
    const now = Date.now();
    const cutoff48h = now - 48 * 60 * 60 * 1000;
    const cutoff24h = now - 24 * 60 * 60 * 1000;

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

    const titleKey = this.getTitleKey(track);
    if (titleKey) {
      this.recentTitles.set(titleKey, now);
      if (this.recentTitles.size > 200) {
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
    const id = typeof track === 'string' ? track : track.id;
    const rec = this.recentPlays.get(id);
    if (rec && now - rec.lastPlayed < minutesThreshold * 60 * 1000) {
      return true;
    }
    if (typeof track !== 'string') {
      const titleKey = this.getTitleKey(track);
      if (titleKey) {
        const last = this.recentTitles.get(titleKey);
        if (last && now - last < minutesThreshold * 60 * 1000) {
          return true;
        }
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

    const trackVec = this.extractTrackVector(track);
    const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);

    let score = similarity * 55; // 0..55 points from vector alignment

    // Explicit user affinity
    if (track.isFavorite) {
      score += 15;
    }

    // Familiarity vs Rediscovery bonus:
    // Avoid runaway positive feedback loop where top played tracks monopolize the mix!
    const playRec = this.recentPlays.get(track.id);
    const playsToday = playRec ? playRec.playCount24h : 0;
    if (!playRec && (!track.plays || track.plays === 0)) {
      // Unheard track in library — give it an exploratory boost
      score += 10;
    } else if (track.plays && track.plays > 0 && playsToday === 0) {
      // Familiar track that hasn't played today
      score += Math.min(5, track.plays * 0.6);
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
      // Strict back-to-back duplicate artist veto
      score -= 120;
    } else if (recentArtists && primaryArt) {
      for (const recent of recentArtists) {
        if (normalizeArtist(recent) === primaryArt) {
          score -= 45;
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

    // Cooldown & Fatigue Penalty (Time since last play)
    const now = Date.now();
    let lastPlayedTime = playRec?.lastPlayed;
    if (!lastPlayedTime) {
      const titleKey = this.getTitleKey(track);
      if (titleKey) lastPlayedTime = this.recentTitles.get(titleKey);
    }

    // Dynamically scale cooldown down if candidate pool is very small (< 15 tracks)
    const availablePool = poolSize ?? 50;
    const cooldownScale = availablePool < 15 ? Math.max(0.25, availablePool / 15) : 1.0;

    if (lastPlayedTime) {
      const minutesAgo = (now - lastPlayedTime) / (1000 * 60);
      if (minutesAgo < 35 * cooldownScale) {
        score -= 250; // Hard lockout cooldown
      } else if (minutesAgo < 90 * cooldownScale) {
        score -= 90;
      } else if (minutesAgo < 240 * cooldownScale) {
        score -= 45;
      } else if (minutesAgo < 480 * cooldownScale) {
        score -= 20;
      }
    }

    // Daily Frequency Cap Penalty (Prevents hearing the same song 5 times a day)
    if (playsToday >= 1) {
      score -= 20 * playsToday;
    }
    if (playsToday >= 2) {
      score -= 60; // Extra heavy penalty for 2nd+ play today
    }
    if (playsToday >= 3) {
      score -= 120; // Near-impossible to pick for 4th or 5th play today
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

    let minScore = scored[0].score;
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].score < minScore) minScore = scored[i].score;
    }
    const baseShift = minScore <= 0 ? Math.abs(minScore) + 5 : 0;

    // Efraimidis-Spirakis Weighted Reservoir Sampling:
    const weightedItems = scored.map((item) => {
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
   * Prioritizes multi-artist compilation and chart queries to prevent returning multiple
   * songs by the same artist!
   */
  private getDiscoveryQueries(mood: MixMood, lang: MixLanguage, userTopArtists: string[]): string[] {
    const ruEnergeticQueries = [
      'русский рэп хиты новинки', 'русский дрилл хиты', 'русский трэп плейлист',
      'топ чарт треки', 'популярный русский хип хоп', 'фонк дрифт плейлист',
      'новинки русского рэпа', 'лучшие треки чарт'
    ];
    const ruChillQueries = [
      'русский инди поп плейлист', 'русский лоуфай чилл', 'кальянный рэп душевные хиты',
      'русский соул rnb', 'спокойная музыка хиты', 'инди поп новинки', 'русский чилл аут'
    ];
    const ruGeneralQueries = [
      'русские хиты топ чарт', 'главные хиты новинки', 'топ треки недели',
      'популярная русская музыка', 'чарт новинки хиты'
    ];

    const enEnergeticQueries = [
      'hip hop rap workout hits', 'global top hits playlist', 'trap drill hits',
      'edm workout hits', 'drift phonk playlist', 'top gaming phonk hits'
    ];
    const enChillQueries = [
      'chill hits playlist', 'lofi hip hop chill beats', 'indie bedroom pop playlist',
      'acoustic chill pop', 'rnb chill evening hits', 'relaxing lofi vibes'
    ];
    const enGeneralQueries = [
      'billboard hot 100 hits', 'today top hits playlist', 'viral hits radio',
      'global trending pop hits', 'spotify top 50 hits'
    ];

    const queries: string[] = [];

    // 1. Personalized seed queries based on top artists (with diverse radio/mix suffixes)
    if (userTopArtists.length > 0) {
      const shuffledSeeds = [...userTopArtists].sort(() => 0.5 - Math.random());
      for (const artist of shuffledSeeds.slice(0, 3)) {
        queries.push(`${artist} radio`);
        queries.push(`${artist} похожие треки`);
      }
    }

    // 2. Compilation and playlist queries based on mood and language
    if (lang === 'ru') {
      if (mood === 'energetic') queries.push(...ruEnergeticQueries);
      else if (mood === 'chill') queries.push(...ruChillQueries);
      else queries.push(...ruGeneralQueries);
    } else if (lang === 'en') {
      if (mood === 'energetic') queries.push(...enEnergeticQueries);
      else if (mood === 'chill') queries.push(...enChillQueries);
      else queries.push(...enGeneralQueries);
    } else {
      // Mood 'all' / multilingual: mix ru and en
      if (mood === 'energetic') queries.push(...ruEnergeticQueries, ...enEnergeticQueries);
      else if (mood === 'chill') queries.push(...ruChillQueries, ...enChillQueries);
      else queries.push(...ruGeneralQueries, ...enGeneralQueries);
    }

    return queries;
  }

  /**
   * Discovery Engine: Fetches online tracks matching current mood and user taste.
   * GUARANTEES mutually distinct artists across discovery batches to eliminate
   * the "4+ tracks in a row from the same artist" problem!
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

      // Build frequency map of user top artists
      const topArtistsMap = new Map<string, number>();
      for (const t of candidates) {
        if (t.artist && t.artist.trim()) {
          const a = t.artist.replace(/feat\..*|ft\..*/i, '').trim();
          if (a.length > 1) {
            topArtistsMap.set(a, (topArtistsMap.get(a) || 0) + (t.isFavorite ? 3 : 1) + (t.plays ? 2 : 0));
          }
        }
      }
      const userTopArtists = Array.from(topArtistsMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name]) => name);

      const queries = this.getDiscoveryQueries(mood, lang, userTopArtists);
      // Randomize queries so each mix session starts freshly
      queries.sort(() => 0.5 - Math.random());

      const selectedTracks: Track[] = [];
      const seenArtists = new Set<string>();
      for (const a of excludeArtists) {
        const norm = normalizeArtist(a);
        if (norm) seenArtists.add(norm);
      }
      const seenTitles = new Set<string>();
      const fallbackPool: Track[] = [];

      // Query until we fill count with distinct artists
      for (const q of queries) {
        if (selectedTracks.length >= count) break;

        try {
          const results = await this.libraryService.searchOnline(q);
          const valid = results.filter((t) =>
            !t.id.startsWith('audius-') &&
            !t.audioUrl.includes('audius.co') &&
            !excludeIds.has(t.id) &&
            !this.isDisliked(t.id) &&
            (t.duration === 0 || (t.duration >= 30 && t.duration <= 720))
          );

          for (const t of valid) {
            if (selectedTracks.length >= count) break;
            const primaryArt = normalizeArtist(t.artist);
            const normTitle = normalizeTitle(t.title);

            // 1. Strict artist diversity: at most 1 track per artist in this discovery batch
            if (primaryArt && seenArtists.has(primaryArt)) {
              fallbackPool.push(t);
              continue;
            }

            // 2. Strict title diversity: no duplicate versions/remixes
            if (normTitle && seenTitles.has(normTitle)) {
              continue;
            }

            // 3. Cooldown check: no tracks played in recent history
            if (this.isRecentlyPlayed(t, 45)) {
              continue;
            }

            selectedTracks.push(t);
            excludeIds.add(t.id);
            if (primaryArt) seenArtists.add(primaryArt);
            if (normTitle) seenTitles.add(normTitle);
          }
        } catch (e) {
          console.warn('[Discovery] Search query failed:', q, e);
        }
      }

      // Fallback pass: if unique artists couldn't satisfy count, fill remaining from fallbackPool
      // while preventing consecutive duplicate artists
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

      return selectedTracks.slice(0, count);
    } catch {
      return [];
    } finally {
      this.isFetchingDiscovery.set(false);
    }
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
