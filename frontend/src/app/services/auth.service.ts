import { Injectable, signal, computed } from '@angular/core';
import { resolveDefaultBackend } from '../models/cluster.config';

export interface UserInfo {
  id: string;
  username: string;
  email?: string;
  avatar_url?: string;
  banner_url?: string;
  profile_tags?: string;
  tags?: string[];
  role?: string;
}

export interface AuthConfigResponse {
  google_client_id?: string;
  google_auth_enabled: boolean;
}

export interface AuthResponse {
  token: string;
  user: UserInfo;
}

export interface TopTrackItem {
  track_id: string;
  title: string;
  artist: string;
  cover_url?: string;
  plays: number;
}

export interface TopArtistItem {
  artist: string;
  plays: number;
}

export interface TopGenreItem {
  genre: string;
  plays: number;
  percentage: number;
}

export interface MusicPersonality {
  title: string;
  tag: string;
  description: string;
}

export interface WrappedStats {
  username: string;
  total_plays: number;
  total_minutes: number;
  unique_tracks: number;
  unique_artists: number;
  top_tracks: TopTrackItem[];
  top_artists: TopArtistItem[];
  top_genres: TopGenreItem[];
  personality: MusicPersonality;
}

export interface HistoryItem {
  id: number;
  track_id: string;
  track_title: string;
  track_artist: string;
  track_genre?: string;
  cover_url?: string;
  duration?: number;
  played_at: number;
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly TOKEN_STORAGE_KEY = 'signal_auth_jwt_token';
  private readonly USER_STORAGE_KEY = 'signal_auth_user_data';
  private readonly GOOGLE_CLIENT_ID_STORAGE_KEY = 'signal_google_client_id';

  readonly token = signal<string | null>(null);
  readonly currentUser = signal<UserInfo | null>(null);
  readonly isAuthenticated = computed(() => !!this.currentUser() && this.currentUser()?.id !== 'guest');
  readonly isAuthLoading = signal<boolean>(false);
  readonly authError = signal<string | null>(null);

  readonly googleClientId = signal<string | null>('248976454900-cs1ni5j4idhdgs5e8docklsruqlrio3v.apps.googleusercontent.com');
  readonly isGoogleAuthEnabled = signal<boolean>(true);

  constructor() {
    this.restoreSession();
  }

  private setCookie(name: string, value: string, days = 365) {
    if (typeof document === 'undefined') return;
    try {
      const expires = new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
    } catch {}
  }

  private getCookie(name: string): string | null {
    if (typeof document === 'undefined') return null;
    try {
      const matches = document.cookie.match(new RegExp('(?:^|; )' + encodeURIComponent(name).replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
      return matches ? decodeURIComponent(matches[1]) : null;
    } catch {
      return null;
    }
  }

  private deleteCookie(name: string) {
    if (typeof document === 'undefined') return;
    try {
      document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
    } catch {}
  }

  private persistSession(token: string, user: UserInfo) {
    this.token.set(token);
    this.currentUser.set(user);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.TOKEN_STORAGE_KEY, token);
        localStorage.setItem(this.USER_STORAGE_KEY, JSON.stringify(user));
      } catch {}
    }
    this.setCookie('recro_jwt_token', token, 365);
    try {
      this.setCookie('recro_user_data', JSON.stringify(user), 365);
    } catch {}
  }

  private restoreSession() {
    let savedToken: string | null = null;
    let savedUserStr: string | null = null;

    if (typeof localStorage !== 'undefined') {
      try {
        savedToken = localStorage.getItem(this.TOKEN_STORAGE_KEY);
        savedUserStr = localStorage.getItem(this.USER_STORAGE_KEY);
      } catch {}
    }

    if (!savedToken) {
      savedToken = this.getCookie('recro_jwt_token');
    }
    if (savedToken) {
      this.token.set(savedToken);
    }

    if (!savedUserStr) {
      savedUserStr = this.getCookie('recro_user_data');
    }

    try {
      if (savedUserStr) {
        const parsed: UserInfo = JSON.parse(savedUserStr);
        const uid = parsed.id || 'guest';
        if (typeof localStorage !== 'undefined') {
          parsed.avatar_url = parsed.avatar_url || localStorage.getItem(`recro_custom_avatar_${uid}`) || undefined;
          parsed.banner_url = parsed.banner_url || localStorage.getItem(`recro_custom_banner_${uid}`) || undefined;
        }
        this.currentUser.set(parsed);
      } else if (typeof localStorage !== 'undefined') {
        const guestAvatar = localStorage.getItem('recro_custom_avatar_guest') || '';
        const guestBanner = localStorage.getItem('recro_custom_banner_guest') || '';
        const guestName = localStorage.getItem('recro_custom_username_guest') || '';
        if (guestAvatar || guestBanner || guestName) {
          this.currentUser.set({
            id: 'guest',
            username: guestName || 'Nickname',
            avatar_url: guestAvatar || undefined,
            banner_url: guestBanner || undefined,
          });
        }
      }

      if (typeof localStorage !== 'undefined') {
        const savedGoogleId = localStorage.getItem(this.GOOGLE_CLIENT_ID_STORAGE_KEY);
        if (savedGoogleId) {
          this.googleClientId.set(savedGoogleId);
          this.isGoogleAuthEnabled.set(true);
        }
      }
    } catch {
      // Do not destroy session on parse error
    }

    // Фоновая проверка сессии на бэкенде
    if (typeof window !== 'undefined') {
      setTimeout(() => this.verifyRemoteSession(), 50);
    }
  }

  getAuthToken(): string | null {
    return this.token();
  }

  getAuthHeaders(): Record<string, string> {
    const t = this.token();
    if (!t) return {};
    return {
      Authorization: `Bearer ${t}`,
    };
  }

  hasWhitespace(str: string): boolean {
    return /\s/.test(str.trim());
  }

  isValidUsername(username: string): boolean {
    const clean = username.trim();
    if (this.hasWhitespace(clean)) return false;
    if (clean.length < 3 || clean.length > 30) return false;
    return /^[a-zA-Z0-9_-]+$/.test(clean);
  }

  isValidPassword(password: string): boolean {
    const clean = password.trim();
    return clean.length >= 6 && clean.length <= 72;
  }

  private get defaultBackendUrl(): string {
    return resolveDefaultBackend();
  }

  private activeBackendUrl = '';

  setActiveBackendUrl(url: string) {
    if (url) {
      this.activeBackendUrl = url.trim().replace(/\/+$/, '');
    }
  }

  async verifyRemoteSession(backendUrl?: string) {
    if (backendUrl) this.setActiveBackendUrl(backendUrl);
    const base = this.getEffectiveBackendUrl(backendUrl);
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: this.getAuthHeaders(),
        credentials: 'include',
      });
      if (res.ok) {
        const user: UserInfo = await res.json();
        const cur = this.currentUser();
        const uid = user.id || 'guest';
        const localAvatar = typeof localStorage !== 'undefined' ? (localStorage.getItem(`recro_custom_avatar_${uid}`) || localStorage.getItem('recro_custom_avatar_guest')) : null;
        const localBanner = typeof localStorage !== 'undefined' ? (localStorage.getItem(`recro_custom_banner_${uid}`) || localStorage.getItem('recro_custom_banner_guest')) : null;
        const merged: UserInfo = {
          ...user,
          avatar_url: user.avatar_url || cur?.avatar_url || localAvatar || undefined,
          banner_url: user.banner_url || cur?.banner_url || localBanner || undefined,
        };
        this.currentUser.set(merged);
        try {
          localStorage.setItem(this.USER_STORAGE_KEY, JSON.stringify(merged));
        } catch {}

        // If local device has an existing avatar/banner but server doesn't have it yet, push to cloud:
        if ((!user.avatar_url && merged.avatar_url) || (!user.banner_url && merged.banner_url)) {
          this.updateProfile({
            avatar_url: merged.avatar_url,
            banner_url: merged.banner_url,
          }, base).catch(() => {});
        }
      } else if (res.status === 401) {
        console.warn('[AuthService] /api/auth/me returned 401, preserving local cached session.');
      }
    } catch {}
  }

  private getEffectiveBackendUrl(backendUrl?: string): string {
    let base = (backendUrl || this.activeBackendUrl || '').trim().replace(/\/+$/, '');
    return base || this.defaultBackendUrl;
  }

  async login(backendUrl: string, login: string, password: string): Promise<boolean> {
    this.isAuthLoading.set(true);
    this.authError.set(null);

    const cleanLogin = login.trim();
    const cleanPass = password.trim();

    if (!cleanLogin) {
      this.authError.set('Введите имя пользователя');
      this.isAuthLoading.set(false);
      return false;
    }

    if (!cleanPass) {
      this.authError.set('Введите пароль');
      this.isAuthLoading.set(false);
      return false;
    }

    if (this.hasWhitespace(cleanLogin)) {
      this.authError.set('Имя пользователя не должно содержать пробелы');
      this.isAuthLoading.set(false);
      return false;
    }

    const base = this.getEffectiveBackendUrl(backendUrl);

    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ login: cleanLogin, password: cleanPass }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        this.authError.set(data?.error || 'Ошибка входа в систему');
        return false;
      }

      this.persistSession(data.token, data.user);
      return true;
    } catch {
      this.authError.set('Не удалось подключиться к серверу');
      return false;
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  async register(backendUrl: string, username: string, password: string): Promise<boolean> {
    this.isAuthLoading.set(true);
    this.authError.set(null);

    const cleanUser = username.trim();
    const cleanPass = password.trim();

    if (!cleanUser) {
      this.authError.set('Введите имя пользователя');
      this.isAuthLoading.set(false);
      return false;
    }

    if (this.hasWhitespace(cleanUser)) {
      this.authError.set('Имя пользователя не должно содержать пробелы');
      this.isAuthLoading.set(false);
      return false;
    }

    if (!this.isValidUsername(cleanUser)) {
      this.authError.set('Имя пользователя должно быть от 3 до 30 символов (латиница, цифры, _ и -)');
      this.isAuthLoading.set(false);
      return false;
    }

    if (!this.isValidPassword(cleanPass)) {
      this.authError.set('Пароль должен содержать от 6 до 72 символов');
      this.isAuthLoading.set(false);
      return false;
    }

    const base = this.getEffectiveBackendUrl(backendUrl);

    try {
      const res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: cleanUser, password: cleanPass }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        this.authError.set(data?.error || 'Ошибка регистрации');
        return false;
      }

      this.persistSession(data.token, data.user);
      return true;
    } catch {
      this.authError.set('Не удалось подключиться к серверу');
      return false;
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  async fetchAuthConfig(backendUrl: string): Promise<void> {
    const base = this.getEffectiveBackendUrl(backendUrl);
    try {
      const res = await fetch(`${base}/api/auth/config`);
      if (res.ok) {
        const data: AuthConfigResponse = await res.json();
        if (data.google_client_id) {
          this.googleClientId.set(data.google_client_id);
          this.isGoogleAuthEnabled.set(true);
        } else {
          const localId = localStorage.getItem(this.GOOGLE_CLIENT_ID_STORAGE_KEY);
          if (localId) {
            this.googleClientId.set(localId);
            this.isGoogleAuthEnabled.set(true);
          }
        }
      }
    } catch {
    }
  }

  setCustomGoogleClientId(clientId: string | null) {
    if (clientId && clientId.trim()) {
      const clean = clientId.trim();
      this.googleClientId.set(clean);
      this.isGoogleAuthEnabled.set(true);
      try {
        localStorage.setItem(this.GOOGLE_CLIENT_ID_STORAGE_KEY, clean);
      } catch {}
    } else {
      this.googleClientId.set(null);
      this.isGoogleAuthEnabled.set(false);
      try {
        localStorage.removeItem(this.GOOGLE_CLIENT_ID_STORAGE_KEY);
      } catch {}
    }
  }

  async loginWithGoogle(backendUrl: string, credential: string): Promise<boolean> {
    this.isAuthLoading.set(true);
    this.authError.set(null);

    const base = this.getEffectiveBackendUrl(backendUrl);

    try {
      const res = await fetch(`${base}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ credential }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        this.authError.set(data?.error || 'Ошибка входа через Google');
        return false;
      }

      this.persistSession(data.token, data.user);
      return true;
    } catch {
      this.authError.set('Не удалось подключиться к серверу для авторизации через Google');
      return false;
    } finally {
      this.isAuthLoading.set(false);
    }
  }

  async updateProfile(partial: Partial<UserInfo>, backendUrl?: string): Promise<boolean> {
    const cur = this.currentUser() || {
      id: 'guest',
      username: 'Nickname',
    };
    const updated: UserInfo = { ...cur, ...partial };
    this.currentUser.set(updated);
    const uid = updated.id || 'guest';

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.USER_STORAGE_KEY, JSON.stringify(updated));
        if (partial.avatar_url !== undefined) {
          localStorage.setItem(`recro_custom_avatar_${uid}`, partial.avatar_url || '');
        }
        if (partial.banner_url !== undefined) {
          localStorage.setItem(`recro_custom_banner_${uid}`, partial.banner_url || '');
        }
        if (partial.username !== undefined) {
          localStorage.setItem(`recro_custom_username_${uid}`, partial.username || '');
        }
      } catch {}
    }
    try {
      this.setCookie('recro_user_data', JSON.stringify(updated), 365);
    } catch {}

    const targetBackend = backendUrl || this.activeBackendUrl;
    if (targetBackend && uid !== 'guest') {
      try {
        const res = await fetch(`${targetBackend}/api/auth/profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.getAuthHeaders(),
          },
          credentials: 'include',
          body: JSON.stringify({
            username: partial.username,
            avatar_url: partial.avatar_url,
            banner_url: partial.banner_url,
            profile_tags: partial.profile_tags,
          }),
        });
        if (res.ok) {
          const serverUser: UserInfo = await res.json();
          const latestCur = this.currentUser() || updated;
          const merged: UserInfo = {
            ...latestCur,
            ...serverUser,
            profile_tags: latestCur.profile_tags || serverUser.profile_tags,
            avatar_url: serverUser.avatar_url || partial.avatar_url || latestCur.avatar_url,
            banner_url: serverUser.banner_url || partial.banner_url || latestCur.banner_url,
          };
          this.currentUser.set(merged);
          try {
            localStorage.setItem(this.USER_STORAGE_KEY, JSON.stringify(merged));
            this.setCookie('recro_user_data', JSON.stringify(merged), 365);
          } catch {}
          return true;
        } else if (res.status === 401) {
          console.warn('[AuthService] /api/auth/profile returned 401, preserving local cached session.');
          return false;
        }
      } catch {}
    }
    return true;
  }

  async updateProfileCustomization(updater: (meta: any) => any, backendUrl?: string): Promise<boolean> {
    const user = this.currentUser();
    if (!user || user.id === 'guest') return false;
    let meta: any = {};
    if (user.profile_tags) {
      try {
        meta = JSON.parse(user.profile_tags);
      } catch {}
    }
    const updated = updater(meta);
    const tagsStr = JSON.stringify(updated);
    return this.updateProfile({ profile_tags: tagsStr }, backendUrl);
  }

  logout() {
    this.clearSession();
  }

  private clearSession() {
    this.token.set(null);
    this.currentUser.set(null);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(this.TOKEN_STORAGE_KEY);
        localStorage.removeItem(this.USER_STORAGE_KEY);
      } catch {}
    }
    this.deleteCookie('recro_jwt_token');
    this.deleteCookie('recro_user_data');
    if (typeof window !== 'undefined') {
      fetch(`${this.getEffectiveBackendUrl()}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {});
    }
  }
}
