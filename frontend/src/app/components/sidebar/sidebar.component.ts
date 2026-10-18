import { Component, EventEmitter, Input, Output, inject, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LibraryService } from '../../services/library.service';
import { AuthService } from '../../services/auth.service';
import { AudioService } from '../../services/audio.service';
import { TimerService } from '../../services/timer.service';
import { PwaService } from '../../services/pwa.service';
import { ThemeService } from '../../services/theme.service';
import { I18nService } from '../../services/i18n.service';
import { LiveBackgroundService } from '../../services/live-background.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class SidebarComponent {
  readonly libraryService = inject(LibraryService);
  readonly authService = inject(AuthService);
  readonly audioService = inject(AudioService);
  readonly timerService = inject(TimerService);
  readonly pwaService = inject(PwaService);
  readonly themeService = inject(ThemeService);
  readonly i18n = inject(I18nService);
  readonly bgService = inject(LiveBackgroundService);

  @Input() activeTab: 'all' | 'favorites' | 'uploads' | 'streams' | 'playlist' | 'offline' | 'profile' | 'search' | 'charts' | 'library' = 'all';
  @Input() isProfileOpen = false;

  @Output() viewChange = new EventEmitter<{ view: string; playlistId?: string }>();
  @Output() triggerSmartMix = new EventEmitter<void>();
  @Output() createPlaylist = new EventEmitter<void>();
  @Output() openWrapped = new EventEmitter<void>();
  @Output() openHistory = new EventEmitter<void>();
  @Output() openTimer = new EventEmitter<void>();
  @Output() openAuth = new EventEmitter<void>();
  @Output() openProfile = new EventEmitter<void>();
  @Output() openInstallModal = new EventEmitter<void>();

  onMixClick() {
    this.viewChange.emit({ view: 'all' });
    this.triggerSmartMix.emit();
  }
}
