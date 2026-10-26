import { Component, EventEmitter, Output, inject, signal, ViewEncapsulation, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LibraryService } from '../../services/library.service';
import { AuthService } from '../../services/auth.service';
import { AudioService } from '../../services/audio.service';
import { PwaService, InstallPlatform } from '../../services/pwa.service';
import { ThemeService } from '../../services/theme.service';
import { I18nService } from '../../services/i18n.service';

@Component({
  selector: 'app-header-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class HeaderComponent {
  readonly libraryService = inject(LibraryService);
  readonly authService = inject(AuthService);
  readonly audioService = inject(AudioService);
  readonly pwaService = inject(PwaService);
  readonly themeService = inject(ThemeService);
  readonly i18n = inject(I18nService);

  @Output() openAddModal = new EventEmitter<void>();
  @Output() openOnlineSearch = new EventEmitter<string>();
  @Output() openAuthModal = new EventEmitter<void>();
  @Output() openWrappedModal = new EventEmitter<void>();
  @Output() openHistoryModal = new EventEmitter<void>();
  @Output() openProfileModal = new EventEmitter<void>();
  @Output() openInstallModal = new EventEmitter<InstallPlatform | void>();
  @Output() openMyMusic = new EventEmitter<void>();

  readonly isUserMenuOpen = signal<boolean>(false);

  toggleUserMenu() {
    this.isUserMenuOpen.update((v) => !v);
  }

  closeUserMenu() {
    this.isUserMenuOpen.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.isUserMenuOpen()) return;
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('.user-menu-container')) {
      this.closeUserMenu();
    }
  }

  handleProfileClick() {
    this.closeUserMenu();
    this.openProfileModal.emit();
  }

  handleWrappedClick() {
    this.closeUserMenu();
    this.openWrappedModal.emit();
  }

  handleHistoryClick() {
    this.closeUserMenu();
    this.openHistoryModal.emit();
  }

  handleInstallClick(platform?: InstallPlatform) {
    this.closeUserMenu();
    this.openInstallModal.emit(platform);
  }

  handleLogout() {
    this.closeUserMenu();
    this.audioService.resetSessionAudio();
    this.authService.logout();
    this.libraryService.onUserLoggedOut();
  }
}
