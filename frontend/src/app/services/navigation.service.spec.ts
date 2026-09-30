// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NavigationService } from './navigation.service';

describe('NavigationService', () => {
  let service: NavigationService;

  beforeEach(() => {
    service = new NavigationService();
  });

  it('should parse root or empty hash as tab all with no overlay', () => {
    expect(service.parseHash('')).toEqual({ tab: 'all', overlay: null });
    expect(service.parseHash('#/')).toEqual({ tab: 'all', overlay: null });
    expect(service.parseHash('#')).toEqual({ tab: 'all', overlay: null });
  });

  it('should parse standard tab hashes correctly', () => {
    expect(service.parseHash('#/favorites')).toEqual({ tab: 'favorites', overlay: null });
    expect(service.parseHash('#/streams')).toEqual({ tab: 'streams', overlay: null });
    expect(service.parseHash('#/uploads')).toEqual({ tab: 'uploads', overlay: null });
    expect(service.parseHash('#/offline')).toEqual({ tab: 'offline', overlay: null });
  });

  it('should parse playlist routes with id correctly', () => {
    expect(service.parseHash('#/playlist/my-cool-playlist')).toEqual({
      tab: 'playlist',
      playlistId: 'my-cool-playlist',
      overlay: null,
    });
  });

  it('should parse overlay routes on tabs or directly', () => {
    expect(service.parseHash('#/lyrics')).toEqual({ tab: 'all', overlay: 'lyrics' });
    expect(service.parseHash('#/player')).toEqual({ tab: 'all', overlay: 'player' });
    expect(service.parseHash('#/favorites/lyrics')).toEqual({ tab: 'favorites', overlay: 'lyrics' });
    expect(service.parseHash('#/streams/visualizer')).toEqual({ tab: 'streams', overlay: 'visualizer' });
    expect(service.parseHash('#/playlist/123/lyrics')).toEqual({
      tab: 'playlist',
      playlistId: '123',
      overlay: 'lyrics',
    });
  });

  it('should build hash correctly for tabs and overlays', () => {
    expect(service.buildHash('all', null, null)).toBe('#/');
    expect(service.buildHash('favorites', null, null)).toBe('#/favorites');
    expect(service.buildHash('playlist', 'rock-123', null)).toBe('#/playlist/rock-123');
    expect(service.buildHash('favorites', null, 'lyrics')).toBe('#/favorites/lyrics');
    expect(service.buildHash('playlist', 'rock-123', 'lyrics')).toBe('#/playlist/rock-123/lyrics');
  });

  it('should notify callback when location changes', () => {
    const callback = vi.fn();
    service.init(callback);

    expect(callback).toHaveBeenCalled();
  });
});
