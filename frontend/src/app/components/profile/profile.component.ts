import { Component, inject, signal, computed, input, output, ElementRef, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { LibraryService } from '../../services/library.service';
import { AudioService } from '../../services/audio.service';
import { NavigationService } from '../../services/navigation.service';
import { ProfileStatsService, BadgeItem } from '../../services/profile-stats.service';
import { Playlist } from '../../models/track.model';
import { 
  AVATAR_PRESETS, 
  BANNER_PRESETS, 
  AVATAR_FRAMES, 
  VIBE_PRESETS, 
  PLAYLIST_COVER_PRESETS,
  AvatarPreset, 
  BannerPreset, 
  AvatarFrame,
  PlaylistCoverPreset
} from './profile-presets';

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
  readonly statsService = inject(ProfileStatsService);

  @ViewChild('carouselRef') carouselRef!: ElementRef<HTMLDivElement>;
  @ViewChild('avatarFileInput') avatarFileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('bannerFileInput') bannerFileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('playlistCoverInput') playlistCoverInput?: ElementRef<HTMLInputElement>;

  readonly showCloseButton = input<boolean>(false);
  readonly close = output<void>();
  readonly openPlaylist = output<string>();
  readonly createPlaylist = output<void>();
  readonly searchArtist = output<string>();

  readonly isSettingsOpen = signal<boolean>(false);
  readonly isAvatarModalOpen = signal<boolean>(false);
  readonly isBannerModalOpen = signal<boolean>(false);
  readonly isAddTagOpen = signal<boolean>(false);
  readonly isAchievementsModalOpen = signal<boolean>(false);
  readonly isEditPlaylistCoverOpen = signal<boolean>(false);
  readonly selectedPlaylistForCover = signal<Playlist | null>(null);
  readonly editPlaylistCoverUrl = signal<string>('');

  readonly newTagInput = signal<string>('');
  readonly selectedTagColor = signal<string>('#ffffff');
  readonly tagError = signal<string | null>(null);

  readonly editUsername = signal<string>('');
  readonly editAvatarUrl = signal<string>('');
  readonly editBannerUrl = signal<string>('');
  readonly editAvatarFrame = signal<string>('default');
  readonly editVibe = signal<string>('');

  readonly avatarPresets: AvatarPreset[] = AVATAR_PRESETS;
  readonly bannerPresets: BannerPreset[] = BANNER_PRESETS;
  readonly avatarFrames: AvatarFrame[] = AVATAR_FRAMES;
  readonly vibePresets: string[] = VIBE_PRESETS;
  readonly playlistCoverPresets: PlaylistCoverPreset[] = PLAYLIST_COVER_PRESETS;

  readonly tagColorPresets: string[] = [
    '#ffffff',
    '#e4e4e7',
    '#71717a',
    '#3b82f6',
    '#10b981',
    '#06b6d4',
    '#f59e0b',
    '#ef4444',
  ];

  private readonly STORAGE_TAGS_PREFIX = 'recro_profile_tags_colored_';

  // Loaded metadata
  readonly userTags = signal<ColoredTag[]>([]);
  readonly userVibe = signal<string>('');
  readonly selectedAvatarFrame = signal<string>('default');
  readonly profileToast = signal<string | null>(null);
  private profileToastTimeout: ReturnType<typeof setTimeout> | null = null;

  readonly isSavingAvatar = signal<boolean>(false);
  readonly isSavingBanner = signal<boolean>(false);

  readonly effectiveAvatar = computed<string>(() => {
    const user = this.authService.currentUser();
    if (user?.avatar_url) return user.avatar_url;
    const uid = user?.id || 'guest';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(`recro_custom_avatar_${uid}`) || localStorage.getItem('recro_custom_avatar_guest');
      if (saved) return saved;
    }
    return '';
  });

  readonly effectiveBanner = computed<string>(() => {
    const user = this.authService.currentUser();
    if (user?.banner_url) return user.banner_url;
    const uid = user?.id || 'guest';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(`recro_custom_banner_${uid}`) || localStorage.getItem('recro_custom_banner_guest');
      if (saved) return saved;
    }
    return '';
  });

  readonly effectiveUsername = computed<string>(() => {
    const user = this.authService.currentUser();
    if (user?.username && user.username !== 'Nickname') return user.username;
    const uid = user?.id || 'guest';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(`recro_custom_username_${uid}`) || localStorage.getItem('recro_custom_username_guest');
      if (saved) return saved;
    }
    return user?.username || 'Nickname';
  });

  showProfileToast(msg: string) {
    if (this.profileToastTimeout) {
      clearTimeout(this.profileToastTimeout);
    }
    this.profileToast.set(msg);
    this.profileToastTimeout = setTimeout(() => {
      this.profileToast.set(null);
      this.profileToastTimeout = null;
    }, 2800);
  }

  downloadMedia(dataUrl: string, filename: string) {
    if (!dataUrl) return;
    try {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      this.showProfileToast('Файл сохранён на устройство!');
    } catch {}
  }

  readonly userPlaylists = computed<Playlist[]>(() => this.libraryService.playlists());
  readonly pinnedPlaylists = computed<Playlist[]>(() => {
    const pins = this.statsService.pinnedPlaylistIds();
    return this.userPlaylists().filter((p) => pins.includes(p.id));
  });
  readonly otherPlaylists = computed<Playlist[]>(() => {
    const pins = this.statsService.pinnedPlaylistIds();
    return this.userPlaylists().filter((p) => !pins.includes(p.id));
  });

  readonly badges = computed<BadgeItem[]>(() => this.statsService.allBadges());
  readonly equippedBadgesList = computed<BadgeItem[]>(() => {
    return this.statsService.allBadges().filter((b) => b.equipped);
  });

  readonly historyArtists = signal<ProfileArtist[]>([]);
  readonly worldTopArtists = signal<ProfileArtist[]>([]);

  readonly topArtists = computed<ProfileArtist[]>(() => {
    return this.worldTopArtists();
  });

  togglePin(playlistId: string, event: Event) {
    event.stopPropagation();
    this.statsService.togglePinPlaylist(playlistId);
  }

  isPinned(playlistId: string): boolean {
    return this.statsService.isPlaylistPinned(playlistId);
  }

  claimBadge(badgeId: string, event: Event) {
    event.stopPropagation();
    this.statsService.claimBadge(badgeId);
  }

  toggleBadgeEquip(badgeId: string, event: Event) {
    event.stopPropagation();
    this.statsService.toggleEquipBadge(badgeId);
  }

  constructor() {
    this.initProfileMetadata();
    this.fetchWorldTopArtists();

    // Cross-device auto sync: реактивно обновляем теги, вайб и рамку профиля при синхронизации
    effect(() => {
      const u = this.authService.currentUser();
      if (u) {
        this.initProfileMetadata();
      }
    });
  }

  private initProfileMetadata() {
    const meta = this.getParsedProfileMeta();
    this.userTags.set(meta.tags);
    this.userVibe.set(meta.vibe);
    this.selectedAvatarFrame.set(meta.frame);
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

  private getParsedProfileMeta(): { tags: ColoredTag[]; vibe: string; frame: string } {
    const user = this.authService.currentUser();
    const userId = user?.id || 'guest';
    let tags: ColoredTag[] = [];
    let vibe = '';
    let frame = 'default';

    if (typeof localStorage !== 'undefined') {
      try {
        vibe = localStorage.getItem(`recro_profile_vibe_${userId}`) || '';
        frame = localStorage.getItem(`recro_profile_frame_${userId}`) || 'default';
      } catch {}
    }

    if (user?.profile_tags) {
      try {
        const parsed = JSON.parse(user.profile_tags);
        if (Array.isArray(parsed)) {
          tags = this.normalizeTags(parsed);
        } else if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.tags)) {
            tags = this.normalizeTags(parsed.tags);
          }
          if (typeof parsed.vibe === 'string' && parsed.vibe.trim()) {
            vibe = parsed.vibe.trim();
          }
          if (typeof parsed.frame === 'string' && parsed.frame.trim()) {
            frame = parsed.frame.trim();
          }
        }
      } catch {}
    }

    if (tags.length === 0 && typeof localStorage !== 'undefined') {
      try {
        const key = `${this.STORAGE_TAGS_PREFIX}${userId}`;
        const saved = localStorage.getItem(key);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) tags = this.normalizeTags(parsed);
        }
      } catch {}
    }

    return { tags, vibe, frame };
  }

  private normalizeTags(list: any[]): ColoredTag[] {
    return list.map((item, idx) => {
      if (typeof item === 'string') {
        const defaultColor = this.tagColorPresets[idx % this.tagColorPresets.length];
        return { text: item, color: defaultColor };
      }
      return {
        text: item.text || 'Тег',
        color: item.color || '#ffffff',
      };
    });
  }

  private saveProfileCustomization(tags: ColoredTag[], vibe: string, frame: string) {
    const user = this.authService.currentUser();
    const userId = user?.id || 'guest';

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`${this.STORAGE_TAGS_PREFIX}${userId}`, JSON.stringify(tags));
        localStorage.setItem(`recro_profile_vibe_${userId}`, vibe);
        localStorage.setItem(`recro_profile_frame_${userId}`, frame);
      } catch {}
    }

    let existingMeta: any = {};
    if (user?.profile_tags) {
      try {
        existingMeta = JSON.parse(user.profile_tags);
      } catch {}
    }

    const payloadObj = {
      ...existingMeta,
      tags,
      vibe,
      frame,
      pinnedPlaylists: this.statsService.pinnedPlaylistIds(),
    };

    const payloadStr = JSON.stringify(payloadObj);

    if (this.authService.isAuthenticated()) {
      this.authService.updateProfile({ profile_tags: payloadStr }, this.libraryService.getBackendUrl());
    }
  }

  getBannerStyle(banner?: string | null): string | null {
    if (!banner) return null;
    const trimmed = banner.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('linear-gradient') || trimmed.startsWith('radial-gradient')) {
      return `linear-gradient(180deg, rgba(15,15,18,0.2) 0%, rgba(15,15,18,0.85) 100%), ${trimmed}`;
    }
    return `linear-gradient(180deg, rgba(15,15,18,0.3) 0%, rgba(15,15,18,0.88) 100%), url('${trimmed}') center/cover no-repeat`;
  }

  getBannerPreviewStyle(banner?: string | null): string {
    if (!banner) return 'linear-gradient(135deg, #27272a 0%, #18181b 100%)';
    const trimmed = banner.trim();
    if (trimmed.startsWith('linear-gradient') || trimmed.startsWith('radial-gradient')) {
      return trimmed;
    }
    return `url('${trimmed}') center/cover no-repeat`;
  }

  openAchievementsModal() {
    this.isAchievementsModalOpen.set(true);
  }

  closeAchievementsModal() {
    this.isAchievementsModalOpen.set(false);
  }

  openSettings() {
    this.editUsername.set(this.effectiveUsername());
    this.editVibe.set(this.userVibe());
    this.isSettingsOpen.set(true);
  }

  closeSettings() {
    this.isSettingsOpen.set(false);
  }

  async saveSettings() {
    const name = this.editUsername().trim();
    const vibe = this.editVibe().trim();
    const user = this.authService.currentUser();
    const userId = user?.id || 'guest';

    this.userVibe.set(vibe);
    this.saveProfileCustomization(this.userTags(), vibe, this.selectedAvatarFrame());

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`recro_custom_username_${userId}`, name || 'Nickname');
        localStorage.setItem('recro_custom_username_guest', name || 'Nickname');
      } catch {}
    }

    if (name) {
      await this.authService.updateProfile({
        username: name,
      }, this.libraryService.getBackendUrl());
    }

    this.showProfileToast('Настройки профиля сохранены!');
    this.closeSettings();
  }

  openAvatarModal() {
    this.editAvatarUrl.set(this.effectiveAvatar());
    this.editAvatarFrame.set(this.selectedAvatarFrame());
    this.isAvatarModalOpen.set(true);
  }

  closeAvatarModal() {
    this.isAvatarModalOpen.set(false);
  }

  selectAvatarPreset(preset: AvatarPreset) {
    this.editAvatarUrl.set(preset.url);
  }

  selectAvatarFrame(frameId: string) {
    this.editAvatarFrame.set(frameId);
  }

  async saveAvatar() {
    if (this.isSavingAvatar()) return;
    this.isSavingAvatar.set(true);

    try {
      const avatarToSave = this.editAvatarUrl().trim();
      const user = this.authService.currentUser();
      const userId = user?.id || 'guest';

      // 1. Save immediately to LocalStorage so it works instantly on this device
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(`recro_custom_avatar_${userId}`, avatarToSave);
          localStorage.setItem('recro_custom_avatar_guest', avatarToSave);
        } catch {}
      }

      // 2. Prepare frame and meta
      const newFrame = this.editAvatarFrame();
      this.selectedAvatarFrame.set(newFrame);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(`recro_profile_frame_${userId}`, newFrame);
        } catch {}
      }

      let existingMeta: any = {};
      if (user?.profile_tags) {
        try {
          existingMeta = JSON.parse(user.profile_tags);
        } catch {}
      }

      const payloadObj = {
        ...existingMeta,
        tags: this.userTags(),
        vibe: this.userVibe(),
        frame: newFrame,
        pinnedPlaylists: this.statsService.pinnedPlaylistIds(),
      };

      // 3. Update profile state and server in ONE atomic update!
      await this.authService.updateProfile({
        avatar_url: avatarToSave ? avatarToSave : '',
        profile_tags: JSON.stringify(payloadObj),
      }, this.libraryService.getBackendUrl());

      this.showProfileToast('Аватар успешно сохранён!');
      this.closeAvatarModal();
    } catch (e) {
      console.error('[Profile] Error saving avatar:', e);
      this.showProfileToast('Ошибка сохранения аватара');
    } finally {
      this.isSavingAvatar.set(false);
    }
  }

  triggerAvatarFile() {
    this.avatarFileInput?.nativeElement?.click();
  }

  async onAvatarFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) return;

    try {
      const dataUrl = await this.resizeImage(file, 280, 0.80);
      this.editAvatarUrl.set(dataUrl);
    } catch {
      // Fallback to standard reader
      const reader = new FileReader();
      reader.onload = () => {
        this.editAvatarUrl.set(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  removeAvatar() {
    this.editAvatarUrl.set('');
  }

  openBannerModal() {
    this.editBannerUrl.set(this.effectiveBanner());
    this.isBannerModalOpen.set(true);
  }

  closeBannerModal() {
    this.isBannerModalOpen.set(false);
  }

  selectBannerPreset(preset: BannerPreset) {
    this.editBannerUrl.set(preset.gradient);
  }

  async saveBanner() {
    if (this.isSavingBanner()) return;
    this.isSavingBanner.set(true);

    try {
      const bannerToSave = this.editBannerUrl().trim();
      const user = this.authService.currentUser();
      const userId = user?.id || 'guest';

      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(`recro_custom_banner_${userId}`, bannerToSave);
          localStorage.setItem('recro_custom_banner_guest', bannerToSave);
        } catch {}
      }

      await this.authService.updateProfile({
        banner_url: bannerToSave ? bannerToSave : '',
      }, this.libraryService.getBackendUrl());

      this.showProfileToast('Баннер успешно сохранён!');
      this.closeBannerModal();
    } catch (e) {
      console.error('[Profile] Error saving banner:', e);
      this.showProfileToast('Ошибка сохранения баннера');
    } finally {
      this.isSavingBanner.set(false);
    }
  }

  triggerBannerFile() {
    this.bannerFileInput?.nativeElement?.click();
  }

  async onBannerFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) return;

    try {
      const dataUrl = await this.resizeImage(file, 1000, 0.78);
      this.editBannerUrl.set(dataUrl);
    } catch {
      const reader = new FileReader();
      reader.onload = () => {
        this.editBannerUrl.set(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  removeBanner() {
    this.editBannerUrl.set('');
  }

  private resizeImage(file: File, maxDimension: number, quality = 0.86): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let width = img.width;
          let height = img.height;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(reader.result as string);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          let mime = 'image/webp';
          try {
            if (!canvas.toDataURL('image/webp').startsWith('data:image/webp')) {
              mime = 'image/jpeg';
            }
          } catch {
            mime = 'image/jpeg';
          }
          resolve(canvas.toDataURL(mime, quality));
        };
        img.onerror = () => reject(new Error('Image failed to load'));
        img.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error('File reading failed'));
      reader.readAsDataURL(file);
    });
  }

  openAddTag() {
    this.newTagInput.set('');
    this.selectedTagColor.set('#ffffff');
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
    this.saveProfileCustomization(updated, this.userVibe(), this.selectedAvatarFrame());
    this.closeAddTag();
  }

  removeTag(tagToRemove: ColoredTag, event: Event) {
    event.stopPropagation();
    const updated = this.userTags().filter((t) => t.text !== tagToRemove.text);
    this.userTags.set(updated);
    this.saveProfileCustomization(updated, this.userVibe(), this.selectedAvatarFrame());
  }

  selectVibePreset(vibe: string) {
    this.editVibe.set(vibe);
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

  openEditPlaylistCover(pl: Playlist, event: Event) {
    event.stopPropagation();
    this.selectedPlaylistForCover.set(pl);
    this.editPlaylistCoverUrl.set(pl.coverUrl || '');
    this.isEditPlaylistCoverOpen.set(true);
  }

  closeEditPlaylistCover() {
    this.isEditPlaylistCoverOpen.set(false);
    this.selectedPlaylistForCover.set(null);
  }

  selectPlaylistCoverPreset(preset: PlaylistCoverPreset) {
    this.editPlaylistCoverUrl.set(preset.url);
  }

  triggerPlaylistCoverFile() {
    this.playlistCoverInput?.nativeElement?.click();
  }

  async onPlaylistCoverFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    if (!file.type.startsWith('image/')) return;

    try {
      const dataUrl = await this.libraryService.resizeImageFile(file, 500, 0.85);
      this.editPlaylistCoverUrl.set(dataUrl);
    } catch {
      try {
        const fallback = await this.resizeImage(file, 500, 0.85);
        this.editPlaylistCoverUrl.set(fallback);
      } catch {
        const reader = new FileReader();
        reader.onload = () => {
          this.editPlaylistCoverUrl.set(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
    }
    input.value = '';
  }

  removePlaylistCover() {
    this.editPlaylistCoverUrl.set('');
  }

  savePlaylistCover() {
    const pl = this.selectedPlaylistForCover();
    if (!pl) return;

    const cover = this.editPlaylistCoverUrl().trim();
    this.libraryService.updatePlaylistCover(pl.id, cover);
    this.closeEditPlaylistCover();
  }
}
