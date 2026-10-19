// @vitest-environment jsdom
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RecommendationService } from './recommendation.service';
import { LibraryService } from './library.service';
import { OfflineService } from './offline.service';
import { NavigationService } from './navigation.service';
import { Track } from '../models/track.model';

describe('Mix and My Wave Pure Discovery Improvements', () => {
  let recService: RecommendationService;
  let mockLibraryService: any;

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {}

    mockLibraryService = {
      mixConfig: signal({
        mood: 'all',
        source: 'discovery_heavy',
        language: 'all',
      }),
      dislikedTrackIds: signal(new Set<string>()),
      tracks: signal<Track[]>([
        {
          id: 'user-lib-1',
          title: 'Numb',
          artist: 'Linkin Park',
          duration: 187,
          audioUrl: 'https://example.com/numb.mp3',
          genre: 'Rock',
          format: 'mp3',
          plays: 10,
          isFavorite: true,
          addedAt: '2026-01-01',
        },
        {
          id: 'user-lib-2',
          title: 'Группа крови',
          artist: 'Кино',
          duration: 240,
          audioUrl: 'https://example.com/kino.mp3',
          genre: 'Rock',
          format: 'mp3',
          plays: 25,
          isFavorite: true,
          addedAt: '2026-01-01',
        },
      ]),
      playlists: signal([]),
      getStorageUserId: () => 'test_user',
      isDisliked: () => false,
      isArtistDisliked: () => false,
      setMixConfig: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
      searchOnline: vi.fn().mockResolvedValue([]),
      getSimilarTracks: vi.fn().mockResolvedValue([]),
      getRecommendations: vi.fn().mockResolvedValue([]),
      getSoundCloudCharts: vi.fn().mockResolvedValue([]),
      isTrackFavorite: (t: any) => !!t?.isFavorite,
    };

    TestBed.configureTestingModule({
      providers: [
        RecommendationService,
        { provide: LibraryService, useValue: mockLibraryService },
      ],
    });

    recService = TestBed.inject(RecommendationService);
  });

  it('should identify all library tracks and variants with isLibraryTrack', () => {
    const directTrack: Track = {
      id: 'user-lib-1',
      title: 'Numb',
      artist: 'Linkin Park',
      duration: 187,
      audioUrl: 'https://example.com/numb.mp3',
      genre: 'Rock',
      format: 'mp3',
      plays: 0,
      isFavorite: false,
      addedAt: '2026-01-01',
    };
    expect(recService.isLibraryTrack(directTrack)).toBe(true);

    const reuploadVariant: Track = {
      id: 'sc-99999',
      title: 'Numb (Official Video)',
      artist: 'Linkin Park',
      duration: 188,
      audioUrl: 'https://example.com/other.mp3',
      genre: 'Rock',
      format: 'mp3',
      plays: 0,
      isFavorite: false,
      addedAt: '2026-01-01',
    };
    expect(recService.isLibraryTrack(reuploadVariant)).toBe(true);

    const freshDiscovery: Track = {
      id: 'sc-88888',
      title: 'In The End',
      artist: 'Linkin Park',
      duration: 216,
      audioUrl: 'https://example.com/in-the-end.mp3',
      genre: 'Rock',
      format: 'mp3',
      plays: 0,
      isFavorite: false,
      addedAt: '2026-01-01',
    };
    expect(recService.isLibraryTrack(freshDiscovery)).toBe(false);
  });

  it('fetchOnlineDiscoveryTracks should strictly filter out library tracks in discovery mode', async () => {
    const candidates: Track[] = [
      { id: 'user-lib-1', title: 'Numb', artist: 'Linkin Park', duration: 187, audioUrl: 'u1', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'sc-101', title: 'Somewhere I Belong', artist: 'Linkin Park', duration: 213, audioUrl: 'u2', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'user-lib-2', title: 'Группа крови (Remastered)', artist: 'Кино', duration: 240, audioUrl: 'u3', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'sc-102', title: 'Звезда по имени Солнце', artist: 'Кино', duration: 225, audioUrl: 'u4', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'sc-103', title: 'Faint', artist: 'Linkin Park', duration: 162, audioUrl: 'u5', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
    ];

    mockLibraryService.getRecommendations.mockResolvedValue(candidates);

    const result = await recService.fetchOnlineDiscoveryTracks(2);
    expect(result.length).toBe(2);

    // None of the returned tracks should be in user library!
    for (const t of result) {
      expect(recService.isLibraryTrack(t)).toBe(false);
    }
  });

  describe('AudioService Pipelined Preload & Stream URL formatting', () => {
    it('formatStreamUrl properly formats /api/stream endpoints with title and artist', async () => {
      const mockOfflineService = {
        isTrackOffline: () => false,
        getCachedBlobUrlSync: () => null,
        getOfflineBlobUrl: vi.fn().mockResolvedValue(null),
        revokePreviousBlobUrls: vi.fn(),
      };
      const mockNavService = {};

      TestBed.resetTestingModule();
      const testBed = TestBed.configureTestingModule({
        providers: [
          RecommendationService,
          { provide: LibraryService, useValue: { ...mockLibraryService, getBackendUrl: () => 'https://example.com' } },
          { provide: OfflineService, useValue: mockOfflineService },
          { provide: NavigationService, useValue: mockNavService },
        ],
      });

      const { AudioService } = await import('./audio.service');
      const audioService = testBed.inject(AudioService);

      const track: Track = {
        id: 'track-1',
        title: 'Numb',
        artist: 'Linkin Park',
        duration: 187,
        audioUrl: 'https://youtube.com/watch?v=123',
        genre: 'Rock',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      const url = audioService.formatStreamUrl(track);
      expect(url).toContain('https://example.com/api/stream?url=');
      expect(url).toContain('title=Numb');
      expect(url).toContain('artist=Linkin%20Park');
    });

    it('preloadNextTrack populates preloadedNextTrack signal with upcoming track', async () => {
      const mockOfflineService = {
        isTrackOffline: () => false,
        getCachedBlobUrlSync: () => null,
        getOfflineBlobUrl: vi.fn().mockResolvedValue(null),
        revokePreviousBlobUrls: vi.fn(),
      };
      const mockNavService = {};

      TestBed.resetTestingModule();
      const testBed = TestBed.configureTestingModule({
        providers: [
          RecommendationService,
          {
            provide: LibraryService,
            useValue: {
              ...mockLibraryService,
              getBackendUrl: () => 'https://example.com',
              formatCoverUrl: () => 'https://example.com/cover.jpg',
            },
          },
          { provide: OfflineService, useValue: mockOfflineService },
          { provide: NavigationService, useValue: mockNavService },
        ],
      });

      const { AudioService } = await import('./audio.service');
      const audioService = testBed.inject(AudioService);

      const track1: Track = { id: 't1', title: 'T1', artist: 'A1', duration: 100, audioUrl: '/api/stream?title=T1', genre: '', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' };
      const track2: Track = { id: 't2', title: 'T2', artist: 'A2', duration: 120, audioUrl: '/api/stream?title=T2', genre: '', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' };

      audioService.queue.set([track1, track2]);
      audioService.queueIndex.set(0);

      audioService.preloadNextTrack();

      expect(audioService.preloadedNextTrack()?.id).toBe('t2');
    });

    it('startSmartMix should strictly never put library tracks in the queue', async () => {
      const mockOfflineService = {
        isTrackOffline: () => false,
        getCachedBlobUrlSync: () => null,
        getOfflineBlobUrl: vi.fn().mockResolvedValue(null),
        revokePreviousBlobUrls: vi.fn(),
      };
      const mockNavService = {};

      const testDiscoveryTrack: Track = {
        id: 'disc-999',
        title: 'New Sensation',
        artist: 'Unknown Artist',
        duration: 180,
        audioUrl: '/api/stream?title=New%20Sensation',
        genre: 'Rock',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      TestBed.resetTestingModule();
      const testBed = TestBed.configureTestingModule({
        providers: [
          RecommendationService,
          {
            provide: LibraryService,
            useValue: {
              ...mockLibraryService,
              getBackendUrl: () => 'https://example.com',
              formatCoverUrl: () => 'https://example.com/cover.jpg',
            },
          },
          { provide: OfflineService, useValue: mockOfflineService },
          { provide: NavigationService, useValue: mockNavService },
        ],
      });

      const rec = testBed.inject(RecommendationService);
      vi.spyOn(rec, 'fetchOnlineDiscoveryTracks').mockResolvedValue([testDiscoveryTrack]);

      const { AudioService } = await import('./audio.service');
      const audioService = testBed.inject(AudioService);

      const ok = await audioService.startSmartMix();
      expect(ok).toBe(true);

      const q = audioService.queue();
      expect(q.length).toBeGreaterThan(0);
      for (const t of q) {
        expect(rec.isLibraryTrack(t)).toBe(false);
      }
    });

    it('auto-advance at end of queue outside mix should never dump library tracks', async () => {
      const mockOfflineService = {
        isTrackOffline: () => false,
        getCachedBlobUrlSync: () => null,
        getOfflineBlobUrl: vi.fn().mockResolvedValue(null),
        revokePreviousBlobUrls: vi.fn(),
      };
      const mockNavService = {};

      const discTrack: Track = {
        id: 'online-disc-1',
        title: 'Discovered Song',
        artist: 'Fresh Artist',
        duration: 200,
        audioUrl: '/api/stream?title=Discovered',
        genre: 'Rock',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      TestBed.resetTestingModule();
      const testBed = TestBed.configureTestingModule({
        providers: [
          RecommendationService,
          {
            provide: LibraryService,
            useValue: {
              ...mockLibraryService,
              getBackendUrl: () => 'https://example.com',
              formatCoverUrl: () => 'https://example.com/cover.jpg',
            },
          },
          { provide: OfflineService, useValue: mockOfflineService },
          { provide: NavigationService, useValue: mockNavService },
        ],
      });

      const rec = testBed.inject(RecommendationService);
      vi.spyOn(rec, 'fetchOnlineDiscoveryTracks').mockResolvedValue([discTrack]);

      const { AudioService } = await import('./audio.service');
      const audioService = testBed.inject(AudioService);

      const singleTrack: Track = {
        id: 'user-lib-1',
        title: 'Numb',
        artist: 'Linkin Park',
        duration: 187,
        audioUrl: 'https://example.com/numb.mp3',
        genre: 'Rock',
        format: 'mp3',
        plays: 10,
        isFavorite: true,
        addedAt: '2026-01-01',
      };

      audioService.queue.set([singleTrack]);
      audioService.queueIndex.set(0);

      // Trigger next() when at the end of the queue
      await audioService.next();

      const newQ = audioService.queue();
      // Should NOT have dumped other library tracks (like user-lib-2: Группа крови)
      const libraryDumps = newQ.filter((t) => t.id === 'user-lib-2');
      expect(libraryDumps.length).toBe(0);
    });

    it('getBufferedDiscoveries should enforce strict artist diversity with max 1 track per artist', () => {
      // Simulate discovery pool having multiple tracks by the same artist
      (recService as any).onlineDiscoveryPool = [
        { id: 'd1', title: 'Song 1', artist: 'Loqiemean', audioUrl: '/a1', duration: 120, genre: 'Rap', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' },
        { id: 'd2', title: 'Song 2', artist: 'Loqiemean', audioUrl: '/a2', duration: 120, genre: 'Rap', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' },
        { id: 'd3', title: 'Song 3', artist: 'Oxxxymiron', audioUrl: '/a3', duration: 120, genre: 'Rap', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' },
        { id: 'd4', title: 'Song 4', artist: 'Loqiemean', audioUrl: '/a4', duration: 120, genre: 'Rap', format: 'mp3', plays: 0, isFavorite: false, addedAt: '' },
      ];

      const discoveries = recService.getBufferedDiscoveries('all');
      const loqTracks = discoveries.filter((t) => t.artist.toLowerCase().includes('loq'));
      // Must not repeat the same artist multiple times
      expect(loqTracks.length).toBe(1);
      expect(discoveries.length).toBe(2); // 1 Loqiemean, 1 Oxxxymiron
    });

    it('startSmartMix should start playback immediately from memory starters', async () => {
      const mockOfflineService = {
        isTrackOffline: () => false,
        getCachedBlobUrlSync: () => null,
        getOfflineBlobUrl: vi.fn().mockResolvedValue(null),
        revokePreviousBlobUrls: vi.fn(),
      };
      const mockNavService = {};

      TestBed.resetTestingModule();
      const testBed = TestBed.configureTestingModule({
        providers: [
          RecommendationService,
          {
            provide: LibraryService,
            useValue: {
              ...mockLibraryService,
              getBackendUrl: () => 'https://example.com',
              formatCoverUrl: () => 'https://example.com/cover.jpg',
            },
          },
          { provide: OfflineService, useValue: mockOfflineService },
          { provide: NavigationService, useValue: mockNavService },
        ],
      });

      const { AudioService } = await import('./audio.service');
      const audioService = testBed.inject(AudioService);

      // Start mix without any pre-warmed buffer: should immediately take starters from memory
      const ok = await audioService.startSmartMix();
      expect(ok).toBe(true);
      expect(audioService.queue().length).toBeGreaterThan(0);
      expect(audioService.currentTrack()).toBeTruthy();
    });

    it('should accept Latin-named CIS artists like ONDA ANDAR and FORTUNA 812', async () => {
      const { isRussianArtist, isRussianTrack, resolveEffectiveLanguage, isTrackLanguageMatch } = await import('./recommendation.service');

      // Default language 'all' must resolve to 'all'
      expect(resolveEffectiveLanguage('all', null, true)).toBe('all');

      // Underground Latin-named artists must be recognized as valid CIS artists
      expect(isRussianArtist('ONDA ANDAR')).toBe(true);
      expect(isRussianArtist('FORTUNA 812')).toBe(true);
      expect(isRussianArtist('CUPSIZE')).toBe(true);

      const trackOnda: Track = {
        id: 'test-onda-1',
        title: 'cachalot',
        artist: 'ONDA ANDAR',
        duration: 120,
        audioUrl: '/api/stream?title=cachalot',
        genre: 'Online',
        format: 'mp3',
        plays: 10,
        isFavorite: true,
        addedAt: '2026-01-01',
      };

      expect(isRussianTrack(trackOnda)).toBe(true);
      expect(isTrackLanguageMatch(trackOnda, 'all')).toBe(true);
      expect(isTrackLanguageMatch(trackOnda, 'ru')).toBe(true);
    });

    it('should detect collaborations / feats with user favorite artists', async () => {
      const { isCollaborationTrack } = await import('./recommendation.service');

      const collabTrack: Track = {
        id: 'test-collab-1',
        title: 'Телепорт (feat. ONDA ANDAR)',
        artist: 'FORTUNA 812',
        duration: 130,
        audioUrl: '/api/stream?title=collab',
        genre: 'Online',
        format: 'mp3',
        plays: 0,
        isFavorite: false,
        addedAt: '2026-01-01',
      };

      const result = isCollaborationTrack(collabTrack, ['onda andar', 'cupsize']);
      expect(result.isCollab).toBe(true);
      expect(result.isDirectSeedFeat).toBe(true);
      expect(result.coArtists).toContain('fortuna 812');
    });
  });
});
