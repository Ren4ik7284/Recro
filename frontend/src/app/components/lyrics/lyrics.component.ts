import {
  Component,
  inject,
  signal,
  ElementRef,
  ViewChild,
  effect,
  HostListener,
  ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LyricsService, LyricLine } from '../../services/lyrics.service';
import { AudioService } from '../../services/audio.service';
import { LibraryService } from '../../services/library.service';

@Component({
  selector: 'app-lyrics-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './lyrics.component.html',
  styleUrl: './lyrics.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class LyricsComponent {
  readonly lyricsService = inject(LyricsService);
  readonly audioService = inject(AudioService);
  readonly libraryService = inject(LibraryService);

  @ViewChild('lyricsScrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  readonly isImportModalOpen = signal<boolean>(false);
  readonly importTextInput = signal<string>('');
  readonly isDraggingFile = signal<boolean>(false);

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

    if (event.key === 'Escape') {
      if (this.isImportModalOpen()) {
        this.isImportModalOpen.set(false);
      } else {
        this.lyricsService.closeLyrics();
      }
    } else if (event.key === '[' || event.key === 'х' || event.key === 'Х') {
      event.preventDefault();
      if (event.shiftKey) {
        this.lyricsService.shiftByLine(-1);
      } else {
        this.lyricsService.adjustOffset(-200);
      }
    } else if (event.key === ']' || event.key === 'ъ' || event.key === 'Ъ') {
      event.preventDefault();
      if (event.shiftKey) {
        this.lyricsService.shiftByLine(1);
      } else {
        this.lyricsService.adjustOffset(200);
      }
    }
  }

  private lastScrolledIndex = -1;

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

  openImportDialog() {
    const curLyrics = this.lyricsService.currentLyrics();
    this.importTextInput.set(curLyrics?.raw || curLyrics?.plainText || '');
    this.isImportModalOpen.set(true);
  }

  closeImportDialog() {
    this.isImportModalOpen.set(false);
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.processLrcFile(input.files[0]);
    }
  }

  onDragOver(e: DragEvent) {
    e.preventDefault();
    this.isDraggingFile.set(true);
  }

  onDragLeave(e: DragEvent) {
    e.preventDefault();
    this.isDraggingFile.set(false);
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.isDraggingFile.set(false);
    if (e.dataTransfer && e.dataTransfer.files.length > 0) {
      this.processLrcFile(e.dataTransfer.files[0]);
    }
  }

  private processLrcFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      this.importTextInput.set(content);
    };
    reader.readAsText(file);
  }

  applyImportedText() {
    const text = this.importTextInput().trim();
    if (!text) return;

    const ok = this.lyricsService.importLrcText(text);
    if (ok) {
      this.isImportModalOpen.set(false);
    }
  }

  reloadFromWeb() {
    const cur = this.audioService.currentTrack();
    if (cur) {
      this.lyricsService.clearCustomLyrics(cur.id);
    }
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  // --- Ручной поиск альтернативного текста (как в Spotify / Apple Music) ---
  readonly isSearchModalOpen = signal<boolean>(false);
  readonly searchQuery = signal<string>('');
  readonly isSearching = signal<boolean>(false);
  readonly searchResults = signal<any[]>([]);

  isCurrentFavorite(): boolean {
    const cur = this.audioService.currentTrack();
    return cur ? this.libraryService.isTrackFavorite(cur) : false;
  }

  toggleFavorite() {
    const cur = this.audioService.currentTrack();
    if (cur) {
      this.libraryService.toggleFavorite(cur.id, cur);
    }
  }

  openSearchDialog() {
    const cur = this.audioService.currentTrack();
    const initialQuery = cur ? `${cur.artist} ${cur.title}`.replace(/unknown|неизвестный/gi, '').trim() : '';
    this.searchQuery.set(initialQuery);
    this.searchResults.set([]);
    this.isSearchModalOpen.set(true);
    if (initialQuery) {
      this.performSearch();
    }
  }

  closeSearchDialog() {
    this.isSearchModalOpen.set(false);
  }

  async performSearch() {
    const q = this.searchQuery().trim();
    if (!q) return;

    this.isSearching.set(true);
    try {
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      const res = await fetch(url);
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items)) {
          this.searchResults.set(items.slice(0, 15));
        } else {
          this.searchResults.set([]);
        }
      }
    } catch (e) {
      console.warn('[Lyrics] Search failed:', e);
      this.searchResults.set([]);
    } finally {
      this.isSearching.set(false);
    }
  }

  selectSearchResult(item: any) {
    const content = item.syncedLyrics || item.plainLyrics;
    if (!content) return;

    const cur = this.audioService.currentTrack();
    const ok = this.lyricsService.importLrcText(content, cur?.id);
    if (ok) {
      this.isSearchModalOpen.set(false);
    }
  }
}
