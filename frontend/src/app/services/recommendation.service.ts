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

const DEFAULT_TASTE_VECTOR: TasteVector = {
  energy: 0.6,
  tempo: 0.55,
  acoustic: 0.35,
  hiphop: 0.5,
  rock: 0.4,
  electronic: 0.5,
  pop: 0.5,
  chill: 0.4,
};

@Injectable({
  providedIn: 'root',
})
export class RecommendationService {
  private readonly libraryService = inject(LibraryService);

  private readonly STORAGE_KEY_TASTE = 'recro_taste_vector_v1';
  private readonly STORAGE_KEY_DISLIKES = 'recro_disliked_tracks_v1';

  readonly isMixActive = signal<boolean>(false);
  readonly mixConfig = this.libraryService.mixConfig;
  readonly currentMood = computed<MixMood>(() => this.libraryService.mixConfig().mood);
  readonly isFetchingDiscovery = signal<boolean>(false);

  // User Taste Vector in reactive state
  readonly tasteVector = signal<TasteVector>(this.loadSavedTasteVector());

  // Recent play timestamps to prevent repetition (Fatigue Penalty)
  // Map of trackId -> epoch timestamp (ms)
  private recentPlays = new Map<string, number>();

  // In-memory cache for track feature vectors to prevent repeated regex and string operations
  private readonly vectorCache = new Map<string, TasteVector>();

  // Disliked tracks (delegated to LibraryService with cloud sync)
  readonly dislikedTrackIds = this.libraryService.dislikedTrackIds;

  constructor() {
    this.cleanupOldPlays();
  }

  setMixMood(mood: MixMood) {
    this.libraryService.setMixConfig({ mood });
  }

  resetMixSession() {
    this.isMixActive.set(false);
    this.recentPlays.clear();
    this.isFetchingDiscovery.set(false);
  }

  updateConfig(partial: Partial<MixConfig>) {
    this.libraryService.setMixConfig(partial);
  }

  private loadSavedTasteVector(): TasteVector {
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

  private cleanupOldPlays() {
    const now = Date.now();
    const fourHours = 4 * 60 * 60 * 1000;
    for (const [id, time] of this.recentPlays.entries()) {
      if (now - time > fourHours) {
        this.recentPlays.delete(id);
      }
    }
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
    // Explicit genre is duplicated to double its weighting over free-form titles
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
    if (
      text.includes('phonk') ||
      text.includes('drift') ||
      text.includes('bass') ||
      text.includes('hardstyle') ||
      text.includes('hyperpop')
    ) {
      energy += 0.42;
      tempo += 0.25;
      electronic += 0.72;
      hiphop += 0.45;
      acoustic -= 0.25;
    }

    // Hip-Hop / Rap / Drill / Trap / RnB / Soul
    if (
      text.includes('hip-hop') ||
      text.includes('hip hop') ||
      text.includes('rap') ||
      text.includes('рэп') ||
      text.includes('trap') ||
      text.includes('drill') ||
      text.includes('дрил') ||
      text.includes('r&b') ||
      text.includes('rnb') ||
      text.includes('soul')
    ) {
      energy += 0.18;
      tempo += 0.1;
      hiphop += 0.75;
      electronic += 0.15;
    }

    // Rock / Metal / Punk / Alternative / Grunge / Guitar
    if (
      text.includes('rock') ||
      text.includes('metal') ||
      text.includes('punk') ||
      text.includes('рок') ||
      text.includes('guitar') ||
      text.includes('grunge') ||
      text.includes('alternative') ||
      text.includes('core')
    ) {
      energy += 0.32;
      tempo += 0.18;
      rock += 0.78;
      acoustic += 0.1;
    }

    // Electronic / Synthwave / EDM / House / Techno / DnB / Club / Trance
    if (
      text.includes('synth') ||
      text.includes('synthwave') ||
      text.includes('edm') ||
      text.includes('house') ||
      text.includes('dance') ||
      text.includes('techno') ||
      text.includes('club') ||
      text.includes('dnb') ||
      text.includes('drum and bass') ||
      text.includes('trance') ||
      text.includes('dubstep')
    ) {
      energy += 0.3;
      tempo += 0.22;
      electronic += 0.78;
      acoustic -= 0.25;
    }

    // Chill / Lo-Fi / Ambient / Relax / Acoustic / Piano / Soft
    if (
      text.includes('lo-fi') ||
      text.includes('lofi') ||
      text.includes('chill') ||
      text.includes('ambient') ||
      text.includes('relax') ||
      text.includes('sleep') ||
      text.includes('piano') ||
      text.includes('acoustic') ||
      text.includes('акустика') ||
      text.includes('лаборатория') ||
      text.includes('calm') ||
      text.includes('meditation') ||
      text.includes('soft')
    ) {
      energy -= 0.25;
      tempo -= 0.2;
      chill += 0.78;
      acoustic += 0.5;
    }

    // Pop / Indie / Vocal / K-pop
    if (
      text.includes('pop') ||
      text.includes('поп') ||
      text.includes('indie') ||
      text.includes('инди') ||
      text.includes('hit') ||
      text.includes('k-pop') ||
      text.includes('kpop')
    ) {
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

    if (this.vectorCache.size > 2500) {
      this.vectorCache.clear();
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
   * Takes precomputed normA to avoid recalculating target norm for every track.
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
    this.recentPlays.set(track.id, Date.now());

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
   * Fixed drift: only penalizes prominent dimensions of the skipped track
   * and never erroneously inflates neutral genre dimensions.
   */
  recordTrackSkip(track: Track) {
    if (track.isLiveStream) return;
    this.recentPlays.set(track.id, Date.now());

    const tVec = this.extractTrackVector(track);
    const cur = this.tasteVector();

    // 1. Continuous parameters: if the skipped track had extreme energy/tempo/acoustic, gently nudge away
    let newEnergy = cur.energy;
    if (tVec.energy > 0.65) newEnergy = Math.max(0.1, cur.energy - 0.08);
    else if (tVec.energy < 0.35) newEnergy = Math.min(0.9, cur.energy + 0.08);

    let newTempo = cur.tempo;
    if (tVec.tempo > 0.65) newTempo = Math.max(0.1, cur.tempo - 0.08);
    else if (tVec.tempo < 0.35) newTempo = Math.min(0.9, cur.tempo + 0.08);

    let newAcoustic = cur.acoustic;
    if (tVec.acoustic > 0.65) newAcoustic = Math.max(0.1, cur.acoustic - 0.08);
    else if (tVec.acoustic < 0.35) newAcoustic = Math.min(0.9, cur.acoustic + 0.08);

    // 2. Genre dimensions: only reduce genres that the skipped track actually exhibited (> 0.35).
    // Neutral genres are NOT boosted!
    const updated: TasteVector = {
      energy: newEnergy,
      tempo: newTempo,
      acoustic: newAcoustic,
      hiphop: Math.max(0.05, cur.hiphop - (tVec.hiphop > 0.35 ? tVec.hiphop * 0.12 : 0)),
      rock: Math.max(0.05, cur.rock - (tVec.rock > 0.35 ? tVec.rock * 0.12 : 0)),
      electronic: Math.max(0.05, cur.electronic - (tVec.electronic > 0.35 ? tVec.electronic * 0.12 : 0)),
      pop: Math.max(0.05, cur.pop - (tVec.pop > 0.35 ? tVec.pop * 0.12 : 0)),
      chill: Math.max(0.05, cur.chill - (tVec.chill > 0.35 ? tVec.chill * 0.12 : 0)),
    };

    this.tasteVector.set(updated);
    this.saveTasteVector(updated);
  }

  /**
   * Dislike track: adds to blacklist in LibraryService (synced with cloud) and prevents from playing.
   */
  dislikeTrack(trackId: string) {
    this.libraryService.dislikeTrack(trackId);
  }

  isDisliked(trackId: string): boolean {
    return this.libraryService.isDisliked(trackId);
  }

  /**
   * Aggregates all candidate tracks from:
   * 1. Library tracks
   * 2. User playlists
   * 3. Favorites
   */
  getAllLocalCandidates(): Track[] {
    const map = new Map<string, Track>();

    // 1. Library tracks
    for (const t of this.libraryService.tracks()) {
      if (!t.isLiveStream && !this.isDisliked(t.id)) {
        map.set(t.id, t);
      }
    }

    // 2. Playlists
    const plTracksMap = new Map(this.libraryService.tracks().map((t) => [t.id, t]));
    for (const pl of this.libraryService.playlists()) {
      for (const tId of pl.trackIds) {
        const found = plTracksMap.get(tId);
        if (found && !found.isLiveStream && !this.isDisliked(found.id)) {
          map.set(found.id, found);
        }
      }
    }

    return Array.from(map.values());
  }

  /**
   * Adjusts target vector based on selected mood filter and contextual transition flow
   * (blends 75% user taste/mood with 25% current track vector for smooth music flow)
   */
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

    // Contextual Flow: smoothly steer 25% towards currently playing track's vibe
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
   * Scores a track candidate with cosine similarity + favorite boost - soft fatigue penalty - artist diversity penalty.
   */
  scoreTrack(
    track: Track,
    mood: MixMood,
    targetVec: TasteVector,
    targetNorm: number,
    currentTrack?: Track | null,
    recentArtists?: Set<string>
  ): number {
    if (this.isDisliked(track.id)) return -9999;

    // Mood 'favorites': strictly favorited tracks
    if (mood === 'favorites' && !track.isFavorite) {
      return -9999;
    }

    const trackVec = this.extractTrackVector(track);
    const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);

    let score = similarity * 55; // 0..55 points from vector alignment

    // Explicit user affinity
    if (track.isFavorite) {
      score += 20;
    }
    if (track.plays && track.plays > 0) {
      score += Math.min(12, track.plays * 1.2);
    }

    // Language preference
    const lang = this.libraryService.mixConfig().language;
    if (lang === 'ru') {
      const isRu = /[а-яё]/i.test(`${track.title} ${track.artist}`);
      score += isRu ? 30 : -35;
    } else if (lang === 'en') {
      const isRu = /[а-яё]/i.test(`${track.title} ${track.artist}`);
      score += !isRu ? 30 : -35;
    }

    // Artist Diversity Penalty (Anti-clustering): discourage back-to-back duplicate artist
    if (currentTrack?.artist && track.artist) {
      if (currentTrack.artist.toLowerCase().trim() === track.artist.toLowerCase().trim()) {
        score -= 28;
      }
    }
    if (recentArtists && track.artist && recentArtists.has(track.artist.toLowerCase().trim())) {
      score -= 16;
    }

    // Soft Fatigue penalty (Cooldown): discourages recent tracks without permanently blocking them
    const lastPlayed = this.recentPlays.get(track.id);
    if (lastPlayed) {
      const minutesAgo = (Date.now() - lastPlayed) / (1000 * 60);
      if (minutesAgo < 15) {
        score -= 35;
      } else if (minutesAgo < 45) {
        score -= 18;
      } else if (minutesAgo < 120) {
        score -= 8;
      }
    }

    return score;
  }

  /**
   * Selects N next tracks using Efraimidis-Spirakis Algorithm (A-Res) for weighted random sampling
   * without replacement, with artist diversity enforcement and context flow.
   * Guaranteed to NEVER return an empty list if any candidates exist!
   */
  pickNextTracks(count: number, excludeIds: Set<string> = new Set(), currentTrack?: Track | null): Track[] {
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

    const recentArtists = new Set<string>();
    if (currentTrack?.artist) {
      recentArtists.add(currentTrack.artist.toLowerCase().trim());
    }

    const scored = available
      .map((track) => ({
        track,
        score: this.scoreTrack(track, mood, targetVec, targetNorm, currentTrack, recentArtists),
      }))
      .filter((item) => item.score > -5000); // Discard only absolute vetos (-9999)

    if (scored.length === 0) {
      return available.slice(0, count);
    }

    // Shift scores so lowest score is strictly positive (> 0.1)
    let minScore = scored[0].score;
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].score < minScore) minScore = scored[i].score;
    }
    const baseShift = minScore <= 0 ? Math.abs(minScore) + 5 : 0;

    // Efraimidis-Spirakis Weighted Reservoir Sampling:
    // Key = Math.log(R) / weight, where R in (0, 1). Highest key wins!
    const weightedItems = scored.map((item) => {
      const weight = Math.max(0.1, item.score + baseShift);
      const r = Math.max(1e-10, Math.random());
      const key = Math.log(r) / weight;
      return { track: item.track, key };
    });

    weightedItems.sort((a, b) => b.key - a.key);

    const selected: Track[] = [];
    const usedIds = new Set<string>();
    const pickedArtists = new Set<string>(recentArtists);

    // Pass 1: select top weighted candidates while avoiding duplicate artists
    for (const item of weightedItems) {
      if (selected.length >= count) break;
      const art = (item.track.artist || '').toLowerCase().trim();
      if (!usedIds.has(item.track.id)) {
        if (!pickedArtists.has(art) || weightedItems.length < count * 2) {
          selected.push(item.track);
          usedIds.add(item.track.id);
          if (art) pickedArtists.add(art);
        }
      }
    }

    // Pass 2: if artist diversity restriction left slots unfilled, fill remaining slots
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
   * Discovery Engine: Fetches online tracks matching current mood and user taste.
   * Personalizes discovery queries using the user's top artists from the library and history.
   */
  async fetchOnlineDiscoveryTracks(count = 3, excludeIds: Set<string> = new Set()): Promise<Track[]> {
    if (this.isFetchingDiscovery()) return [];
    if (this.libraryService.mixConfig().source === 'library_only' && this.getAllLocalCandidates().length > 0) return [];
    this.isFetchingDiscovery.set(true);

    try {
      const candidates = this.getAllLocalCandidates();
      const mood = this.currentMood();
      const lang = this.libraryService.mixConfig().language;
      let query = '';

      const ruEnergetic = [
        'Big Baby Tape', 'OG Buda', 'Kizaru', 'PHARAOH', 'русский дрилл',
        'русский фонк', 'MACAN', 'Shadowraze', 'FRIENDLY THUG 52', 'Kai Angel',
        '9mice', 'Scally Milano', 'Toxi$', 'Guf', 'Miyagi Эндшпиль'
      ];
      const ruChill = [
        'Miyagi', 'Saluki', 'ANIKV', 'русский лоуфай', 'Zoloto', 'The Limba',
        'HammAli Navai', 'Jony', 'Скриптонит', 'Баста', 'инди русское', 'Thomas Mraz'
      ];
      const ruGeneral = [
        'Miyagi', 'OG Buda', 'Big Baby Tape', 'Saluki', 'Kizaru', 'Markul',
        'Scriptonite', 'Instasamka', 'MACAN', 'ЛСП', 'ATL', 'Pharaoh', 'FEDUK', 'Obladaet'
      ];

      const enEnergetic = [
        'The Weeknd', 'Travis Scott', 'Metro Boomin', 'phonk drift', 'electronic synthwave',
        'rock hits', 'Playboi Carti', '21 Savage', 'gym phonk', 'hardstyle remix', 'Skrillex'
      ];
      const enChill = [
        'lofi hip hop beats', 'Billie Eilish', 'Joji', 'chill rnb', 'acoustic chill',
        'Post Malone', 'Lana Del Rey', 'Frank Ocean', 'cigarettes after sex', 'mac miller'
      ];
      const enGeneral = [
        'The Weeknd', 'Dua Lipa', 'Post Malone', 'Drake', 'Kendrick Lamar',
        'Metro Boomin', 'Arctic Monkeys', 'Daft Punk', 'Imagine Dragons', 'Coldplay'
      ];

      const modifiers = ['', ' mix', ' hits', ' tracks', ' remix', ' radio'];
      const randomMod = modifiers[Math.floor(Math.random() * modifiers.length)];

      // 1. Build a frequency map of top artists from the user's library
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

      // 2. Personalize discovery: 65% chance to explore around user's known artists
      if (userTopArtists.length > 0 && Math.random() < 0.65) {
        const seedArtist = userTopArtists[Math.floor(Math.random() * userTopArtists.length)];
        const suffixes = [' radio', ' mix', ' hits', ' похожие'];
        const suff = suffixes[Math.floor(Math.random() * suffixes.length)];
        query = `${seedArtist}${suff}`;
      } else {
        // Fall back to mood and language pools
        if (lang === 'ru') {
          if (mood === 'energetic') {
            query = ruEnergetic[Math.floor(Math.random() * ruEnergetic.length)] + randomMod;
          } else if (mood === 'chill') {
            query = ruChill[Math.floor(Math.random() * ruChill.length)] + randomMod;
          } else {
            query = ruGeneral[Math.floor(Math.random() * ruGeneral.length)] + randomMod;
          }
        } else if (lang === 'en') {
          if (mood === 'energetic') {
            query = enEnergetic[Math.floor(Math.random() * enEnergetic.length)] + randomMod;
          } else if (mood === 'chill') {
            query = enChill[Math.floor(Math.random() * enChill.length)] + randomMod;
          } else {
            query = enGeneral[Math.floor(Math.random() * enGeneral.length)] + randomMod;
          }
        } else {
          if (mood === 'energetic') {
            const pool = [...ruEnergetic, ...enEnergetic];
            query = pool[Math.floor(Math.random() * pool.length)] + randomMod;
          } else if (mood === 'chill') {
            const pool = [...ruChill, ...enChill];
            query = pool[Math.floor(Math.random() * pool.length)] + randomMod;
          } else {
            const pool = [...ruGeneral, ...enGeneral];
            query = pool[Math.floor(Math.random() * pool.length)] + randomMod;
          }
        }
      }

      const results = await this.libraryService.searchOnline(query.trim());
      let filtered = results.filter((t) => 
        !t.id.startsWith('audius-') &&
        !t.audioUrl.includes('audius.co') &&
        !excludeIds.has(t.id) && 
        !this.isDisliked(t.id) &&
        (t.duration === 0 || (t.duration >= 30 && t.duration <= 720))
      );

      // If all results matched excludeIds, relax excludeIds check
      if (filtered.length === 0) {
        filtered = results.filter((t) =>
          !t.id.startsWith('audius-') &&
          !t.audioUrl.includes('audius.co') &&
          !this.isDisliked(t.id) &&
          (t.duration === 0 || (t.duration >= 30 && t.duration <= 720))
        );
      }

      return filtered.slice(0, count);
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
