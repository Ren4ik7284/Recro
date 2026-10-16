import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AudioService } from '../../services/audio.service';
import { LyricsService } from '../../services/lyrics.service';
import { LibraryService } from '../../services/library.service';
import { PipService } from '../../services/pip.service';
import { I18nService } from '../../services/i18n.service';

@Component({
  selector: 'app-floating-mini-player',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './floating-mini-player.component.html',
  styleUrl: './floating-mini-player.component.scss',
})
export class FloatingMiniPlayerComponent {
  readonly audioService = inject(AudioService);
  readonly lyricsService = inject(LyricsService);
  readonly libraryService = inject(LibraryService);
  readonly pipService = inject(PipService);
  readonly i18n = inject(I18nService);

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }

  isCurrentFavorite(): boolean {
    const cur = this.audioService.currentTrack();
    return cur ? this.libraryService.isTrackFavorite(cur) : false;
  }

  toggleFavorite() {
    const cur = this.audioService.currentTrack();
    if (cur) {
      const isNowFav = this.libraryService.toggleFavorite(cur.id, cur);
      this.audioService.updateTrackFavoriteStatus(cur.id, isNowFav, cur);
    }
  }

  onSeek(event: MouseEvent, trackEl: HTMLElement) {
    const rect = trackEl.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clickX / rect.width));
    const dur = this.audioService.duration();
    if (dur && dur > 0) {
      this.audioService.seek(pct * dur);
    }
  }

  expandLyrics() {
    this.lyricsService.openLyrics();
  }
}
