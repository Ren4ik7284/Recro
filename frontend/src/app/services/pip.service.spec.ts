import { TestBed } from '@angular/core/testing';
import { PipService } from './pip.service';
import { AudioService } from './audio.service';
import { LyricsService } from './lyrics.service';
import { LibraryService } from './library.service';
import { I18nService } from './i18n.service';
import { provideZonelessChangeDetection } from '@angular/core';

describe('PipService', () => {
  let service: PipService;
  let lyricsService: LyricsService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        PipService,
        AudioService,
        LyricsService,
        LibraryService,
        I18nService,
      ],
    });

    service = TestBed.inject(PipService);
    lyricsService = TestBed.inject(LyricsService);
  });

  it('should be initialized with inactive state', () => {
    expect(service.isPipActive()).toBe(false);
    expect(service.isFloatingFallbackActive()).toBe(false);
  });

  it('should fallback to floating in-app player when Document PiP is not supported', async () => {
    // If window.documentPictureInPicture is undefined in test runner, it should fallback to floating
    await service.openPip();
    expect(service.isFloatingFallbackActive()).toBe(true);
    expect(lyricsService.isExternalTrackingActive()).toBe(true);
  });

  it('should close pip and reset tracking on closePip()', async () => {
    await service.openPip();
    expect(service.isFloatingFallbackActive()).toBe(true);

    service.closePip();
    expect(service.isFloatingFallbackActive()).toBe(false);
    expect(service.isPipActive()).toBe(false);
    expect(lyricsService.isExternalTrackingActive()).toBe(false);
  });

  it('togglePip should flip active state', async () => {
    expect(service.isFloatingFallbackActive()).toBe(false);
    await service.togglePip();
    expect(service.isFloatingFallbackActive()).toBe(true);

    await service.togglePip();
    expect(service.isFloatingFallbackActive()).toBe(false);
  });
});
