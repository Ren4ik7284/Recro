import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { LibraryService } from './library.service';
import { Track } from '../models/track.model';

describe('Cross-device Sync & Token Persistence', () => {
  let authService: AuthService;
  let libraryService: LibraryService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [AuthService, LibraryService],
    });
    authService = TestBed.inject(AuthService);
    libraryService = TestBed.inject(LibraryService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should persist and restore JWT token from localStorage across sessions', () => {
    const testToken = 'jwt-mock-sync-token-12345';
    const testUser = {
      id: 'user-pc-1',
      username: 'Recroz',
      email: 'recroz@test.com',
    };

    (authService as any).persistSession(testToken, testUser);

    expect(localStorage.getItem('signal_auth_jwt_token')).toBe(testToken);
    expect(authService.getAuthToken()).toBe(testToken);
    expect(authService.getAuthHeaders()).toEqual({
      Authorization: `Bearer ${testToken}`,
    });

    // Simulate session reload on another tab or app restart
    (authService as any).token.set(null);
    expect(authService.getAuthToken()).toBeNull();

    (authService as any).restoreSession();
    expect(authService.getAuthToken()).toBe(testToken);
    expect(authService.getAuthHeaders()).toEqual({
      Authorization: `Bearer ${testToken}`,
    });
  });

  it('should sanitize localhost URLs into current backend URL in sanitizeTracks', () => {
    const testTracks: Track[] = [
      {
        id: 'track-1',
        title: 'Song One',
        artist: 'Artist One',
        audioUrl: 'http://localhost:8085/api/stream?title=Song%20One&artist=Artist%20One',
        coverUrl: 'http://localhost:8085/api/cover?track=1',
        genre: 'Trap',
        format: 'mp3',
        plays: 5,
        duration: 120,
        isFavorite: false,
        addedAt: '2026-10-17',
      },
      {
        id: 'track-2',
        title: 'Song Two',
        artist: 'Artist Two',
        audioUrl: 'https://recro.onrender.com/api/stream?title=Song%20Two',
        genre: 'Hip-Hop',
        format: 'mp3',
        plays: 10,
        duration: 150,
        isFavorite: false,
        addedAt: '2026-10-17',
      },
    ];

    vi.spyOn(libraryService, 'getBackendUrl').mockReturnValue('https://recro.80.87.202.157.sslip.io');
    const sanitized = libraryService.sanitizeTracks(testTracks);
    expect(sanitized[0].audioUrl).not.toContain('localhost:8085');
    expect(sanitized[0].coverUrl).not.toContain('localhost:8085');
    expect(sanitized[0].audioUrl).toContain('https://recro.80.87.202.157.sslip.io/api/stream');
    expect(sanitized[0].coverUrl).toContain('https://recro.80.87.202.157.sslip.io/api/cover');
  });

  it('should perform bidirectional track merge preserving both local and cloud tracks without loss', () => {
    const cloudTracks: Track[] = [
      {
        id: 'cloud-1',
        title: 'Track Cloud Only',
        artist: 'Artist A',
        audioUrl: 'https://recro.onrender.com/api/stream?1',
        genre: 'Pop',
        format: 'mp3',
        plays: 2,
        isFavorite: false,
        duration: 120,
        addedAt: '2026-10-17',
      },
      {
        id: 'shared-1',
        title: 'Shared Track',
        artist: 'Artist Shared',
        audioUrl: 'https://recro.onrender.com/api/stream?shared',
        genre: 'Rock',
        format: 'mp3',
        plays: 10,
        isFavorite: false,
        duration: 180,
        addedAt: '2026-10-17',
      },
    ];

    const localTracks: Track[] = [
      {
        id: 'local-1',
        title: 'Track Local Only (e.g. added on mobile)',
        artist: 'Artist Mobile',
        audioUrl: 'https://recro.onrender.com/api/stream?mobile',
        genre: 'Rap',
        format: 'mp3',
        plays: 1,
        isFavorite: true,
        duration: 140,
        addedAt: '2026-10-17',
      },
      {
        id: 'shared-1',
        title: 'Shared Track',
        artist: 'Artist Shared',
        audioUrl: 'https://recro.onrender.com/api/stream?shared',
        genre: 'Rock',
        format: 'mp3',
        plays: 25,
        isFavorite: true, // favorited locally
        duration: 180,
        addedAt: '2026-10-17',
      },
    ];

    const result = (libraryService as any).mergeTrackLists(localTracks, cloudTracks);

    expect(result.merged.length).toBe(3);
    expect(result.hasNewLocal).toBe(true);

    const shared = result.merged.find((t: Track) => t.id === 'shared-1');
    expect(shared).toBeDefined();
    expect(shared.plays).toBe(25); // Took maximum plays
    expect(shared.isFavorite).toBe(true); // Preserved local favorite

    const localOnly = result.merged.find((t: Track) => t.id === 'local-1');
    expect(localOnly).toBeDefined();

    const cloudOnly = result.merged.find((t: Track) => t.id === 'cloud-1');
    expect(cloudOnly).toBeDefined();
  });
});
