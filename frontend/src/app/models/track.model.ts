export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  audioUrl: string;
  coverUrl?: string;
  genre: string;
  year?: number;
  format: 'mp3' | 'wav' | 'flac' | 'ogg' | 'm4a' | 'stream';
  bitrate?: string;
  isLossless?: boolean;
  sampleRate?: number;
  bitDepth?: number;
  plays: number;
  isFavorite: boolean;
  addedAt: string;
  isLocalUpload?: boolean;
  isLiveStream?: boolean;
  isOffline?: boolean;
  playlistOnly?: boolean;
  bpm?: number;
}

export interface Playlist {
  id: string;
  title: string;
  description: string;
  trackIds: string[];
  coverText: string;
  coverUrl?: string;
}

export interface RadioStation {
  id: string;
  name: string;
  streamUrl: string;
  genre: string;
  country?: string;
  bitrate?: string;
  favicon?: string;
  isCustom?: boolean;
}

export type MixMood = 'all' | 'energetic' | 'chill' | 'favorites';
export type MixSource = 'balanced' | 'library_only' | 'discovery_heavy';
export type MixLanguage = 'all' | 'ru' | 'en';

export interface MixConfig {
  mood: MixMood;
  source: MixSource;
  language: MixLanguage;
  tasteVector?: any;
}

export const DEFAULT_MIX_CONFIG: MixConfig = {
  mood: 'all',
  source: 'discovery_heavy',
  language: 'all',
};

export interface ChartArtist {
  position: number;
  name: string;
  picture?: string;
  monthly_listeners?: string;
  daily_diff?: string;
  peak?: string;
  spotify_id?: string;
}

export interface ChartSummary {
  id: string;
  title: string;
  subtitle: string;
  cover_url?: string;
  track_count: number;
  updated_at: string;
}

export interface ChartDetail {
  id: string;
  title: string;
  subtitle: string;
  cover_url?: string;
  updated_at: string;
  tracks: Track[];
}

export interface ReleaseItem {
  id: string;
  title: string;
  artist: string;
  cover_url?: string;
  track_count?: number;
  release_date?: string;
  is_playlist: boolean;
}

export interface HomeExploreData {
  popular_tracks: Track[];
  popular_artists: ChartArtist[];
  popular_albums: ReleaseItem[];
  charts: ChartSummary[];
}
