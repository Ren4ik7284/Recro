import { Component, inject, signal, computed, input, output, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { LibraryService } from '../../services/library.service';
import { AudioService } from '../../services/audio.service';
import { NavigationService } from '../../services/navigation.service';
import { Track, Playlist } from '../../models/track.model';

export interface ColoredTag {
  text: string;
  color: string;
}

export interface ProfileArtist {
  name: string;
  plays: number;
  coverUrl?: string;
  rank?: number;
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss'],
})
export class ProfileComponent {
  readonly authService = inject(AuthService);
  readonly libraryService = inject(LibraryService);
  readonly audioService = inject(AudioService);
  readonly navService = inject(NavigationService);

  @ViewChild('carouselRef') carouselRef!: ElementRef<HTMLDivElement>;
  @ViewChild('avatarFileInput') avatarFileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('bannerFileInput') bannerFileInput?: ElementRef<HTMLInputElement>;

  readonly showCloseButton = input<boolean>(false);
  readonly close = output<void>();
  readonly openPlaylist = output<string>();
  readonly createPlaylist = output<void>();
  readonly searchArtist = output<string>();

  readonly isSettingsOpen = signal<boolean>(false);
  readonly isAvatarModalOpen = signal<boolean>(false);
  readonly isBannerModalOpen = signal<boolean>(false);
  readonly isAddTagOpen = signal<boolean>(false);

  readonly newTagInput = signal<string>('');
  readonly selectedTagColor = signal<string>('#8b5cf6');
  readonly tagError = signal<string | null>(null);

  readonly editUsername = signal<string>('');
  readonly editAvatarUrl = signal<string>('');
  readonly editBannerUrl = signal<string>('');

  readonly tagColorPresets: string[] = [
    '#8b5cf6',
    '#ec4899',
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#06b6d4',
    '#6366f1',
    '#14b8a6',
    '#d946ef',
  ];

  private readonly STORAGE_TAGS_PREFIX = 'recro_profile_tags_colored_';

  readonly userTags = signal<ColoredTag[]>(this.loadUserTags());

  readonly userPlaylists = computed<Playlist[]>(() => this.libraryService.playlists());

  readonly historyArtists = signal<ProfileArtist[]>([]);
  readonly worldTopArtists = signal<ProfileArtist[]>([]);

  readonly topArtists = computed<ProfileArtist[]>(() => {
    const tracks = this.libraryService.tracks();
    const artistMap = new Map<string, { plays: number; coverUrl?: string }>();

    for (const t of tracks) {
      if (!t.artist || !t.artist.trim()) continue;
      const primary = t.artist.split(/\b(?:feat\.?|ft\.?|with|x)\b|[&,/]/i)[0].trim();
      if (!primary || primary.length < 2) continue;

      const current = artistMap.get(primary) || { plays: 0, coverUrl: t.coverUrl };
      const weight = (t.plays || 0) + (t.isFavorite ? 3 : 1);
      current.plays += weight;
      if (!current.coverUrl && t.coverUrl) {
        current.coverUrl = t.coverUrl;
      }
      artistMap.set(primary, current);
    }

    for (const ha of this.historyArtists()) {
      const cur = artistMap.get(ha.name);
      if (cur) {
        cur.plays += ha.plays;
        if (!cur.coverUrl && ha.coverUrl) cur.coverUrl = ha.coverUrl;
      } else {
        artistMap.set(ha.name, { plays: ha.plays, coverUrl: ha.coverUrl });
      }
    }

    if (artistMap.size > 0) {
      return Array.from(artistMap.entries())
        .map(([name, data]) => ({
          name,
          plays: data.plays,
          coverUrl: data.coverUrl,
        }))
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 15)
        .map((a, idx) => ({ ...a, rank: idx + 1 }));
    }

    return this.worldTopArtists();
  });

  constructor() {
    this.fetchMonthlyArtistsFromHistory();
    this.fetchWorldTopArtists();
  }

  private async fetchWorldTopArtists() {
    try {
      const top = await this.libraryService.getTopArtists();
      if (Array.isArray(top) && top.length > 0) {
        const mapped: ProfileArtist[] = top.map((item, idx) => ({
          name: item.name,
          plays: 0,
          coverUrl: item.picture,
          rank: item.position || idx + 1,
        }));
        this.worldTopArtists.set(mapped);
      }
    } catch {}
  }

  private async fetchMonthlyArtistsFromHistory() {
    try {
      const history = await this.libraryService.getHistory();
      if (!Array.isArray(history) || history.length === 0) return;

      const monthAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
      const map = new Map<string, { plays: number; coverUrl?: string }>();

      for (const item of history) {
        if (item.played_at && item.played_at < monthAgo) continue;
        if (!item.track_artist) continue;
        const primary = item.track_artist.split(/\b(?:feat\.?|ft\.?|with|x)\b|[&,/]/i)[0].trim();
        if (!primary || primary.length < 2) continue;

        const cur = map.get(primary) || { plays: 0, coverUrl: item.cover_url };
        cur.plays += 1;
        if (!cur.coverUrl && item.cover_url) cur.coverUrl = item.cover_url;
        map.set(primary, cur);
      }

      const list: ProfileArtist[] = Array.from(map.entries()).map(([name, data]) => ({
        name,
        plays: data.plays,
        coverUrl: data.coverUrl,
      }));
      this.historyArtists.set(list);
    } catch {}
  }

  private loadUserTags(): ColoredTag[] {
    const user = this.authService.currentUser();
    if (user?.profile_tags) {
      try {
        const parsed = JSON.parse(user.profile_tags);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return this.normalizeTags(parsed);
        }
      } catch {}
    }
    if (typeof localStorage === 'undefined') return [];
    try {
      const key = `${this.STORAGE_TAGS_PREFIX}${user?.id || 'guest'}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return this.normalizeTags(parsed);
      }
    } catch {}
    return [];
  }

  private normalizeTags(list: any[]): ColoredTag[] {
    return list.map((item, idx) => {
      if (typeof item === 'string') {
        const defaultColor = this.tagColorPresets[idx % this.tagColorPresets.length];
        return { text: item, color: defaultColor };
      }
      return {
        text: item.text || 'Тег',
        color: item.color || '#8b5cf6',
      };
    });
  }

  private saveUserTags(tags: ColoredTag[]) {
    const user = this.authService.currentUser();
    const str = JSON.stringify(tags);
    if (typeof localStorage !== 'undefined') {
      try {
        const key = `${this.STORAGE_TAGS_PREFIX}${user?.id || 'guest'}`;
        localStorage.setItem(key, str);
      } catch {}
    }
    if (this.authService.isAuthenticated()) {
      this.authService.updateProfile({ profile_tags: str }, this.libraryService.getBackendUrl());
    }
  }

  openSettings() {
    const user = this.authService.currentUser();
    this.editUsername.set(user?.username || 'Nickname');
    this.editAvatarUrl.set(user?.avatar_url || '');
    this.editBannerUrl.set(user?.banner_url || '');
    this.isSettingsOpen.set(true);
  }

  closeSettings() {
    this.isSettingsOpen.set(false);
  }

  saveSettings() {
    const name = this.editUsername().trim();
    if (name) {
      this.authService.updateProfile({
        username: name,
        avatar_url: this.editAvatarUrl().trim() || undefined,
        banner_url: this.editBannerUrl().trim() || undefined,
      }, this.libraryService.getBackendUrl());
    }
    this.closeSettings();
  }

  openAvatarModal() {
    const user = this.authService.currentUser();
    this.editAvatarUrl.set(user?.avatar_url || '');
    this.isAvatarModalOpen.set(true);
  }

  closeAvatarModal() {
    this.isAvatarModalOpen.set(false);
  }

  saveAvatar() {
    this.authService.updateProfile({
      avatar_url: this.editAvatarUrl().trim() || undefined,
    }, this.libraryService.getBackendUrl());
    this.closeAvatarModal();
  }

  triggerAvatarFile() {
    this.avatarFileInput?.nativeElement?.click();
  }

  onAvatarFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      this.editAvatarUrl.set(dataUrl);
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  triggerBannerFile() {
    this.bannerFileInput?.nativeElement?.click();
  }

  onBannerFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      this.editBannerUrl.set(dataUrl);
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  removeAvatar() {
    this.editAvatarUrl.set('');
  }

  removeBanner() {
    this.editBannerUrl.set('');
  }

  openBannerModal() {
    const user = this.authService.currentUser();
    this.editBannerUrl.set(user?.banner_url || '');
    this.isBannerModalOpen.set(true);
  }

  closeBannerModal() {
    this.isBannerModalOpen.set(false);
  }

  saveBanner() {
    this.authService.updateProfile({
      banner_url: this.editBannerUrl().trim() || undefined,
    }, this.libraryService.getBackendUrl());
    this.closeBannerModal();
  }

  openAddTag() {
    this.newTagInput.set('');
    this.selectedTagColor.set('#8b5cf6');
    this.tagError.set(null);
    this.isAddTagOpen.set(true);
  }

  closeAddTag() {
    this.isAddTagOpen.set(false);
    this.tagError.set(null);
  }

  selectTagColor(color: string) {
    this.selectedTagColor.set(color);
  }

  createTag() {
    const raw = this.newTagInput().trim();
    const sanitized = raw.replace(/[^\p{L}\p{N}\s\-_]/gu, '').trim();

    if (!sanitized) {
      this.tagError.set('Введите текст тега без спецсимволов и эмодзи');
      return;
    }

    if (sanitized.length > 20) {
      this.tagError.set('Длина тега не более 20 символов');
      return;
    }

    const current = this.userTags();
    if (current.some((t) => t.text.toLowerCase() === sanitized.toLowerCase())) {
      this.tagError.set('Такой тег уже добавлен');
      return;
    }

    const updated: ColoredTag[] = [...current, { text: sanitized, color: this.selectedTagColor() }];
    this.userTags.set(updated);
    this.saveUserTags(updated);
    this.closeAddTag();
  }

  removeTag(tagToRemove: ColoredTag, event: Event) {
    event.stopPropagation();
    const updated = this.userTags().filter((t) => t.text !== tagToRemove.text);
    this.userTags.set(updated);
    this.saveUserTags(updated);
  }

  scrollCarousel(direction: 'left' | 'right') {
    if (!this.carouselRef?.nativeElement) return;
    const el = this.carouselRef.nativeElement;
    const step = 220;
    el.scrollBy({
      left: direction === 'left' ? -step : step,
      behavior: 'smooth',
    });
  }

  onArtistClick(artistName: string) {
    if (artistName && artistName !== 'Исполнитель') {
      this.searchArtist.emit(artistName);
    }
  }

  onPlaylistClick(playlistId: string) {
    this.openPlaylist.emit(playlistId);
  }
}
