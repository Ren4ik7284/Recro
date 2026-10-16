import { TestBed } from '@angular/core/testing';
import { I18nService } from './i18n.service';
import { LibraryService } from './library.service';
import { Playlist, Track } from '../models/track.model';

describe('Playlist Drag & Drop and i18n Translations', () => {
  let i18n: I18nService;
  let libraryService: LibraryService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    i18n = TestBed.inject(I18nService);
    libraryService = TestBed.inject(LibraryService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('i18n Translations', () => {
    it('should translate Smart Wave strings in both ru and en', () => {
      i18n.setLanguage('ru');
      expect(i18n.t('wave.title')).toBe('Моя Волна');
      expect(i18n.t('wave.desc')).toBe('Бесконечный умный поток музыки, настроенный под ваши интересы и вкус.');
      expect(i18n.t('wave.start')).toBe('Запустить волну');
      expect(i18n.t('wave.startBtnTitle')).toBe('Включить Мою Волну');
      expect(i18n.t('wave.onAir')).toBe('В ЭФИРЕ • МОЯ ВОЛНА');
      expect(i18n.t('wave.discoveryFlow')).toBe('ПОТОК ОТКРЫТИЙ');
      expect(i18n.t('wave.moodAll')).toBe('ВСЕ СТИЛИ');

      i18n.setLanguage('en');
      expect(i18n.t('wave.title')).toBe('My Wave');
      expect(i18n.t('wave.desc')).toBe('Endless smart stream of music tailored to your taste and interests.');
      expect(i18n.t('wave.start')).toBe('Start My Wave');
      expect(i18n.t('wave.startBtnTitle')).toBe('Turn on My Wave');
      expect(i18n.t('wave.onAir')).toBe('ON AIR • MY WAVE');
      expect(i18n.t('wave.discoveryFlow')).toBe('DISCOVERY STREAM');
      expect(i18n.t('wave.moodAll')).toBe('ALL STYLES');
    });

    it('should translate Table Header strings in both ru and en', () => {
      i18n.setLanguage('ru');
      expect(i18n.t('table.artistSource')).toBe('ИСПОЛНИТЕЛЬ / ИСТОЧНИК');
      expect(i18n.t('table.actions')).toBe('ДЕЙСТВИЯ');

      i18n.setLanguage('en');
      expect(i18n.t('table.artistSource')).toBe('ARTIST / SOURCE');
      expect(i18n.t('table.actions')).toBe('ACTIONS');
    });

    it('should translate Playlist and Profile strings in both ru and en', () => {
      i18n.setLanguage('ru');
      expect(i18n.t('profile.allPlaylists')).toBe('ВСЕ ПЛЕЙЛИСТЫ');
      expect(i18n.t('profile.totalPlaylists')).toBe('ВСЕГО:');
      expect(i18n.t('profile.newPlaylistBtn')).toBe('Новый плейлист');
      expect(i18n.t('playlist.createNew')).toBe('Создать новый плейлист');

      i18n.setLanguage('en');
      expect(i18n.t('profile.allPlaylists')).toBe('ALL PLAYLISTS');
      expect(i18n.t('profile.totalPlaylists')).toBe('TOTAL:');
      expect(i18n.t('profile.newPlaylistBtn')).toBe('New Playlist');
      expect(i18n.t('playlist.createNew')).toBe('Create new playlist');
    });
  });

  describe('Playlist Track Drag and Drop Reordering', () => {
    const dummyTracks: Track[] = [
      { id: 'track-1', title: 'Track One', artist: 'Artist A', audioUrl: 'https://ex.com/1.mp3', duration: 180, genre: 'Pop', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'track-2', title: 'Track Two', artist: 'Artist B', audioUrl: 'https://ex.com/2.mp3', duration: 200, genre: 'Rock', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'track-3', title: 'Track Three', artist: 'Artist C', audioUrl: 'https://ex.com/3.mp3', duration: 220, genre: 'Jazz', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' },
      { id: 'track-4', title: 'Track Four', artist: 'Artist D', audioUrl: 'https://ex.com/4.mp3', duration: 240, genre: 'Metal', format: 'mp3', plays: 0, isFavorite: false, addedAt: '2026-01-01' }
    ];

    let testPlaylist: Playlist;

    beforeEach(() => {
      dummyTracks.forEach(t => libraryService.addTrackToLibrary(t));

      testPlaylist = libraryService.createPlaylist('My Mix');
      dummyTracks.forEach(t => libraryService.toggleTrackInPlaylist(testPlaylist.id, t.id));
    });

    it('should reorder tracks when moving a track down after another track', () => {
      libraryService.reorderTracksInPlaylist(testPlaylist.id, 'track-1', 'track-3', 'after');

      const updated = libraryService.playlists().find(p => p.id === testPlaylist.id);
      expect(updated).toBeDefined();
      expect(updated!.trackIds).toEqual(['track-2', 'track-3', 'track-1', 'track-4']);
    });

    it('should reorder tracks when moving a track up before another track', () => {
      libraryService.reorderTracksInPlaylist(testPlaylist.id, 'track-4', 'track-2', 'before');

      const updated = libraryService.playlists().find(p => p.id === testPlaylist.id);
      expect(updated).toBeDefined();
      expect(updated!.trackIds).toEqual(['track-1', 'track-4', 'track-2', 'track-3']);
    });

    it('should preserve playlist order in filteredTracks when activeTab is playlist', () => {
      libraryService.activePlaylistId.set(testPlaylist.id);
      libraryService.selectedView.set('playlist');

      let filtered = libraryService.filteredTracks();
      expect(filtered.map(t => t.id)).toEqual(['track-1', 'track-2', 'track-3', 'track-4']);

      libraryService.reorderTracksInPlaylist(testPlaylist.id, 'track-4', 'track-1', 'before');

      filtered = libraryService.filteredTracks();
      expect(filtered.map(t => t.id)).toEqual(['track-4', 'track-1', 'track-2', 'track-3']);
    });
  });
});
