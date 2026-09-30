import '@angular/compiler';
import { describe, it, expect, beforeEach } from 'vitest';
import { signal, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LyricsService } from './lyrics.service';
import { AudioService } from './audio.service';

describe('LyricsService', () => {
  let service: LyricsService;

  beforeEach(() => {
    const mockAudioService = {
      isPlaying: signal(false),
      currentTime: signal(0),
      getPreciseCurrentTime: () => 0,
      currentTrack: signal(null),
      seek: () => {},
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AudioService, useValue: mockAudioService },
        LyricsService,
      ],
    });

    service = TestBed.inject(LyricsService);
  });

  it('should parse standard LRC and apply [offset:] tag correctly', () => {
    const lrc = `
[ti:Test Song]
[ar:Test Artist]
[offset:500]
[00:01.00]First line
[00:03.00]Second line
    `;

    const parsed = service.parseLrc(lrc, 'lrclib');
    expect(parsed.isSynced).toBe(true);
    expect(parsed.lines.length).toBe(2);

    // 00:01.00 is 1.0s, with offset:500 (0.5s), timestamp should be shifted to 0.5s
    expect(parsed.lines[0].startTime).toBeCloseTo(0.5, 2);
    expect(parsed.lines[0].text).toBe('First line');

    // 00:03.00 is 3.0s, shifted to 2.5s
    expect(parsed.lines[1].startTime).toBeCloseTo(2.5, 2);
    expect(parsed.lines[1].text).toBe('Second line');
  });

  it('should strictly reject songs from wrong artists to prevent displaying incorrect lyrics', () => {
    const score = (service as any).matchScore(
      {
        trackName: 'Love',
        artistName: 'Completely Wrong Artist',
        duration: 200,
        syncedLyrics: '[00:01.00]Love',
      },
      'Love',
      'The Weeknd',
      200
    );

    // Should be disqualified (-999) because artist does not match at all
    expect(score).toBe(-999);
  });

  it('should accept songs when artist and title match', () => {
    const score = (service as any).matchScore(
      {
        trackName: 'Starboy',
        artistName: 'The Weeknd',
        duration: 230,
        syncedLyrics: '[00:01.00]I am tryna put you in the worst mood',
      },
      'Starboy',
      'The Weeknd',
      230
    );

    expect(score).toBeGreaterThanOrEqual(50);
  });

  it('should correctly extract artist and title when title contains Artist - Title format', () => {
    const track = {
      id: 'test-1',
      title: 'Miyagi & Эндшпиль - I Got Love (Official Music Video)',
      artist: 'YouTube Artist',
      duration: 240,
      audioUrl: '',
      genre: '',
      format: 'mp3' as const,
      bitrate: '',
      plays: 0,
      isFavorite: false,
      addedAt: '',
    };

    const info = (service as any).extractSearchInfo(track);
    expect(info.artist.toLowerCase()).toContain('miyagi');
    expect(info.title.toLowerCase()).toContain('i got love');
    expect(info.title.toLowerCase()).not.toContain('official');
  });

  it('should filter out unsynced lines and sort synced lines correctly', () => {
    const lrc = `
[00:02.00]Second line
Unsynced random header
[00:01.00]First line
    `;

    const parsed = service.parseLrc(lrc, 'lrclib');
    expect(parsed.isSynced).toBe(true);
    expect(parsed.lines.length).toBe(2);
    expect(parsed.lines[0].text).toBe('First line');
    expect(parsed.lines[0].startTime).toBe(1.0);
    expect(parsed.lines[1].text).toBe('Second line');
    expect(parsed.lines[1].startTime).toBe(2.0);
  });

  it('should reject wrong song when titles are common single words like Intro or Stay', () => {
    const score = (service as any).matchScore(
      {
        trackName: 'Intro',
        artistName: 'Random Band',
        duration: 120,
        syncedLyrics: '[00:01.00]Hello',
      },
      'Intro',
      'The xx',
      120
    );

    expect(score).toBe(-999);
  });

  it('should reject songs when duration discrepancy exceeds 25 seconds', () => {
    const score = (service as any).matchScore(
      {
        trackName: 'Numb',
        artistName: 'Linkin Park',
        duration: 350, // Long extended remix / live cut
        syncedLyrics: '[00:01.00]I am tired of being what you want me to be',
      },
      'Numb',
      'Linkin Park',
      187 // Original 3:07 studio duration
    );

    expect(score).toBe(-999);
  });

  it('should match Russian and English transliterated artists like Эндшпиль and Endspiel', () => {
    const score = (service as any).matchScore(
      {
        trackName: 'I Got Love',
        artistName: 'MiyaGi & Endspiel',
        duration: 290,
        syncedLyrics: '[00:01.00]I got love',
      },
      'I Got Love',
      'Miyagi & Эндшпиль',
      290
    );

    expect(score).toBeGreaterThanOrEqual(60);
  });

  it('should parse 1-digit, 2-digit, and 3-digit fractional timestamps accurately', () => {
    const lrc = `
[00:01.5]One point five
[00:02.25]Two point twenty five
[00:03.125]Three point one two five
    `;

    const parsed = service.parseLrc(lrc, 'lrclib');
    expect(parsed.lines.length).toBe(3);
    expect(parsed.lines[0].startTime).toBeCloseTo(1.5, 2);
    expect(parsed.lines[1].startTime).toBeCloseTo(2.25, 2);
    expect(parsed.lines[2].startTime).toBeCloseTo(3.125, 2);
  });

  it('should activate the lyrics line with vocal lookahead so line is centered before singing starts', () => {
    const lrc = `
[00:05.00]Line starting at five seconds
[00:10.00]Line starting at ten seconds
    `;
    const parsed = service.parseLrc(lrc, 'lrclib');
    service.currentLyrics.set(parsed);

    // At 4.60s (400ms before 5.0s), lookahead (+0.24s = 4.84s) has not reached 5.0s yet -> line 0 not active
    service.precisePlaybackTime.set(4.60);
    expect(service.activeLineIndex()).toBe(-1);

    // At 4.80s (200ms before 5.0s), lookahead (+0.24s = 5.04s) reaches line 0 -> line 0 is activated in advance
    service.precisePlaybackTime.set(4.80);
    expect(service.activeLineIndex()).toBe(0);

    // At 9.80s (200ms before line 1 at 10.0s), lookahead activates line 1
    service.precisePlaybackTime.set(9.80);
    expect(service.activeLineIndex()).toBe(1);
  });
});
