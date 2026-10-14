import { Injectable, signal, computed } from '@angular/core';

export type SupportedLanguage = 'ru' | 'en';

export const TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
  ru: {
    // Navigation / Sidebar
    'nav.sources': 'ИСТОЧНИКИ',
    'nav.allMusic': 'Вся музыка',
    'nav.onlineSearch': 'Поиск онлайн',
    'nav.offline': 'Оффлайн',
    'nav.streamsRadio': 'Онлайн-потоки & Радио',
    'nav.favorites': 'Избранное',
    'nav.localFiles': 'Локальные файлы',
    'nav.statsProfile': 'СТАТИСТИКА & ПРОФИЛЬ',
    'nav.profile': 'Профиль',
    'nav.wrapped': 'Recro Wrapped',
    'nav.history': 'История',
    'nav.timer': 'Музыкальный таймер',
    'nav.app': 'Приложение Recro',
    'nav.playlists': 'ПЛЕЙЛИСТЫ',
    'nav.createPlaylist': 'Создать плейлист',
    'nav.themes': 'Темы оформления',
    'nav.wave': 'Моя Волна',

    // Header
    'header.searchPlaceholder': 'Поиск по медиатеке (Enter: глобальный поиск онлайн)...',
    'header.searchOnline': 'Искать онлайн',
    'header.addMusic': 'Добавить музыку',
    'header.myProfile': 'Мой профиль',
    'header.listeningHistory': 'История прослушиваний',
    'header.downloadApp': 'СКАЧАТЬ ПРИЛОЖЕНИЕ',
    'header.forIos': 'Для iPhone (iOS)',
    'header.forAndroid': 'Для Android',
    'header.login': 'Войти',
    'header.logout': 'Выйти',
    'header.register': 'Создать аккаунт',
    'header.appBadge': 'Приложение',
    'header.themeBtn': 'Тема оформления',
    'header.langBtn': 'Язык',

    // Player Controls
    'player.play': 'Воспроизвести',
    'player.pause': 'Пауза',
    'player.next': 'Следующий трек',
    'player.prev': 'Предыдущий трек',
    'player.repeatOff': 'Повтор выключен',
    'player.repeatAll': 'Повторять все треки',
    'player.repeatOne': 'Повторять текущий трек',
    'player.shuffleOn': 'Случайный порядок включен',
    'player.shuffleOff': 'Случайный порядок выключен',
    'player.volume': 'Громкость',
    'player.mute': 'Без звука',
    'player.lyrics': 'Текст песни',
    'player.queue': 'Очередь воспроизведения',
    'player.visualizer': 'Визуализатор',
    'player.speed': 'Скорость воспроизведения',
    'player.like': 'Добавить в избранное',
    'player.dislike': 'Не нравится (скрыть трек)',
    'player.noTrack': 'Трек не выбран',
    'player.startListening': 'Выберите песню или запустите Мою Волну',

    // My Wave
    'wave.start': 'Запустить Волну',
    'wave.active': 'Моя Волна играет',
    'wave.settings': 'Настройки Моей Волны',
    'wave.mood': 'Настроение',
    'wave.all': 'Бодрое / Разное',
    'wave.calm': 'Спокойное',
    'wave.activeMood': 'Драйв',
    'wave.sad': 'Меланхолия',
    'wave.focus': 'Концентрация',
    'wave.favorites': 'Только любимое',

    // Themes Modal
    'theme.modalTitle': 'Темы оформления',
    'theme.modalSubtitle': 'Настройте градиентную атмосферу плеера в стиле Discord Nitro',
    'theme.presetsTitle': 'Готовые градиенты (Nitro Presets)',
    'theme.customTitle': 'Своя комбинация из двух цветов',
    'theme.color1': 'Цвет 1 (Основной акцент)',
    'theme.color2': 'Цвет 2 (Фоновый оттенок)',
    'theme.previewTitle': 'Предпросмотр темы',
    'theme.previewTrack': 'Космическая мелодия',
    'theme.previewArtist': 'Recro Player Demo',
    'theme.btnReset': 'По умолчанию',
    'theme.btnClose': 'Закрыть',
    'theme.langTitle': 'Язык интерфейса',

    // Modals & General
    'common.save': 'Сохранить',
    'common.cancel': 'Отмена',
    'common.close': 'Закрыть',
    'common.delete': 'Удалить',
    'common.search': 'Поиск',
    'common.tracks': 'треков',
    'common.duration': 'Длительность',
  },
  en: {
    // Navigation / Sidebar
    'nav.sources': 'SOURCES',
    'nav.allMusic': 'All Music',
    'nav.onlineSearch': 'Online Search',
    'nav.offline': 'Offline',
    'nav.streamsRadio': 'Live Streams & Radio',
    'nav.favorites': 'Favorites',
    'nav.localFiles': 'Local Files',
    'nav.statsProfile': 'STATS & PROFILE',
    'nav.profile': 'Profile',
    'nav.wrapped': 'Recro Wrapped',
    'nav.history': 'History',
    'nav.timer': 'Sleep Timer',
    'nav.app': 'Recro App',
    'nav.playlists': 'PLAYLISTS',
    'nav.createPlaylist': 'Create Playlist',
    'nav.themes': 'Themes & Colors',
    'nav.wave': 'My Wave',

    // Header
    'header.searchPlaceholder': 'Search library (Enter: global online search)...',
    'header.searchOnline': 'Search Online',
    'header.addMusic': 'Add Music',
    'header.myProfile': 'My Profile',
    'header.listeningHistory': 'Listening History',
    'header.downloadApp': 'DOWNLOAD APP',
    'header.forIos': 'For iPhone (iOS)',
    'header.forAndroid': 'For Android',
    'header.login': 'Log In',
    'header.logout': 'Log Out',
    'header.register': 'Create Account',
    'header.appBadge': 'App',
    'header.themeBtn': 'Appearance',
    'header.langBtn': 'Language',

    // Player Controls
    'player.play': 'Play',
    'player.pause': 'Pause',
    'player.next': 'Next Track',
    'player.prev': 'Previous Track',
    'player.repeatOff': 'Repeat Off',
    'player.repeatAll': 'Repeat All',
    'player.repeatOne': 'Repeat One',
    'player.shuffleOn': 'Shuffle On',
    'player.shuffleOff': 'Shuffle Off',
    'player.volume': 'Volume',
    'player.mute': 'Mute',
    'player.lyrics': 'Lyrics',
    'player.queue': 'Play Queue',
    'player.visualizer': 'Visualizer',
    'player.speed': 'Playback Speed',
    'player.like': 'Add to Favorites',
    'player.dislike': 'Dislike (Hide track)',
    'player.noTrack': 'No track selected',
    'player.startListening': 'Pick a track or start My Wave',

    // My Wave
    'wave.start': 'Start My Wave',
    'wave.active': 'My Wave is Playing',
    'wave.settings': 'My Wave Settings',
    'wave.mood': 'Mood',
    'wave.all': 'Energetic / Mixed',
    'wave.calm': 'Calm',
    'wave.activeMood': 'Drive',
    'wave.sad': 'Melancholy',
    'wave.focus': 'Focus',
    'wave.favorites': 'Favorites Only',

    // Themes Modal
    'theme.modalTitle': 'Appearance & Themes',
    'theme.modalSubtitle': 'Customize player gradient atmosphere in Discord Nitro style',
    'theme.presetsTitle': 'Nitro Gradient Presets',
    'theme.customTitle': 'Custom 2-Color Combination',
    'theme.color1': 'Color 1 (Primary Accent)',
    'theme.color2': 'Color 2 (Atmospheric Tint)',
    'theme.previewTitle': 'Theme Live Preview',
    'theme.previewTrack': 'Cosmic Horizon',
    'theme.previewArtist': 'Recro Player Demo',
    'theme.btnReset': 'Reset Default',
    'theme.btnClose': 'Close',
    'theme.langTitle': 'Interface Language',

    // Modals & General
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.search': 'Search',
    'common.tracks': 'tracks',
    'common.duration': 'Duration',
  },
};

@Injectable({
  providedIn: 'root',
})
export class I18nService {
  private readonly STORAGE_KEY = 'recro_ui_lang';

  readonly currentLang = signal<SupportedLanguage>(this.loadInitialLang());

  t(key: string, defaultText?: string): string {
    const lang = this.currentLang();
    const dictionary = TRANSLATIONS[lang] || TRANSLATIONS.ru;
    return dictionary[key] ?? defaultText ?? key;
  }

  setLanguage(lang: SupportedLanguage) {
    this.currentLang.set(lang);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY, lang);
      } catch {}
    }
  }

  toggleLanguage() {
    const next = this.currentLang() === 'ru' ? 'en' : 'ru';
    this.setLanguage(next);
  }

  private loadInitialLang(): SupportedLanguage {
    if (typeof localStorage === 'undefined') return 'ru';
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved === 'ru' || saved === 'en') return saved;
      // Браузерный автодетектект
      if (typeof navigator !== 'undefined') {
        const navLang = (navigator.language || '').toLowerCase();
        if (navLang.startsWith('en')) return 'en';
      }
    } catch {}
    return 'ru';
  }
}
