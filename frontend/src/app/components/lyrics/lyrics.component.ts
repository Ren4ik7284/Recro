import {
  Component,
  inject,
  ElementRef,
  ViewChild,
  effect,
  HostListener,
  ViewEncapsulation,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LyricsService, LyricLine } from '../../services/lyrics.service';
import { AudioService } from '../../services/audio.service';
import { LibraryService } from '../../services/library.service';

@Component({
  selector: 'app-lyrics-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './lyrics.component.html',
  styleUrl: './lyrics.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class LyricsComponent {
  readonly lyricsService = inject(LyricsService);
  readonly audioService = inject(AudioService);
  readonly libraryService = inject(LibraryService);

  @ViewChild('lyricsScrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  private lastScrolledIndex = -1;

  constructor() {
    // Автоскролл к активной строке караоке
    effect(() => {
      const activeIdx = this.lyricsService.activeLineIndex();
      const isLocked = this.lyricsService.isAutoScrollLocked();
      const isOpen = this.lyricsService.isLyricsOpen();

      if (isOpen && !isLocked) {
        requestAnimationFrame(() => this.scrollToActiveLine(activeIdx));
      }
    });

    // Сброс прокрутки при смене трека
    effect(() => {
      const track = this.audioService.currentTrack();
      if (track) {
        this.lastScrolledIndex = -1;
        if (this.scrollContainer?.nativeElement) {
          this.scrollContainer.nativeElement.scrollTop = 0;
        }
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    if (!this.lyricsService.isLyricsOpen()) return;

    // Do not trigger hotkeys if user is focused on an input or textarea
    const targetTag = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (targetTag === 'input' || targetTag === 'textarea') return;

    if (event.key === 'Escape') {
      this.lyricsService.closeLyrics();
    }
  }

  scrollToActiveLine(index: number) {
    if (!this.scrollContainer) return;
    const container = this.scrollContainer.nativeElement;

    // Во время вступительного проигрыша (до первой строчки вокала) держим прокрутку вверху
    if (index < 0) {
      if (this.lastScrolledIndex !== -1) {
        this.lastScrolledIndex = -1;
        container.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    if (index === this.lastScrolledIndex) return;

    const lineElement = container.querySelector(`[data-line-index="${index}"]`) as HTMLElement;

    if (lineElement) {
      this.lastScrolledIndex = index;
      const containerHeight = container.clientHeight;
      const lineTop = lineElement.offsetTop;
      const lineHeight = lineElement.clientHeight;

      const targetScrollTop = lineTop - containerHeight / 2 + lineHeight / 2;

      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth',
      });
    }
  }

  onUserTouchScroll() {
    this.lyricsService.onUserScroll();
  }

  onLineClick(line: LyricLine) {
    if (line.startTime >= 0) {
      this.lyricsService.seekToLine(line);
    }
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  formatOffset(ms: number): string {
    if (!ms || ms === 0) return '0.0s';
    const s = (ms / 1000).toFixed(1);
    return ms > 0 ? `+${s}s` : `${s}s`;
  }

  // --- Scrubber state: preview при drag, seek только при отпускании ---
  readonly isScrubbing = signal<boolean>(false);
  readonly scrubTime = signal<number>(0);

  onScrubberInput(val: number) {
    this.isScrubbing.set(true);
    this.scrubTime.set(val);
  }

  onScrubberChange(val: number) {
    this.isScrubbing.set(false);
    this.audioService.seek(val);
  }
  // ---------------------------------------------------------------------

  isCurrentFavorite(): boolean {
    const cur = this.audioService.currentTrack();
    return cur ? this.libraryService.isTrackFavorite(cur) : false;
  }

  toggleFavorite() {
    const cur = this.audioService.currentTrack();
    if (cur) {
      const isNowFav = this.libraryService.toggleFavorite(cur.id, cur);
      this.audioService.updateTrackFavoriteStatus(cur.id, isNowFav, cur);
      if (isNowFav) {
        this.audioService.recService.recordTrackLike(cur);
      }
    }
  }
}
