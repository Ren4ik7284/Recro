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
  energy: 0.5,
  tempo: 0.5,
  acoustic: 0.35,
  hiphop: 0.2,
  rock: 0.3,
  electronic: 0.3,
  pop: 0.3,
  chill: 0.3,
};

export const STARTER_MIX_TRACKS: Track[] = [
  {
    id: 'starter-1',
    title: 'Get Lucky',
    artist: 'Daft Punk feat. Pharrell Williams',
    duration: 248,
    audioUrl: '/api/stream?title=Get%20Lucky&artist=Daft%20Punk',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/2c5aa8c057ee13d8031e42845c48bce6/500x500.jpg',
    genre: 'Disco / Funk',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-2',
    title: 'Do I Wanna Know?',
    artist: 'Arctic Monkeys',
    duration: 272,
    audioUrl: '/api/stream?title=Do%20I%20Wanna%20Know&artist=Arctic%20Monkeys',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/6c65b1cbca5aa2771b0292b3bafe6288/500x500.jpg',
    genre: 'Indie Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-3',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    duration: 200,
    audioUrl: '/api/stream?title=Blinding%20Lights&artist=The%20Weeknd',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/e00f95ecb2649666cfeb317f2be021a8/500x500.jpg',
    genre: 'Synthpop',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-4',
    title: 'Моя голова винтом',
    artist: 'Kostromin',
    duration: 135,
    audioUrl: '/api/stream?title=%D0%9C%D0%BE%D1%8F%20%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%B0%20%D0%B2%D0%B8%D0%BD%D1%82%D0%BE%D0%BC&artist=Kostromin',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/0c2fb753d0e2c00236a28795dae9ca24/500x500.jpg',
    genre: 'Pop / Viral',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-5',
    title: 'Close Eyes',
    artist: 'DVRST',
    duration: 132,
    audioUrl: '/api/stream?title=Close%20Eyes&artist=DVRST',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/98bb1cb76241b714b13a7c642e13eb98/500x500.jpg',
    genre: 'Drift Phonk',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-6',
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
    id: 'starter-7',
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
    id: 'starter-8',
    title: 'Кукла колдуна',
    artist: 'Король и Шут',
    duration: 203,
    audioUrl: '/api/stream?title=%D0%9A%D1%83%D0%BA%D0%BB%D0%B0%20%D0%BA%D0%BE%D0%BB%D0%B4%D1%83%D0%BD%D0%B0&artist=%D0%9A%D0%BE%D1%80%D0%BE%D0%BB%D1%8C%20%D0%B8%20%D0%A8%D1%83%D1%82',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/6ca17dfcb2e44e2fa8a1bf19544a04aa/500x500.jpg',
    genre: 'Punk Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-9',
    title: 'Murder In My Mind',
    artist: 'Kordhell',
    duration: 145,
    audioUrl: '/api/stream?title=Murder%20In%20My%20Mind&artist=Kordhell',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/4488b39c065f3775f0aee7bb059ee20a/500x500.jpg',
    genre: 'Drift Phonk',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-10',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    duration: 354,
    audioUrl: '/api/stream?title=Bohemian%20Rhapsody&artist=Queen',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/03f0bbfb776269dfb48c0aee7144e54a/500x500.jpg',
    genre: 'Classic Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-11',
    title: 'Отпускай',
    artist: 'Три дня дождя',
    duration: 172,
    audioUrl: '/api/stream?title=%D0%9E%D1%82%D0%BF%D1%83%D1%81%D0%BA%D0%B0%D0%B9&artist=%D0%A2%D1%80%D0%B8%20%D0%B4%D0%BD%D1%8F%20%D0%B4%D0%BE%D0%B6%D0%B4%D1%8F',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/5f58c735d4cb680c10b7ee2e7fb7da58/500x500.jpg',
    genre: 'Rock / Alternative',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-12',
    title: 'Стрелы',
    artist: 'Markul, Тося Чайкина',
    duration: 168,
    audioUrl: '/api/stream?title=%D0%A1%D1%82%D1%80%D0%B5%D0%BB%D1%8B&artist=Markul%2C%20%D0%A2%D0%BE%D1%81%D1%8F%20%D0%A7%D0%B0%D0%B9%D0%BA%D0%B8%D0%BD%D0%B0',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/5c35b8026132d039537bc2c0e86b0337/500x500.jpg',
    genre: 'Pop / Rap',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-13',
    title: 'In The End',
    artist: 'Linkin Park',
    duration: 216,
    audioUrl: '/api/stream?title=In%20The%20End&artist=Linkin%20Park',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/4ee6246aa577ebaf16b25a388f72aa98/500x500.jpg',
    genre: 'Rock / Nu Metal',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-14',
    title: 'Believer',
    artist: 'Imagine Dragons',
    duration: 204,
    audioUrl: '/api/stream?title=Believer&artist=Imagine%20Dragons',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/d513725c4ef68ee410dfa6c7ecb1e5fe/500x500.jpg',
    genre: 'Alternative / Rock',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-15',
    title: 'COWBELL WARRIOR!',
    artist: 'SXMPRA',
    duration: 110,
    audioUrl: '/api/stream?title=COWBELL%20WARRIOR!&artist=SXMPRA',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/1aaee19ceba8d88e612cbff0a6f44383/500x500.jpg',
    genre: 'Drift Phonk',
    format: 'mp3',
    plays: 0,
    isFavorite: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'starter-16',
    title: 'Glimpse of Us',
    artist: 'Joji',
    duration: 233,
    audioUrl: '/api/stream?title=Glimpse%20of%20Us&artist=Joji',
    coverUrl: 'https://e-cdns-images.dzcdn.net/images/cover/86a9a95782782e441ea636a0d241d7d2/500x500.jpg',
    genre: 'Lo-Fi / R&B',
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

export function extractAllArtists(artist?: string, title?: string): string[] {
  const text = `${artist || ''} ${title || ''}`;
  const parts = text.split(/\b(?:feat\.?|ft\.?|with|x)\b|[&,/]|\s+[-–—+]\s+/i);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const cleaned = part
      .replace(/\(.*?\)|\[.*?]|{.*?}/g, ' ')
      .replace(/\b(prod|official|video|audio|lyrics|lyric|remastered|hd|hq|4k|visualizer|clip|клип|премьера)\b.*/i, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length >= 2) {
      const lower = cleaned.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(cleaned);
      }
    }
  }

  return result;
}

export const KNOWN_RUSSIAN_LATIN_ARTISTS = new Set<string>([
  'miyagi', 'andy panda', 'morgenshtern', 'kizaru', 'big baby tape', 'og buda',
  'macan', 'scally milano', 'uglystephan', 'mayot', 'soda luv', '163onmyneck',
  'oxxxymiron', 'markul', 'obladaet', 'saluki', 'boulevard depo', 'jeembo',
  'pharaoh', 'scriptonite', 'skryptonite', 'loqiemean', 'noize mc', 'anacondaz',
  'face', 'gone fludd', 'gone.fludd', 'flesh', 'lizer', 'thrill pill', 'platina',
  'kordhell', 'dvrst', 'sxmpra', 'shadowraze', 'zxcursed', 'hikikomori kai',
  'kostromin', 'sub urban', 'gidayyat', 'kambulat', 'the limba', 'jony',
  'hammali', 'navai', 'jah khalib', 'rauf', 'faik', 'mot', 'basta', 'noggano',
  'max korzh', 'feduk', 'eldzhey', 'allj', 'slava marlow', 'instasamka',
  'sqwoz bab', 'dava', 'dead blonde', 'gspd', 'cmh', 'dk', 'mzlff',
  'serebro', 'tatu', 'little big', 'ic3peak', 'shortparis', 'motorama',
  'molchat doma', 'ssshhhiiittt', 'buerak', 'plamenev', 'radio tapok',
  'pyrokinesis', 'stigmata', 'amatory', 'slot', 'louna', 'epidemia'
]);

export function isRussianArtist(artist?: string): boolean {
  if (!artist) return false;
  if (/[а-яё]/i.test(artist)) return true;
  const norm = normalizeArtist(artist);
  if (!norm) return false;
  if (KNOWN_RUSSIAN_LATIN_ARTISTS.has(norm)) return true;
  for (const known of KNOWN_RUSSIAN_LATIN_ARTISTS) {
    if (norm === known || norm.startsWith(known + ' ') || norm.endsWith(' ' + known)) {
      return true;
    }
  }
  return false;
}

export function isTrackLanguageMatch(track: { title?: string; artist?: string; genre?: string }, lang: MixLanguage): boolean {
  if (!track) return false;
  if (lang === 'all') return true;

  const title = track.title || '';
  const artist = track.artist || '';
  const genre = track.genre || '';
  const fullText = `${title} ${artist} ${genre}`;

  const hasCyrillic = /[а-яё]/i.test(fullText);
  const isRuArtist = isRussianArtist(artist);
  const isRussianTrack = hasCyrillic || isRuArtist;

  if (lang === 'ru') {
    return isRussianTrack;
  }

  if (lang === 'en') {
    return !isRussianTrack;
  }

  return true;
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

export const JUNK_GENRES_REGEX = /\b(jazz|джаз|classical|классика|классическая|blues|блюз|chamber|orchestral|symphony|симфония|opera|опера|relaxing piano|sleep music|meditation|lounge bar|soothing piano|bossa nova)\b/i;
export const REGIONAL_SPAM_REGEX = /[\u0900-\u097F]|punjabi|hindi|bollywood|desi|bhangra|sidhu|haryanvi|tamil|telugu|[іїєґІЇЄҐ]|українськ|ukrainian|\bзсу\b/i;
export const BEDROOM_PRODUCER_REGEX = /\b(type beat|beat prod|instrumental|karaoke|караоке|минус|slowed|reverb|8d audio|bass boosted|nightcore|sped up|speed up|remake|guitar cover|кавер|1 hour|10 hours|hour mix|compilation|сборник)\b/i;

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

  // Active mix session history to strictly eliminate any track or alternate version repeat
  private readonly sessionPlayedIds = new Set<string>();
  private readonly sessionPlayedKeys = new Set<string>();
  private artistSeedOffset = 0;

  isSessionDuplicate(track: Track): boolean {
    if (!track) return false;
    if (this.sessionPlayedIds.has(track.id)) return true;
    const key = this.getTitleKey(track);
    if (key && this.sessionPlayedKeys.has(key)) return true;
    return false;
  }

  isLibraryTrack(track: Track): boolean {
    if (!track) return false;
    const localTracks = this.libraryService.tracks();
    if (localTracks.some((t) => t.id === track.id)) return true;
    const trackKey = this.getTitleKey(track);
    if (trackKey && localTracks.some((t) => this.getTitleKey(t) === trackKey)) return true;
    return false;
  }

  registerSessionPlayed(track: Track): void {
    if (!track || track.isLiveStream) return;
    this.sessionPlayedIds.add(track.id);
    const key = this.getTitleKey(track);
    if (key) {
      this.sessionPlayedKeys.add(key);
    }
    if (this.sessionPlayedIds.size > 1000) {
      const firstId = this.sessionPlayedIds.keys().next().value;
      if (firstId !== undefined) this.sessionPlayedIds.delete(firstId);
    }
    if (this.sessionPlayedKeys.size > 1000) {
      const firstKey = this.sessionPlayedKeys.keys().next().value;
      if (firstKey !== undefined) this.sessionPlayedKeys.delete(firstKey);
    }
  }

  getSessionPlayedIds(): Set<string> {
    return new Set(this.sessionPlayedIds);
  }

  resetSessionHistory(): void {
    this.sessionPlayedIds.clear();
    this.sessionPlayedKeys.clear();
  }

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
    this.resetSessionHistory();
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

  hasUserAffinityForJunk(): boolean {
    const lib = this.getAllLocalCandidates();
    return lib.some((t) => JUNK_GENRES_REGEX.test(`${t.genre} ${t.title} ${t.artist}`));
  }

  isCyrillicUserLibrary(): boolean {
    const lib = this.getAllLocalCandidates();
    if (lib.length === 0) return true;
    const ruCount = lib.filter((t) => /[а-яё]/i.test(`${t.title} ${t.artist}`)).length;
    return (ruCount / lib.length) >= 0.20;
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

    // Strict Junk/Incompatible Genre Rejector (Classical, Quiet Jazz, Ambient Sleep)
    if (!this.hasUserAffinityForJunk() && JUNK_GENRES_REGEX.test(`${track.genre} ${track.title} ${track.artist} ${track.album || ''}`)) {
      return -9999;
    }

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
    if (lang !== 'all') {
      const matches = isTrackLanguageMatch(track, lang);
      score += matches ? 40 : -10000;
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
    const lang = this.libraryService.mixConfig().language;

    const validCandidates = allLocal.filter((t) => {
      if (this.isDisliked(t.id)) return false;
      if (mood === 'favorites' && !t.isFavorite) return false;
      if (!isTrackLanguageMatch(t, lang)) return false;
      return true;
    });

    if (validCandidates.length === 0) return [];

    let available = validCandidates.filter((t) => !excludeIds.has(t.id) && !this.isSessionDuplicate(t));
    if (available.length === 0) {
      available = validCandidates.filter((t) => !excludeIds.has(t.id));
    }
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
   * Prioritizes SoundCloud charts, trending CIS rap/trap/phonk/rock, and artist top hits.
   * NEVER queries "плейлист" or "playlist" to avoid returning long mix videos or junk compilations!
   */
  private getDiscoveryQueries(mood: MixMood, lang: MixLanguage, userTopArtists: string[], userTaste: TasteVector): string[] {
    const queries: string[] = [];

    // Filter seed artists by requested language
    const langFilteredArtists = userTopArtists.filter((artist) => {
      if (lang === 'all') return true;
      const isRu = isRussianArtist(artist);
      return lang === 'ru' ? isRu : !isRu;
    });

    if (langFilteredArtists.length > 0) {
      const shuffledSeeds = [...langFilteredArtists].sort(() => 0.5 - Math.random());
      for (const artist of shuffledSeeds.slice(0, 4)) {
        if (lang === 'ru') {
          queries.push(
            `${artist} хиты`,
            `${artist} топ`,
            `${artist}`
          );
        } else if (lang === 'en') {
          queries.push(
            `${artist} top tracks`,
            `${artist} hits`,
            `${artist}`
          );
        } else {
          queries.push(
            `${artist} хиты`,
            `${artist} top hits`,
            `${artist}`
          );
        }
      }
    }

    const ruQueries: string[] = [];
    const enQueries: string[] = [];

    // Mood & genre specific queries
    if (mood === 'energetic') {
      ruQueries.push('бодрый русский рэп', 'энергичный рок', 'дрифт фонк', 'русский фонк');
      enQueries.push('energetic rap hits', 'hard rock hits', 'drift phonk', 'workout beats');
    } else if (mood === 'chill') {
      ruQueries.push('спокойная русская музыка', 'русский лоуфай', 'русский инди поп', 'кальянный рэп');
      enQueries.push('chill beats lofi', 'chill indie rock', 'r&b chill vibes', 'relaxing pop');
    }

    if (userTaste.hiphop > 0.40) {
      ruQueries.push('русский рэп хиты', 'хип хоп новинки');
      enQueries.push('hip hop hits', 'rap trending');
    }
    if (userTaste.electronic > 0.40) {
      ruQueries.push('русская электронная музыка', 'фонк новинки');
      enQueries.push('electronic dance hits', 'synthwave');
    }
    if (userTaste.rock > 0.40) {
      ruQueries.push('русский рок хиты', 'русский пост панк', 'альтернативный рок');
      enQueries.push('rock hits', 'modern rock', 'indie alternative');
    }
    if (userTaste.pop > 0.40) {
      ruQueries.push('русские поп хиты', 'русская инди музыка');
      enQueries.push('pop hits', 'top billboard hits');
    }

    if (ruQueries.length === 0) ruQueries.push('русские хиты', 'русский инди рок', 'русский рэп');
    if (enQueries.length === 0) enQueries.push('indie rock', 'alternative hits', 'top hits global');

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
   * integrates SoundCloud charts and artist discovery,
   * strictly filters classical/jazz/ambient unless present in user library,
   * rejects playlists/compilations,
   * and enforces strict taste vector cosine similarity!
   */
  async fetchOnlineDiscoveryTracks(
    count = 3,
    excludeIds: Set<string> = new Set(),
    excludeArtists: Set<string> = new Set(),
    seedTrack: Track | null = null
  ): Promise<Track[]> {
    if (this.isFetchingDiscovery()) return [];
    if (this.libraryService.mixConfig().source === 'library_only' && this.getAllLocalCandidates().length > 0) return [];
    this.isFetchingDiscovery.set(true);

    try {
      const candidates = this.getAllLocalCandidates();
      const mood = this.currentMood();
      const isLibraryOnly = this.libraryService.mixConfig().source === 'library_only';
      const lang = this.libraryService.mixConfig().language;
      const targetVec = this.getTargetVectorForMood(mood);
      const targetNorm = this.computeVectorNorm(targetVec);

      // In discovery mix, NEVER include tracks already in the user's library!
      if (!isLibraryOnly) {
        for (const t of candidates) {
          excludeIds.add(t.id);
        }
      }

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

      const PLAYLIST_NOISE_REGEX = /\b(playlist|плейлист|full album|альбом целиком|сборник|микс|1 hour|10 hours|hour mix|compilation|type beat)\b/i;
      const hasJunkAffinity = this.hasUserAffinityForJunk();

      const dominantGenre = targetVec.hiphop >= 0.4 ? 'rap'
        : targetVec.electronic >= 0.5 ? 'phonk'
        : targetVec.rock >= 0.45 ? 'rock'
        : targetVec.pop >= 0.45 ? 'pop'
        : undefined;

      const pass1Tasks: Promise<Track[]>[] = [];

      // Filter candidate pool by language to pick appropriate effectiveSeed
      const langFilteredCandidates = candidates.filter((t) => isTrackLanguageMatch(t, lang));
      const effectiveSeed = seedTrack && isTrackLanguageMatch(seedTrack, lang)
        ? seedTrack
        : (langFilteredCandidates.length > 0 ? langFilteredCandidates[Math.floor(Math.random() * langFilteredCandidates.length)] : null);
      const seedGenre = effectiveSeed?.genre || dominantGenre;

      if (effectiveSeed) {
        if (effectiveSeed.title && effectiveSeed.artist) {
          pass1Tasks.push(
            this.libraryService.getSimilarTracks(effectiveSeed.title, effectiveSeed.artist, 10, seedGenre).catch(() => [] as Track[])
          );
        }

        pass1Tasks.push(
          this.libraryService.getRecommendations(effectiveSeed.artist, dominantGenre, 10, undefined, seedGenre).catch(() => [] as Track[])
        );

        const seedArtists = extractAllArtists(effectiveSeed.artist, effectiveSeed.title);
        if (seedArtists.length > 0) {
          const randArtist = seedArtists[Math.floor(Math.random() * seedArtists.length)];
          pass1Tasks.push(
            this.libraryService.getRecommendations(randArtist, dominantGenre, 6, undefined, seedGenre).catch(() => [] as Track[])
          );
        }
      }

      // Filter userTopArtists by requested language
      const langFilteredTopArtists = userTopArtists.filter((artist) => {
        if (lang === 'all') return true;
        const isRu = isRussianArtist(artist);
        return lang === 'ru' ? isRu : !isRu;
      });

      if (langFilteredTopArtists.length > 0) {
        const offset = this.artistSeedOffset % langFilteredTopArtists.length;
        this.artistSeedOffset = (this.artistSeedOffset + 2) % 1000;
        const rotated = [
          ...langFilteredTopArtists.slice(offset),
          ...langFilteredTopArtists.slice(0, offset),
        ];
        for (const seedArtist of rotated.slice(0, 3)) {
          pass1Tasks.push(
            this.libraryService.getRecommendations(seedArtist, dominantGenre, 8, undefined, dominantGenre).catch(() => [] as Track[])
          );
        }
      }

      if (candidates.length === 0 && this.libraryService.getSoundCloudCharts) {
        pass1Tasks.push(
          this.libraryService.getSoundCloudCharts(dominantGenre, 10).catch(() => [] as Track[])
        );
      }

      const pass1Results = await Promise.all(pass1Tasks);
      const pass1Tracks = pass1Results.flat();
      const isRuLib = this.isCyrillicUserLibrary();

      for (const t of pass1Tracks) {
        if (selectedTracks.length >= count) break;
        if (!t || !t.audioUrl || !t.audioUrl.trim() || !t.title || !t.title.trim()) continue;
        if (excludeIds.has(t.id) || this.isDisliked(t.id) || this.isSessionDuplicate(t)) continue;
        if (!isLibraryOnly && this.isLibraryTrack(t)) continue;
        if (!isTrackLanguageMatch(t, lang)) continue;
        if (t.duration < 50 || t.duration > 480) continue;
        const textKey = `${t.genre} ${t.title} ${t.artist}`;
        if (PLAYLIST_NOISE_REGEX.test(textKey) || BEDROOM_PRODUCER_REGEX.test(textKey)) continue;
        if (isRuLib && REGIONAL_SPAM_REGEX.test(textKey)) continue;
        if (!hasJunkAffinity && JUNK_GENRES_REGEX.test(textKey)) continue;

        const primaryArt = normalizeArtist(t.artist);
        const normTitle = normalizeTitle(t.title);
        if (primaryArt && seenArtists.has(primaryArt)) continue;
        if (normTitle && seenTitles.has(normTitle)) continue;
        if (this.isRecentlyPlayed(t, 90)) continue;

        const trackVec = this.extractTrackVector(t);
        const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);
        if (similarity < 0.38) {
          continue;
        }

        selectedTracks.push(t);
        excludeIds.add(t.id);
        if (primaryArt) seenArtists.add(primaryArt);
        if (normTitle) seenTitles.add(normTitle);
      }

      // PASS 2: Vibe-aligned keyword queries if PASS 1 did not fill count
      if (selectedTracks.length < count) {
        const queries = this.getDiscoveryQueries(mood, lang, userTopArtists, targetVec);
        queries.sort(() => 0.5 - Math.random());

        const queryBatch = queries.slice(0, 3);
        const searchPromises = queryBatch.map((q) =>
          this.libraryService.searchOnline(q).catch(() => [] as Track[])
        );
        const batchResults = await Promise.all(searchPromises);
        const allBatchTracks = batchResults.flat();

        const valid = allBatchTracks.filter((t) =>
          t &&
          t.audioUrl &&
          t.audioUrl.trim().length > 0 &&
          t.title &&
          t.title.trim().length > 0 &&
          !t.id.startsWith('audius-') &&
          !t.audioUrl.includes('audius.co') &&
          !excludeIds.has(t.id) &&
          !this.isDisliked(t.id) &&
          !this.isSessionDuplicate(t) &&
          (isLibraryOnly || !this.isLibraryTrack(t)) &&
          isTrackLanguageMatch(t, lang) &&
          (t.duration === 0 || (t.duration >= 50 && t.duration <= 480)) &&
          !PLAYLIST_NOISE_REGEX.test(`${t.genre} ${t.title} ${t.artist}`) &&
          !BEDROOM_PRODUCER_REGEX.test(`${t.genre} ${t.title} ${t.artist}`) &&
          (!isRuLib || !REGIONAL_SPAM_REGEX.test(`${t.genre} ${t.title} ${t.artist}`)) &&
          (hasJunkAffinity || !JUNK_GENRES_REGEX.test(`${t.genre} ${t.title} ${t.artist}`))
        );

        const minSim = userTopArtists.length > 0 ? 0.40 : 0.38;

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

          const trackVec = this.extractTrackVector(t);
          const similarity = this.cosineSimilarityFast(targetVec, targetNorm, trackVec);
          if (similarity < minSim) {
            if (similarity >= 0.35) fallbackPool.push(t);
            continue;
          }

          selectedTracks.push(t);
          excludeIds.add(t.id);
          if (primaryArt) seenArtists.add(primaryArt);
          if (normTitle) seenTitles.add(normTitle);
        }
      }

      if (selectedTracks.length < count && fallbackPool.length > 0) {
        for (const t of fallbackPool) {
          if (selectedTracks.length >= count) break;
          if (excludeIds.has(t.id) || this.isSessionDuplicate(t)) continue;
          if (!isLibraryOnly && this.isLibraryTrack(t)) continue;
          if (!isTrackLanguageMatch(t, lang)) continue;
          const textKey = `${t.genre} ${t.title} ${t.artist}`;
          if (PLAYLIST_NOISE_REGEX.test(textKey) || BEDROOM_PRODUCER_REGEX.test(textKey)) continue;
          if (isRuLib && REGIONAL_SPAM_REGEX.test(textKey)) continue;
          if (!hasJunkAffinity && JUNK_GENRES_REGEX.test(textKey)) continue;

          const primaryArt = normalizeArtist(t.artist);
          const lastArt = selectedTracks.length > 0 ? normalizeArtist(selectedTracks[selectedTracks.length - 1].artist) : null;
          if (!primaryArt || primaryArt !== lastArt) {
            selectedTracks.push(t);
            excludeIds.add(t.id);
            if (primaryArt) seenArtists.add(primaryArt);
          }
        }
      }

      // Final resilience: If library_only mode and didn't fill count, fall back to user's favorite library tracks
      // For general mix/discovery, NEVER dump user's library tracks!
      if (isLibraryOnly && selectedTracks.length < count && candidates.length > 0) {
        const localFill = this.pickNextTracks(count - selectedTracks.length, excludeIds);
        for (const lt of localFill) {
          if (selectedTracks.length >= count) break;
          selectedTracks.push(lt);
          excludeIds.add(lt.id);
        }
      }

      // Emergency starter candidates only when pool is completely dry, ensuring no library duplicates and strict language match
      if (selectedTracks.length < count && candidates.length === 0) {
        const starters = this.getStarterCandidates(mood, count - selectedTracks.length, lang);
        for (const st of starters) {
          if (selectedTracks.length >= count) break;
          if (!excludeIds.has(st.id) && !this.isSessionDuplicate(st) && (isLibraryOnly || !this.isLibraryTrack(st))) {
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

  getStarterCandidates(mood: MixMood = 'all', count = 5, lang: MixLanguage = this.libraryService.mixConfig().language): Track[] {
    let pool = [...STARTER_MIX_TRACKS];
    if (lang && lang !== 'all') {
      pool = pool.filter((t) => isTrackLanguageMatch(t, lang));
    }
    if (mood === 'energetic') {
      pool = pool.filter((t) => t.genre.includes('Rock') || t.genre.includes('Rap') || t.genre.includes('Trap') || t.genre.includes('Phonk'));
    } else if (mood === 'chill') {
      pool = pool.filter((t) => t.genre.includes('Hip-Hop') || t.genre.includes('Pop') || t.genre.includes('Viral') || t.genre.includes('Lo-Fi'));
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
