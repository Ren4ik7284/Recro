// @vitest-environment jsdom
import '@angular/compiler';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { RecommendationService } from './recommendation.service';
import { LibraryService } from './library.service';
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
      setMixConfig: vi.fn(),
      getHistory: vi.fn().mockResolvedValue([]),
      searchOnline: vi.fn().mockResolvedValue([]),
      getSimilarTracks: vi.fn().mockResolvedValue([]),
      getRecommendations: vi.fn().mockResolvedValue([]),
      getSoundCloudCharts: vi.fn().mockResolvedValue([]),
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
});
