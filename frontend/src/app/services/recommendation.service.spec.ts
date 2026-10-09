import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { RecommendationService, normalizeArtist, normalizeTitle } from './recommendation.service';
import { LibraryService } from './library.service';
import { Track } from '../models/track.model';
import { signal } from '@angular/core';

describe('RecommendationService & Mix Anti-Repetition', () => {
  let service: RecommendationService;
  let mockLibraryService: any;

  beforeEach(() => {
    localStorage.clear();

    mockLibraryService = {
      mixConfig: signal({
        mood: 'all',
        source: 'discovery_heavy',
        language: 'all',
      }),
      dislikedTrackIds: signal(new Set<string>()),
      tracks: signal<Track[]>([]),
      playlists: signal([]),
      getStorageUserId: () => 'test_user',
      isDisliked: (id: string) => false,
      setMixConfig: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
      searchOnline: vi.fn().mockResolvedValue([]),
      getSimilarTracks: vi.fn().mockResolvedValue([]),
      getRecommendations: vi.fn().mockResolvedValue([]),
    };

    TestBed.configureTestingModule({
      providers: [
        RecommendationService,
        { provide: LibraryService, useValue: mockLibraryService },
      ],
    });

    service = TestBed.inject(RecommendationService);
  });

  describe('Artist and Title normalization', () => {
    it('should extract primary artist correctly', () => {
      expect(normalizeArtist('Miyagi & Эндшпиль')).toBe('miyagi');
      expect(normalizeArtist('OG Buda feat. MAYOT')).toBe('og buda');
      expect(normalizeArtist('Skrillex, Fred again.. & Flowdan')).toBe('skrillex');
      expect(normalizeArtist('The Weeknd')).toBe('the weeknd');
      expect(normalizeArtist('Big Baby Tape / Kizaru')).toBe('big baby tape');
    });

    it('should clean title and strip brackets/features', () => {
      expect(normalizeTitle('Gimme The Loot (Official Video)')).toBe('gimme the loot');
      expect(normalizeTitle('Cadillac [feat. MORGENSHTERN]')).toBe('cadillac');
      expect(normalizeTitle('Captain (Slowed + Reverb)')).toBe('captain');
    });
  });

  describe('Fatigue and Cooldown tracking', () => {
    it('should record track start and persist to recentPlays', () => {
      const track: Track = {
        id: 'track-1',
        title: 'Song One',
        artist: 'Artist A',
        duration: 180,
        audioUrl: 'http://example.com/1.mp3',
        genre: 'Hip-Hop',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      service.recordTrackStarted(track);
      expect(service.isRecentlyPlayed(track, 30)).toBe(true);
      expect(service.isRecentlyPlayed('track-1', 30)).toBe(true);
    });

    it('should apply strong cooldown penalty to tracks played recently', () => {
      const track: Track = {
        id: 'track-recent',
        title: 'Fresh Song',
        artist: 'Artist A',
        duration: 200,
        audioUrl: 'http://example.com/2.mp3',
        genre: 'Rap',
        format: 'mp3',
        plays: 5,
        isFavorite: true,
        addedAt: '2026-01-01',
      };

      const targetVec = service.getTargetVectorForMood('all');
      const norm = service.computeVectorNorm(targetVec);

      const freshScore = service.scoreTrack(track, 'all', targetVec, norm, null);

      // Now record as recently started
      service.recordTrackStarted(track);

      const penaltyScore = service.scoreTrack(track, 'all', targetVec, norm, null);
      // Fresh vs cooldown: cooldown penalty should be at least -200 points
      expect(freshScore - penaltyScore).toBeGreaterThanOrEqual(200);
    });

    it('should apply heavy frequency penalty if track was played multiple times in 24 hours', () => {
      const track: Track = {
        id: 'track-frequent',
        title: 'Overplayed Song',
        artist: 'Artist B',
        duration: 190,
        audioUrl: 'http://example.com/3.mp3',
        genre: 'Pop',
        format: 'mp3',
        plays: 15,
        isFavorite: true,
        addedAt: '2026-01-01',
      };

      const targetVec = service.getTargetVectorForMood('all');
      const norm = service.computeVectorNorm(targetVec);

      // Record 3 plays today
      service.recordTrackStarted(track);
      service.recordTrackStarted(track);
      service.recordTrackStarted(track);

      const score = service.scoreTrack(track, 'all', targetVec, norm, null);
      // 3 plays today should receive a crippling penalty (< -100)
      expect(score).toBeLessThan(-100);
    });
  });

  describe('Artist Diversity & Anti-Clustering', () => {
    it('should penalize back-to-back same artist', () => {
      const track1: Track = {
        id: 't1',
        title: 'Song 1',
        artist: 'Miyagi & Эндшпиль',
        duration: 180,
        audioUrl: '1',
        genre: 'Rap',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      const track2: Track = {
        id: 't2',
        title: 'Song 2',
        artist: 'Miyagi',
        duration: 190,
        audioUrl: '2',
        genre: 'Rap',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      const targetVec = service.getTargetVectorForMood('all');
      const norm = service.computeVectorNorm(targetVec);

      // When current track has primary artist "miyagi"
      const scoreSame = service.scoreTrack(track2, 'all', targetVec, norm, track1);
      const scoreDiff = service.scoreTrack(track2, 'all', targetVec, norm, null);

      expect(scoreDiff - scoreSame).toBeGreaterThanOrEqual(100);
    });

    it('should pick diverse artists in pickNextTracks', () => {
      const candidates: Track[] = [
        { id: '1', title: 'A1', artist: 'Artist A', duration: 180, audioUrl: '1', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
        { id: '2', title: 'A2', artist: 'Artist A', duration: 180, audioUrl: '2', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
        { id: '3', title: 'A3', artist: 'Artist A', duration: 180, audioUrl: '3', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
        { id: '4', title: 'B1', artist: 'Artist B', duration: 180, audioUrl: '4', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
        { id: '5', title: 'C1', artist: 'Artist C', duration: 180, audioUrl: '5', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
        { id: '6', title: 'D1', artist: 'Artist D', duration: 180, audioUrl: '6', genre: 'Rap', format: 'mp3', plays: 1, isFavorite: false, addedAt: '2026-01-01' },
      ];

      mockLibraryService.tracks.set(candidates);

      const picked = service.pickNextTracks(3, new Set());
      expect(picked.length).toBe(3);

      const artists = picked.map((t) => normalizeArtist(t.artist));
      const uniqueArtists = new Set(artists);
      // All 3 picked tracks must be from different artists
      expect(uniqueArtists.size).toBe(3);
    });

    it('fetchOnlineDiscoveryTracks should guarantee unique artists across returned tracks', async () => {
      // Simulate search results where multiple tracks belong to the same artist (e.g. OG Buda)
      mockLibraryService.searchOnline.mockResolvedValue([
        { id: 'yt-1', title: 'Track 1', artist: 'OG Buda', duration: 180, audioUrl: 'u1' },
        { id: 'yt-2', title: 'Track 2', artist: 'OG Buda', duration: 190, audioUrl: 'u2' },
        { id: 'yt-3', title: 'Track 3', artist: 'OG Buda feat. Mayot', duration: 170, audioUrl: 'u3' },
        { id: 'yt-4', title: 'Track 4', artist: 'Miyagi', duration: 200, audioUrl: 'u4' },
        { id: 'yt-5', title: 'Track 5', artist: 'Saluki', duration: 210, audioUrl: 'u5' },
        { id: 'yt-6', title: 'Track 6', artist: 'Toxi$', duration: 160, audioUrl: 'u6' },
      ]);

      const discovery = await service.fetchOnlineDiscoveryTracks(3);
      expect(discovery.length).toBe(3);

      const artists = discovery.map((t) => normalizeArtist(t.artist));
      const uniqueArtists = new Set(artists);
      // NEVER allow 3 or 4 tracks from OG Buda in a row!
      expect(uniqueArtists.size).toBe(3);
      expect(artists.filter((a) => a === 'og buda').length).toBe(1);
    });

    it('isLibraryTrack should identify library tracks by ID or normalized artist/title', () => {
      mockLibraryService.tracks.set([
        { id: 'lib-1', title: 'Believer', artist: 'Imagine Dragons', duration: 200, audioUrl: 'u', genre: 'Rock', format: 'mp3', plays: 1, isFavorite: true, addedAt: '2026-01-01' },
      ]);

      expect(service.isLibraryTrack({ id: 'lib-1', title: 'Believer', artist: 'Imagine Dragons', duration: 200, audioUrl: 'u', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' })).toBe(true);
      expect(service.isLibraryTrack({ id: 'yt-diff-id', title: 'Believer (Official Video)', artist: 'Imagine Dragons', duration: 200, audioUrl: 'u', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' })).toBe(true);
      expect(service.isLibraryTrack({ id: 'other', title: 'Thunder', artist: 'Imagine Dragons', duration: 200, audioUrl: 'u', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' })).toBe(false);
    });

    it('fetchOnlineDiscoveryTracks should strictly exclude any tracks that are present in user library', async () => {
      // User has Track 1 in their library
      mockLibraryService.tracks.set([
        { id: 'yt-1', title: 'Track 1', artist: 'OG Buda', duration: 180, audioUrl: 'u1', genre: 'Rap', format: 'mp3', plays: 5, isFavorite: true, addedAt: '2026-01-01' },
      ]);

      mockLibraryService.searchOnline.mockResolvedValue([
        { id: 'yt-1', title: 'Track 1', artist: 'OG Buda', duration: 180, audioUrl: 'u1' }, // IN LIBRARY -> MUST BE SKIPPED
        { id: 'yt-4', title: 'Track 4', artist: 'Miyagi', duration: 200, audioUrl: 'u4' },
        { id: 'yt-5', title: 'Track 5', artist: 'Saluki', duration: 210, audioUrl: 'u5' },
      ]);

      const discovery = await service.fetchOnlineDiscoveryTracks(2);
      expect(discovery.length).toBe(2);
      // Track 1 must NOT appear in the discovery results
      expect(discovery.some((t) => t.id === 'yt-1')).toBe(false);
      expect(discovery.map((t) => t.id)).toEqual(['yt-4', 'yt-5']);
    });
  });
});
