import { TestBed } from '@angular/core/testing';
import { AudioService } from './audio.service';
import { Track } from '../models/track.model';

describe('AudioService - Shuffle and Repeat functionality', () => {
  let audioService: AudioService;

  const mockTracks: Track[] = [
    { id: 't1', title: 'Song 1', artist: 'Artist A', duration: 180, audioUrl: '/api/stream?id=t1', genre: 'Pop', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
    { id: 't2', title: 'Song 2', artist: 'Artist B', duration: 200, audioUrl: '/api/stream?id=t2', genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
    { id: 't3', title: 'Song 3', artist: 'Artist C', duration: 210, audioUrl: '/api/stream?id=t3', genre: 'Jazz', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
    { id: 't4', title: 'Song 4', artist: 'Artist D', duration: 190, audioUrl: '/api/stream?id=t4', genre: 'Electronic', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
  ];

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    audioService = TestBed.inject(AudioService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('Repeat functionality', () => {
    it('should cycle repeat mode from off -> one -> all -> off', () => {
      expect(audioService.repeatMode()).toBe('off');

      // 1st click: off -> one (repeat current track)
      audioService.cycleRepeat();
      expect(audioService.repeatMode()).toBe('one');
      expect(audioService.toastNotice()?.message).toContain('Повтор текущего трека включен');

      // 2nd click: one -> all (repeat entire queue/playlist)
      audioService.cycleRepeat();
      expect(audioService.repeatMode()).toBe('all');
      expect(audioService.toastNotice()?.message).toContain('Повтор всей очереди включен');

      // 3rd click: all -> off
      audioService.cycleRepeat();
      expect(audioService.repeatMode()).toBe('off');
      expect(audioService.toastNotice()?.message).toContain('Повтор выключен');
    });

    it('should persist repeat mode in localStorage', () => {
      audioService.cycleRepeat(); // one
      expect(localStorage.getItem('signal_player_repeat')).toBe('one');
      audioService.cycleRepeat(); // all
      expect(localStorage.getItem('signal_player_repeat')).toBe('all');
      audioService.cycleRepeat(); // off
      expect(localStorage.getItem('signal_player_repeat')).toBe('off');
    });

    it('should loop back to start when queue ends in repeat all mode', async () => {
      audioService.queue.set([...mockTracks]);
      audioService.queueIndex.set(mockTracks.length - 1);
      audioService.repeatMode.set('all');

      await audioService.next(true);

      // Should wrap around to index 0
      expect(audioService.queueIndex()).toBe(0);
    });
  });

  describe('Shuffle functionality', () => {
    it('should toggle shuffle state and notify user', () => {
      expect(audioService.isShuffle()).toBe(false);

      audioService.toggleShuffle();
      expect(audioService.isShuffle()).toBe(true);
      expect(audioService.toastNotice()?.message).toBe('Случайный порядок включен');
      expect(localStorage.getItem('signal_player_shuffle')).toBe('true');

      audioService.toggleShuffle();
      expect(audioService.isShuffle()).toBe(false);
      expect(audioService.toastNotice()?.message).toBe('Случайный порядок выключен');
      expect(localStorage.getItem('signal_player_shuffle')).toBe('false');
    });

    it('should shuffle upcoming tracks when shuffle is enabled and restore when disabled', () => {
      audioService.queue.set([...mockTracks]);
      audioService.queueIndex.set(0);
      audioService.currentTrack.set(mockTracks[0]);

      // Turn shuffle ON
      audioService.toggleShuffle();
      expect(audioService.isShuffle()).toBe(true);
      expect(audioService.queue().length).toBe(mockTracks.length);
      // The current track should remain at index 0
      expect(audioService.queue()[0].id).toBe(mockTracks[0].id);

      // Turn shuffle OFF - queue should restore original order
      audioService.toggleShuffle();
      expect(audioService.isShuffle()).toBe(false);
      expect(audioService.queue().map(t => t.id)).toEqual(mockTracks.map(t => t.id));
    });

    it('should start with selected track and shuffle remainder when playing with shuffle ON', async () => {
      audioService.isShuffle.set(true);

      const chosenTrack = mockTracks[2];
      await audioService.playTrack(chosenTrack, mockTracks, false, 2);

      const q = audioService.queue();
      expect(q.length).toBe(mockTracks.length);
      expect(q[0].id).toBe(chosenTrack.id);
      expect(audioService.queueIndex()).toBe(0);
      // All other tracks should be present in the queue
      const ids = new Set(q.map(t => t.id));
      expect(ids.size).toBe(mockTracks.length);
    });
  });
});
