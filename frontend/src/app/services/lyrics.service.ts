import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { AudioService } from './audio.service';
import { NavigationService } from './navigation.service';
import { LibraryService } from './library.service';
import { Track } from '../models/track.model';

export interface LyricWord {
  text: string;
  startTime: number;
  endTime?: number;
}

export interface LyricLine {
  startTime: number;
  endTime?: number;
  text: string;
  words?: LyricWord[];
}

export interface ParsedLyrics {
  isSynced: boolean;
  isWordByWord: boolean;
  lines: LyricLine[];
  plainText: string;
  raw?: string;
  source: 'lrclib' | 'kugou' | 'embedded' | 'imported' | 'none';
  duration?: number;
}

import { BpmService } from './bpm.service';

@Injectable({
  providedIn: 'root',
})
export class LyricsService {
  private readonly audioService = inject(AudioService);
  private readonly navService = inject(NavigationService);
  private readonly libraryService = inject(LibraryService);
  private readonly bpmService = inject(BpmService);

  readonly isLyricsOpen = signal<boolean>(false);
  readonly isLoading = signal<boolean>(false);
  readonly currentLyrics = signal<ParsedLyrics | null>(null);
  readonly syncOffsetMs = signal<number>(0);
  readonly errorMessage = signal<string | null>(null);
  readonly isAutoScrollLocked = signal<boolean>(false);

  // BPM and rhythmic beat duration in ms
  readonly currentBpm = computed(() => this.bpmService.currentBpm());
  readonly beatDurationMs = computed(() => {
    const bpm = this.currentBpm();
    return bpm && bpm > 0 ? Math.round((60 / bpm) * 1000) : 500;
  });

  private lastLoadedTrackId: string | null = null;
  private autoScrollLockTimeout: any = null;
  private currentAbortController: AbortController | null = null;
  private updateIntervalId: ReturnType<typeof setInterval> | null = null;
  readonly precisePlaybackTime = signal<number>(0);

  // True 1:1 synchronization (0.0s): eliminates premature line jumps and rushing
  public static readonly VOCAL_LEAD_TIME_SEC = 0.0;

  private rafId: number | null = null;

  private lastReportedAudioTime = 0;
  private lastAudioTimeTimestamp = 0;

  /** Высокоточное сглаживание времени с субмиллисекундной интерполяцией между тиками браузера */
  getSmoothedCurrentTime(): number {
    const raw = this.audioService.getPreciseCurrentTime();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Если плеер на паузе или был совершен ручной перемот (>0.4с) - мгновенный сброс базы
    if (!this.audioService.isPlaying() || Math.abs(raw - this.lastReportedAudioTime) > 0.4) {
      this.lastReportedAudioTime = raw;
      this.lastAudioTimeTimestamp = now;
      return raw;
    }

    // Если аудиотег совершил очередной тик вперед
    if (raw !== this.lastReportedAudioTime) {
      this.lastReportedAudioTime = raw;
      this.lastAudioTimeTimestamp = now;
      return raw;
    }

    // Между тиками HTML5 Audio интерполируем время со скоростью 1.0x для идеальной плавности 60 FPS
    const dt = (now - this.lastAudioTimeTimestamp) / 1000;
    if (dt > 0 && dt < 0.28) {
      return this.lastReportedAudioTime + dt;
    }

    return raw;
  }

  // Индекс активной строки текста в зависимости от текущего времени трека
  readonly activeLineIndex = computed<number>(() => {
    const lyrics = this.currentLyrics();
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) return -1;

    const leadTimeSec = LyricsService.VOCAL_LEAD_TIME_SEC;
    const t = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);

    // Во время вступительного инструментального проигрыша до первой строчки текста (с защитой от дребезга 0.12с)
    if (t < lyrics.lines[0].startTime - 0.12) {
      return -1;
    }

    let activeIdx = 0;
    for (let i = 0; i < lyrics.lines.length; i++) {
      const line = lyrics.lines[i];
      if (line.startTime >= 0 && t >= line.startTime - 0.04) {
        activeIdx = i;
      } else if (line.startTime - 0.04 > t) {
        break;
      }
    }

    return activeIdx;
  });

  // Показывает, звучит ли прямо сейчас голос исполнителя или идет длинный музыкальный проигрыш
  readonly isLineSinging = computed<boolean>(() => {
    const idx = this.activeLineIndex();
    const lyrics = this.currentLyrics();
    if (idx === -1 || !lyrics || idx >= lyrics.lines.length) return false;

    const line = lyrics.lines[idx];
    const next = idx < lyrics.lines.length - 1 ? lyrics.lines[idx + 1] : null;
    const leadTimeSec = LyricsService.VOCAL_LEAD_TIME_SEC;
    const t = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);

    if (t < line.startTime) return false;

    // Линия никогда не гаснет преждевременно!
    // Только если между строками реальный гитарный/электронный проигрыш (>6.5 секунд),
    // строка мягко переходит в состояние интерлюдии во второй половине паузы
    if (next && next.startTime - line.startTime > 6.5) {
      const vocalDuration = line.endTime && line.endTime > line.startTime
        ? (line.endTime - line.startTime)
        : Math.min(6.0, (next.startTime - line.startTime) * 0.48);
      return t <= line.startTime + vocalDuration;
    }

    return true;
  });

  // Прогресс воспроизведения внутри текущей строки (0..1)
  readonly activeLineProgress = computed<number>(() => {
    const idx = this.activeLineIndex();
    const lyrics = this.currentLyrics();
    if (idx === -1 || !lyrics || idx >= lyrics.lines.length) return 0;

    const currentLine = lyrics.lines[idx];
    if (currentLine.startTime < 0) return 0;

    const leadTimeSec = LyricsService.VOCAL_LEAD_TIME_SEC;
    const adjustedTime = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);
    const start = currentLine.startTime;
    const nextLine = lyrics.lines[idx + 1];
    const end = currentLine.endTime || (nextLine && nextLine.startTime >= 0 ? nextLine.startTime : start + 4);

    if (end <= start) return 1;
    const progress = (adjustedTime - start) / (end - start);
    return Math.min(1, Math.max(0, progress));
  });

  private lyricsCache = new Map<string, ParsedLyrics>();
  private static readonly CACHE_MAX_SIZE = 60;

  /** FIFO-кэш с лимитом: удаляет самый старый трек при переполнении */
  private setCachedLyrics(trackId: string, lyrics: ParsedLyrics): void {
    if (this.lyricsCache.size >= LyricsService.CACHE_MAX_SIZE) {
      const firstKey = this.lyricsCache.keys().next().value;
      if (firstKey !== undefined) {
        this.lyricsCache.delete(firstKey);
      }
    }
    this.lyricsCache.set(trackId, lyrics);
  }

  constructor() {
    if (typeof window !== 'undefined') {
      // 1. Регулярный фоновый таймер — обновляет время пока текст закрыт (RAF берёт управление когда открыт)
      this.updateIntervalId = setInterval(() => {
        if (!this.isLyricsOpen()) {
          if (this.audioService.isPlaying()) {
            this.precisePlaybackTime.set(this.getSmoothedCurrentTime());
          } else {
            this.precisePlaybackTime.set(this.audioService.currentTime());
          }
        }
      }, 50);

      // 2. Реактивная мгновенная загрузка текста при смене трека (0мс задержки)
      effect(() => {
        const cur = this.audioService.currentTrack();
        if (cur) {
          if (cur.id !== this.lastLoadedTrackId) {
            this.lastLoadedTrackId = cur.id;
            this.precisePlaybackTime.set(0);
            this.syncOffsetMs.set(0);
            this.currentLyrics.set(null);
            this.loadLyricsForTrack(cur);
          }
        } else {
          this.lastLoadedTrackId = null;
          this.precisePlaybackTime.set(0);
          this.syncOffsetMs.set(0);
          this.currentLyrics.set(null);
          this.isLoading.set(false);
        }
      });

      // 3. Умная предзагрузка текста для следующего трека («Моя Волна» / очередь)
      effect(() => {
        const next = this.audioService.preloadedNextTrack();
        if (next && next.id) {
          this.prefetchNextTrackLyrics(next);
        }
      });
    }
  }

  // 60fps высокоточное отслеживание момента звука без рывков таймера
  private startHighPrecisionTracking() {
    if (this.rafId !== null || typeof window === 'undefined') return;

    const loop = () => {
      if (this.isLyricsOpen()) {
        const exact = this.getSmoothedCurrentTime();
        this.precisePlaybackTime.set(exact);
        this.rafId = requestAnimationFrame(loop);
      } else {
        this.rafId = null;
      }
    };

    this.rafId = requestAnimationFrame(loop);
  }

  private stopHighPrecisionTracking() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  toggleLyricsView() {
    if (this.isLyricsOpen()) {
      this.closeLyrics();
    } else {
      this.openLyrics();
    }
  }

  openLyrics(pushHistory = true) {
    this.isLyricsOpen.set(true);
    this.startHighPrecisionTracking();
    if (pushHistory) {
      this.navService.pushOverlay('lyrics');
    }
    // Загружаем текст только если он ещё не загружен и не грузится.
    // Это устраняет дублирующий запрос: при смене трека effect уже запустил загрузку.
    // Если текст не нашёлся (null) и loading = false — попробуем ещё раз при повторном открытии.
    const cur = this.audioService.currentTrack();
    if (cur && !this.currentLyrics() && !this.isLoading()) {
      this.loadLyricsForTrack(cur);
    }
  }

  closeLyrics(popHistory = true) {
    this.isLyricsOpen.set(false);
    this.stopHighPrecisionTracking();
    if (popHistory) {
      this.navService.closeOverlay('lyrics');
    }
  }

  adjustOffset(deltaMs: number) {
    this.syncOffsetMs.update((v) => v + deltaMs);
    const cur = this.audioService.currentTrack();
    if (cur) {
      try {
        localStorage.setItem(`signal_lyrics_offset_${cur.id}`, this.syncOffsetMs().toString());
      } catch {}
      this.persistOffsetToCloud(cur, this.syncOffsetMs());
    }
  }

  // Мгновенный сдвиг на 1 строку вперед или назад
  shiftByLine(direction: 1 | -1) {
    const lyrics = this.currentLyrics();
    const idx = this.activeLineIndex();
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) return;

    let deltaSec = 3.2;
    if (idx >= 0) {
      if (direction > 0 && idx < lyrics.lines.length - 1) {
        deltaSec = Math.max(1.0, lyrics.lines[idx + 1].startTime - lyrics.lines[idx].startTime);
      } else if (direction < 0 && idx > 0) {
        deltaSec = Math.max(1.0, lyrics.lines[idx].startTime - lyrics.lines[idx - 1].startTime);
      }
    }
    // direction > 0: слова отстают, ускоряем их появление (+delta)
    // direction < 0: слова спешат, задерживаем (-delta)
    this.adjustOffset(Math.round(direction * deltaSec * 1000));
  }

  // Привязать текущий момент песни точно к выбранной строке (100% точная синхронизация в 1 клик)
  syncCurrentPlaybackToLine(lineIndex: number) {
    const lyrics = this.currentLyrics();
    if (!lyrics || !lyrics.isSynced || lineIndex < 0 || lineIndex >= lyrics.lines.length) return;
    const targetLine = lyrics.lines[lineIndex];
    if (targetLine.startTime < 0) return;

    const leadTimeSec = LyricsService.VOCAL_LEAD_TIME_SEC;
    const current = this.precisePlaybackTime();
    const newOffsetMs = Math.round((targetLine.startTime - current - leadTimeSec) * 1000);
    this.syncOffsetMs.set(newOffsetMs);
    const cur = this.audioService.currentTrack();
    if (cur) {
      try {
        localStorage.setItem(`signal_lyrics_offset_${cur.id}`, newOffsetMs.toString());
      } catch {}
      this.persistOffsetToCloud(cur, newOffsetMs);
    }
  }

  // Мгновенная калибровка «В такт голосу»: привязывает текущее звучание песни к ближайшей строке
  syncNowToCurrentVoice() {
    const lyrics = this.currentLyrics();
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) return;

    const curTime = this.precisePlaybackTime();
    let targetIdx = this.activeLineIndex();

    if (targetIdx < 0 || targetIdx >= lyrics.lines.length) {
      let minDiff = Infinity;
      targetIdx = 0;
      for (let i = 0; i < lyrics.lines.length; i++) {
        const diff = Math.abs(lyrics.lines[i].startTime - curTime);
        if (diff < minDiff) {
          minDiff = diff;
          targetIdx = i;
        }
      }
    }

    this.syncCurrentPlaybackToLine(targetIdx);
  }

  // Проверка спето ли слово (для пословного караоке)
  isWordSung(word: LyricWord): boolean {
    const leadTimeSec = LyricsService.VOCAL_LEAD_TIME_SEC;
    const t = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);
    return t >= word.startTime;
  }

  resetOffset() {
    this.syncOffsetMs.set(0);
    const cur = this.audioService.currentTrack();
    if (cur) {
      try {
        localStorage.removeItem(`signal_lyrics_offset_${cur.id}`);
      } catch {}
      this.persistOffsetToCloud(cur, 0);
    }
  }

  private async persistOffsetToCloud(track: any, offsetMs: number) {
    if (!track || !track.id) return;
    try {
      const backendUrl = this.libraryService.getBackendUrl();
      await fetch(`${backendUrl}/api/track/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id,
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          lyrics_offset_ms: offsetMs,
          bpm: this.currentBpm(),
        }),
      });
    } catch {}
  }

  private async persistLyricsToCloud(track: any, syncedLyrics: string) {
    if (!track || !track.id || !syncedLyrics) return;
    try {
      const backendUrl = this.libraryService.getBackendUrl();
      await fetch(`${backendUrl}/api/track/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id,
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          synced_lyrics: syncedLyrics,
          bpm: this.currentBpm(),
        }),
      });
    } catch {}
  }

  seekToLine(line: LyricLine) {
    if (line.startTime < 0) return;
    const target = Math.max(0, line.startTime - this.syncOffsetMs() / 1000);
    this.audioService.seek(target);
    this.unlockAutoScroll();
  }

  // При ручном скролле блокируем автоцентровку на 3.5 секунды
  onUserScroll() {
    this.isAutoScrollLocked.set(true);
    if (this.autoScrollLockTimeout) clearTimeout(this.autoScrollLockTimeout);
    this.autoScrollLockTimeout = setTimeout(() => {
      this.isAutoScrollLocked.set(false);
    }, 3500);
  }

  unlockAutoScroll() {
    this.isAutoScrollLocked.set(false);
    if (this.autoScrollLockTimeout) clearTimeout(this.autoScrollLockTimeout);
  }

  /**
   * Полностью автоматическая калибровка синхронизации текста без участия пользователя.
   * Анализирует разницу длительности между аудио-потоком и оригинальной студийной версией текста.
   * Если на YouTube присутствует клиповое интро (напр. логотип, диалог перед песней),
   * плеер сам высчитывает смещение и точно сопоставляет караоке с аудио.
   */
  async loadLyricsForTrack(track: Track, forceReload = false) {
    this.errorMessage.set(null);

    // Отменяем любые предыдущие сетевые запросы
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    const abortCtrl = new AbortController();
    this.currentAbortController = abortCtrl;
    const targetTrackId = track.id;

    // 1. Запрашиваем метаданные трека из SQLite базы (BPM, смещение, сохраненный текст)
    let serverMeta: { bpm?: number; lyrics_offset_ms?: number; synced_lyrics?: string } | null = null;
    try {
      const backendUrl = this.libraryService.getBackendUrl();
      const qId = encodeURIComponent(targetTrackId);
      const qTitle = encodeURIComponent(track.title || '');
      const qArtist = encodeURIComponent(track.artist || '');
      const metaRes = await fetch(`${backendUrl}/api/track/meta?id=${qId}&title=${qTitle}&artist=${qArtist}`, {
        signal: abortCtrl.signal,
      });
      if (metaRes.ok) {
        serverMeta = await metaRes.json();
      }
    } catch {}

    if (abortCtrl.signal.aborted || this.audioService.currentTrack()?.id !== targetTrackId) {
      return;
    }

    // Запускаем анализ BPM (или применяем сохраненный BPM из БД)
    this.bpmService.startDetectionForTrack(targetTrackId, serverMeta?.bpm ?? null);

    // Восстанавливаем сохраненный оффсет таймингов: приоритет локальному localStorage, затем серверной БД
    let hasExplicitOffset = false;
    try {
      const savedOffset = localStorage.getItem(`signal_lyrics_offset_${targetTrackId}`);
      if (savedOffset !== null) {
        const val = parseInt(savedOffset, 10);
        if (!isNaN(val) && Math.abs(val) <= 6000) {
          this.syncOffsetMs.set(val);
          hasExplicitOffset = true;
        } else {
          this.syncOffsetMs.set(0);
          localStorage.removeItem(`signal_lyrics_offset_${targetTrackId}`);
        }
      } else if (serverMeta && serverMeta.lyrics_offset_ms !== undefined && serverMeta.lyrics_offset_ms !== 0) {
        if (Math.abs(serverMeta.lyrics_offset_ms) <= 6000) {
          this.syncOffsetMs.set(serverMeta.lyrics_offset_ms);
          hasExplicitOffset = true;
        } else {
          this.syncOffsetMs.set(0);
        }
      } else {
        this.syncOffsetMs.set(0);
      }
    } catch {
      this.syncOffsetMs.set(0);
    }

    // 2. Проверяем локальный сохраненный пользователем текст
    if (!forceReload) {
      try {
        const savedCustom = localStorage.getItem(`signal_custom_lyrics_${targetTrackId}`);
        if (savedCustom) {
          const parsed = this.parseLrc(savedCustom, 'imported');
          if (parsed.lines.length > 0) {
            this.currentLyrics.set(parsed);
            this.isLoading.set(false);
            return;
          }
        }
      } catch {}

      // Проверяем сохраненный текст в серверной БД
      if (serverMeta && serverMeta.synced_lyrics) {
        const parsed = this.parseLrc(serverMeta.synced_lyrics, 'indexed' as any);
        if (parsed.lines.length > 0) {
          this.setCachedLyrics(targetTrackId, parsed);
          this.currentLyrics.set(parsed);
          this.isLoading.set(false);
          return;
        }
      }

      // Проверяем кэш сессии
      const inMemory = this.lyricsCache.get(targetTrackId);
      if (inMemory) {
        this.currentLyrics.set(inMemory);
        this.isLoading.set(false);
        return;
      }
    }

    // Мгновенно очищаем экран от текста предыдущей песни, чтобы не показывать чужой текст
    this.currentLyrics.set(null);
    this.isLoading.set(true);

    // 3. Запрашиваем через наш бэкенд-агрегатор (LRCLIB + Kugou + кэш)
    try {
      const backendUrl = this.libraryService.getBackendUrl();
      const qTitle = encodeURIComponent(track.title || '');
      const qArtist = encodeURIComponent(track.artist || '');
      const dur = Math.round(track.duration || 0);
      const url = `${backendUrl}/api/lyrics?title=${qTitle}&artist=${qArtist}&duration=${dur}`;

      const res = await fetch(url, { signal: abortCtrl.signal });
      if (res.ok) {
        const data = await res.json();
        if (data && data.lyrics && !abortCtrl.signal.aborted && this.audioService.currentTrack()?.id === targetTrackId) {
          // Валидируем соответствие кандидата треку
          const score = this.matchScore(
            {
              trackName: data.track_name || track.title,
              artistName: data.artist_name || track.artist,
              duration: data.duration,
              syncedLyrics: data.lyrics,
            },
            track.title,
            track.artist,
            track.duration || 0
          );

          if (score >= 45) {
            const parsed = this.parseLrc(data.lyrics, (data.source || 'lrclib') as any);
            if (data.duration && data.duration > 0) {
              parsed.duration = data.duration;
            }
            if (parsed.lines.length > 0) {
              this.setCachedLyrics(targetTrackId, parsed);
              this.currentLyrics.set(parsed);
              this.isLoading.set(false);
              this.persistLyricsToCloud(track, data.lyrics);

              const cur = this.audioService.currentTrack();
              if (cur && cur.id === targetTrackId && (!cur.duration || cur.duration <= 0)) {
                const lastLine = parsed.lines[parsed.lines.length - 1];
                const estimated = Math.round(lastLine.endTime || (lastLine.startTime + 6));
                if (estimated > 10) {
                  cur.duration = estimated;
                  this.audioService.duration.set(estimated);
                }
              }
              return;
            }
          } else {
            console.warn('[Lyrics] Backend returned mismatched candidate, falling back:', data.track_name, data.artist_name);
          }
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.warn('[Lyrics] Backend aggregator unavailable, trying direct web fallback:', e);
    }

    if (abortCtrl.signal.aborted || this.audioService.currentTrack()?.id !== targetTrackId) {
      return;
    }

    // 4. Fallback: прямой поиск через LRCLIB в браузере
    try {
      const lyricsData = await this.fetchFromLrcLib(track, abortCtrl.signal);

      // Защита от race condition: если трек уже сменился или запрос отменен - игнорируем
      if (abortCtrl.signal.aborted || this.audioService.currentTrack()?.id !== targetTrackId) {
        return;
      }

      if (lyricsData) {
        this.setCachedLyrics(targetTrackId, lyricsData);
        this.currentLyrics.set(lyricsData);
        this.isLoading.set(false);
        if (lyricsData.raw) {
          this.persistLyricsToCloud(track, lyricsData.raw);
        }

        // Восстанавливаем длительность трека, если она отсутствовала или была 0
        const cur = this.audioService.currentTrack();
        if (cur && cur.id === targetTrackId && (!cur.duration || cur.duration <= 0)) {
          if (lyricsData.lines.length > 0) {
            const lastLine = lyricsData.lines[lyricsData.lines.length - 1];
            const estimated = Math.round(lastLine.endTime || (lastLine.startTime + 6));
            if (estimated > 10) {
              cur.duration = estimated;
              this.audioService.duration.set(estimated);
            }
          }
        }
        return;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.warn('[Lyrics] Failed to fetch from LRCLIB:', e);
    }

    if (!abortCtrl.signal.aborted && this.audioService.currentTrack()?.id === targetTrackId) {
      this.isLoading.set(false);
      this.currentLyrics.set(null);
    }
  }

  /**
   * Фоновая предзагрузка текста для следующего трека («Моя Волна» / очередь).
   * Не грузит процессор, работает тихо в фоне без изменения UI.
   * Когда трек переключится, текст появится с задержкой 0мс.
   */
  async prefetchNextTrackLyrics(track: Track): Promise<void> {
    if (!track || !track.id || this.lyricsCache.has(track.id)) return;

    try {
      const backendUrl = this.libraryService.getBackendUrl();
      const qTitle = encodeURIComponent(track.title || '');
      const qArtist = encodeURIComponent(track.artist || '');
      const dur = Math.round(track.duration || 0);
      const url = `${backendUrl}/api/lyrics?title=${qTitle}&artist=${qArtist}&duration=${dur}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data && data.lyrics) {
          const parsed = this.parseLrc(data.lyrics, (data.source || 'lrclib') as any);
          if (data.duration && data.duration > 0) {
            parsed.duration = data.duration;
          }
          if (parsed.lines.length > 0) {
            this.setCachedLyrics(track.id, parsed);
            this.persistLyricsToCloud(track, data.lyrics);
          }
        }
      }
    } catch {}
  }

  importLrcText(rawContent: string, trackId?: string) {
    if (!rawContent || !rawContent.trim()) return false;
    const parsed = this.parseLrc(rawContent.trim(), 'imported');
    if (parsed.lines.length === 0) return false;

    this.currentLyrics.set(parsed);
    const tid = trackId || this.audioService.currentTrack()?.id;
    if (parsed.lines.length > 0) {
      const cur = this.audioService.currentTrack();
      if (cur && (!cur.duration || cur.duration <= 0)) {
        const lastLine = parsed.lines[parsed.lines.length - 1];
        const estimated = Math.round(lastLine.endTime || (lastLine.startTime + 6));
        if (estimated > 10) {
          cur.duration = estimated;
          this.audioService.duration.set(estimated);
        }
      }
    }
    if (tid) {
      try {
        localStorage.setItem(`signal_custom_lyrics_${tid}`, rawContent.trim());
      } catch {}
      const cur = this.audioService.currentTrack();
      if (cur) {
        this.persistLyricsToCloud(cur, rawContent.trim());
      }
    }
    return true;
  }

  clearCustomLyrics(trackId?: string) {
    const tid = trackId || this.audioService.currentTrack()?.id;
    if (tid) {
      try {
        localStorage.removeItem(`signal_custom_lyrics_${tid}`);
      } catch {}
    }
    const cur = this.audioService.currentTrack();
    if (cur) {
      this.loadLyricsForTrack(cur, true);
    } else {
      this.currentLyrics.set(null);
    }
  }

  /**
   * Парсинг LRC и Enhanced LRC (пословного караоке) с поддержкой тега [offset: +/- ms]
   */
  parseLrc(lrcText: string, source: 'lrclib' | 'embedded' | 'imported' = 'imported'): ParsedLyrics {
    const lines: LyricLine[] = [];
    let isWordByWord = false;

    // Считываем смещение [offset: +/- ms] по стандарту LRC
    let fileOffsetSec = 0;
    const offsetMatch = lrcText.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch) {
      const ms = parseInt(offsetMatch[1], 10) || 0;
      fileOffsetSec = ms / 1000;
    }

    const rawLines = lrcText.split(/\r?\n/);
    const lineTagRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const wordTagRegex = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>([^<]+)/g;

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      // Пропуск мета-тегов [ar:], [ti:], [al:], [offset:], etc.
      if (/^\[(ar|ti|al|by|offset|length|re|ve):/i.test(trimmed)) {
        continue;
      }

      // Собираем все временные метки строки
      const timestamps: number[] = [];
      let match: RegExpExecArray | null;
      let lastMatchEnd = 0;

      lineTagRegex.lastIndex = 0;
      while ((match = lineTagRegex.exec(trimmed)) !== null) {
        const mins = parseInt(match[1], 10);
        const secs = parseInt(match[2], 10);
        const msStr = match[3] || '0';
        const ms = msStr.length === 1
          ? parseInt(msStr, 10) * 100
          : (msStr.length === 2 ? parseInt(msStr, 10) * 10 : parseInt(msStr.slice(0, 3), 10));
        // Корректируем с учетом [offset:]
        const timeInSecs = Math.max(0, mins * 60 + secs + ms / 1000 - fileOffsetSec);
        timestamps.push(timeInSecs);
        lastMatchEnd = lineTagRegex.lastIndex;
      }

      const textPayload = trimmed.slice(lastMatchEnd).trim();

      if (timestamps.length > 0) {
        // Проверяем наличие пословных таймингов <mm:ss.xx>Слово
        let words: LyricWord[] | undefined = undefined;
        wordTagRegex.lastIndex = 0;
        const foundWords: LyricWord[] = [];
        let wMatch: RegExpExecArray | null;

        while ((wMatch = wordTagRegex.exec(textPayload)) !== null) {
          const wMins = parseInt(wMatch[1], 10);
          const wSecs = parseInt(wMatch[2], 10);
          const wMsStr = wMatch[3] || '0';
          const wMs = wMsStr.length === 1
            ? parseInt(wMsStr, 10) * 100
            : (wMsStr.length === 2 ? parseInt(wMsStr, 10) * 10 : parseInt(wMsStr.slice(0, 3), 10));
          const wTime = Math.max(0, wMins * 60 + wSecs + wMs / 1000 - fileOffsetSec);
          const wText = wMatch[4].trim();
          if (wText) {
            foundWords.push({ text: wText, startTime: wTime });
          }
        }

        if (foundWords.length > 0) {
          isWordByWord = true;
          for (let wi = 0; wi < foundWords.length; wi++) {
            if (wi < foundWords.length - 1) {
              foundWords[wi].endTime = foundWords[wi + 1].startTime;
            }
          }
          words = foundWords;
        }

        const cleanText = textPayload.replace(/<\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();

        // Пропуск технических титров в начале песни (作词, 作曲, Written by, Composed by, etc.)
        if (timestamps[0] <= 4.0 && /^(作词|作曲|written\s*by|composed\s*by|lyrics\s*by|producer)\s*[:：]/i.test(cleanText)) {
          continue;
        }

        if (cleanText.length === 0) {
          // Если строка с таймингом пустая (конец фразы / пауза перед соло),
          // закрываем предыдущую звучащую строку этим моментом времени
          if (lines.length > 0) {
            const last = lines[lines.length - 1];
            if (last.startTime >= 0 && (!last.endTime || timestamps[0] > last.startTime)) {
              last.endTime = timestamps[0];
            }
          }
          continue;
        }

        for (const t of timestamps) {
          lines.push({
            startTime: t,
            text: cleanText,
            words: words ? [...words] : undefined,
          });
        }
      } else if (trimmed.length > 0) {
        // Несинхронизированная строка текста
        lines.push({
          startTime: -1,
          text: trimmed,
        });
      }
    }

    const isSynced = lines.some((l) => l.startTime >= 0);

    let finalLines = lines;
    if (isSynced) {
      // Оставляем только строки с таймингом и текстом, сортируем по возрастанию времени
      finalLines = lines.filter((l) => l.startTime >= 0 && l.text.length > 0);
      finalLines.sort((a, b) => a.startTime - b.startTime);

      // Расчет времени окончания строк с сохранением реалистичных пауз и проигрышей
      for (let i = 0; i < finalLines.length; i++) {
        const cur = finalLines[i];
        const next = i < finalLines.length - 1 ? finalLines[i + 1] : null;

        // Реалистичная оценка длительности пения фразы (~0.38с на слово + 0.6с затухание)
        const words = cur.text.trim().split(/\s+/).filter(Boolean);
        const estimatedPhraseSec = Math.max(1.8, Math.min(8.0, words.length * 0.38 + 0.6));

        if (!cur.endTime || cur.endTime <= cur.startTime) {
          if (next && next.startTime > cur.startTime) {
            const gap = next.startTime - cur.startTime;
            // Если до следующей строки длинная пауза (проигрыш/соло > estimatedPhrase + 1.2с),
            // завершаем строку вовремя, чтобы текст не зависал активным во время молчания
            if (gap > estimatedPhraseSec + 1.2) {
              cur.endTime = cur.startTime + estimatedPhraseSec;
            } else {
              cur.endTime = next.startTime;
            }
          } else {
            cur.endTime = cur.startTime + estimatedPhraseSec;
          }
        }
      }
    }

    const plainText = finalLines.map((l) => l.text).join('\n');

    return {
      isSynced,
      isWordByWord,
      lines: finalLines,
      plainText,
      raw: lrcText,
      source,
    };
  }

  private cleanTextNoise(text: string): string {
    return text
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\((?:official|music|video|audio|lyrics|lyric|remastered|hd|hq|4k|visualizer|feat|ft|prod|клип|премьера|with|extended|original|slowed|reverb|speed|sped|live|bonus|deluxe|edit|acoustic|cover|clip|instrumental|dub|mix)[^)]*\)/gi, ' ')
      .replace(/\{(?:official|music|video|audio|lyrics|lyric|remastered|hd|hq|4k|visualizer|feat|ft|prod|клип|премьера|with|extended|original|slowed|reverb|speed|sped|live|bonus|deluxe|edit|acoustic|cover|clip|instrumental|dub|mix)[^}]*\}/gi, ' ')
      .replace(/\b(?:feat\.?|ft\.?|with)\s+[^\s–—\-()[\]]+/gi, ' ')
      .replace(/\b(official\s+music\s+video|official\s+video|official\s+audio|music\s+video|lyric\s+video|lyrics|official|audio|remastered|hd|hq|4k|visualizer|clip\s+officiel|full\s+album|премьера\s+клипа|премьера\s+песни|премьера\s+трека|официальный\s+клип|текст\s+песни|клип|новинка|хит|slowed\s*[\+&]\s*reverb|slowed\s*reverb|slowed|reverb|speed\s*up|sped\s*up|bass\s*boosted)\b/gi, ' ')
      .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private cleanArtist(artist: string): string {
    return (artist || '')
      .replace(/\b(topic|records|vevo|official|channel|music|label)\b/gi, ' ')
      .replace(/\b(?:feat\.?|ft\.?|with|при\s+уч\.?|с\s+участием)\s+[^\s–—\-()[\]]+/gi, ' ')
      .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeForComparison(s: string): string {
    return (s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private checkTranslitArtistMatch(exp: string, cand: string): boolean {
    const pairs: [string, string][] = [
      ['эндшпиль', 'endspiel'],
      ['эндшпиль', 'andy panda'],
      ['скриптонит', 'scriptonite'],
      ['баста', 'basta'],
      ['кино', 'kino'],
      ['оксимирон', 'oxxxymiron'],
      ['макс корж', 'max korzh'],
      ['моргенштерн', 'morgenshtern'],
      ['лсп', 'lsp'],
      ['хаски', 'husky'],
      ['би 2', 'bi 2'],
      ['би-2', 'bi-2'],
      ['король и шут', 'korol i shut'],
      ['земфира', 'zemfira'],
      ['миджи', 'miyagi'],
      ['мияги', 'miyagi'],
    ];

    for (const [ru, en] of pairs) {
      if ((exp.includes(ru) && cand.includes(en)) || (exp.includes(en) && cand.includes(ru))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Корректно извлекает артиста и название песни из метаданных трека и строки заголовка
   */
  extractSearchInfo(track: Track): { artist: string; title: string; fallbackArtist?: string } {
    let rawTitle = (track.title || '').trim();
    let rawArtist = (track.artist || '').trim();

    let extractedArtist = '';
    let extractedTitle = rawTitle;

    // Check for common artist-title separators
    const separators = [' - ', ' – ', ' — ', ' | ', ' // '];
    for (const sep of separators) {
      if (rawTitle.includes(sep)) {
        const parts = rawTitle.split(sep);
        extractedArtist = parts[0].trim();
        extractedTitle = parts.slice(1).join(sep).trim();
        break;
      }
    }

    const cleanCandidateTitle = this.cleanTextNoise(extractedTitle)
      .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const cleanCandidateArtist = extractedArtist ? this.cleanArtist(extractedArtist) : '';
    let cleanRawArtist = rawArtist ? this.cleanArtist(rawArtist) : '';

    if (/^(unknown|неизвестный|разные|youtube|soundcloud)/i.test(cleanRawArtist)) {
      cleanRawArtist = '';
    }

    let primaryArtist = '';
    let fallbackArtist = '';

    if (cleanCandidateArtist && cleanRawArtist) {
      const isGenericRaw =
        /^(unknown|неизвестный|разные|youtube|soundcloud|topic|vevo|records|music|label|production|official)/i.test(cleanRawArtist) ||
        cleanRawArtist.toLowerCase() === 'разные исполнители';

      if (isGenericRaw || cleanCandidateArtist.toLowerCase() === cleanRawArtist.toLowerCase()) {
        primaryArtist = cleanCandidateArtist;
      } else {
        primaryArtist = cleanCandidateArtist;
        fallbackArtist = cleanRawArtist;
      }
    } else if (cleanCandidateArtist) {
      primaryArtist = cleanCandidateArtist;
    } else {
      primaryArtist = cleanRawArtist;
    }

    return {
      artist: primaryArtist,
      title: cleanCandidateTitle || this.cleanTextNoise(rawTitle),
      fallbackArtist: fallbackArtist || undefined,
    };
  }

  /**
   * Строгая валидация соответствия кандидата из LRCLIB текущему треку.
   * Надежно исключает показ текста чужих песен, поддерживая правильные совпадения
   * даже если на YouTube артистом указан канал/лейбл перезалива.
   */
  matchScore(item: any, expectedTitle: string, expectedArtist: string, expectedDuration: number): number {
    const itemTitleNorm = this.normalizeForComparison(item.trackName || item.name);
    const expTitleNorm = this.normalizeForComparison(expectedTitle);
    const itemArtistNorm = this.normalizeForComparison(item.artistName);
    const expArtistNorm = this.normalizeForComparison(expectedArtist);

    if (!itemTitleNorm || !expTitleNorm) return -999;

    // 1. Проверка длительности трека: отсекаем только явно чужие миксы (>45с разницы)
    let durationPenalty = 0;
    if (expectedDuration > 20 && item.duration > 20) {
      const diff = Math.abs(item.duration - expectedDuration);
      if (diff > 45) return -999;
      if (diff > 15) {
        durationPenalty = Math.round((diff - 15) * 0.8);
      }
    }

    // 2. Проверка названия трека
    const expWords = expTitleNorm.split(' ').filter((w) => w.length >= 2);
    const itemWords = itemTitleNorm.split(' ').filter((w) => w.length >= 2);

    const isSwapped = (expArtistNorm && (itemTitleNorm.includes(expArtistNorm) || expArtistNorm.includes(itemTitleNorm))) &&
                      (itemArtistNorm.includes(expTitleNorm) || expTitleNorm.includes(itemArtistNorm));

    let titleScore = 0;
    let titleRatio = 0;

    if (itemTitleNorm === expTitleNorm || isSwapped) {
      titleRatio = 1.0;
      titleScore = 60;
    } else if (expWords.length === 1) {
      const targetWord = expWords[0];
      if (itemWords.includes(targetWord)) {
        const noiseWords = new Set([
          'official', 'video', 'audio', 'remastered', 'remaster', 'hd', '4k',
          'visualizer', 'clip', 'slowed', 'reverb', 'speed', 'sped', 'up',
          'live', 'edit', 'version', 'acoustic', 'cover', 'instrumental',
          'prod', 'feat', 'ft', 'lyrics', 'lyric', 'mix', 'original', 'extended',
          'клип', 'новинка', 'песня', 'трек', 'хит'
        ]);
        const extraNonNoise = itemWords.filter((w) => w !== targetWord && !noiseWords.has(w));
        if (extraNonNoise.length === 0) {
          titleRatio = 1.0;
          titleScore = 55;
        } else {
          return -999;
        }
      } else {
        return -999;
      }
    } else {
      let matched = 0;
      for (const w of expWords) {
        if (itemWords.includes(w) || itemTitleNorm.includes(w)) matched++;
      }
      titleRatio = matched / expWords.length;
      if (titleRatio < 0.45) {
        return -999;
      }
      titleScore = Math.round(titleRatio * 50);
    }

    // 3. Проверка артиста
    let artistMatched = false;

    if (isSwapped) {
      artistMatched = true;
    } else if (expArtistNorm && expArtistNorm.length >= 2) {
      if (itemArtistNorm === expArtistNorm || itemArtistNorm.includes(expArtistNorm) || expArtistNorm.includes(itemArtistNorm)) {
        artistMatched = true;
      } else {
        const expAWords = expArtistNorm.split(' ').filter((w) => w.length >= 2);
        const itemAWords = itemArtistNorm.split(' ').filter((w) => w.length >= 2);
        for (const ew of expAWords) {
          if (itemAWords.some((iw) => iw.includes(ew) || ew.includes(iw)) || itemTitleNorm.includes(ew)) {
            artistMatched = true;
            break;
          }
        }
        if (!artistMatched && this.checkTranslitArtistMatch(expArtistNorm, itemArtistNorm)) {
          artistMatched = true;
        }
      }
    } else {
      artistMatched = true;
    }

    if (!artistMatched) {
      // Для однословных названий ("Cold") совпадение артиста строго обязательно
      if (expWords.length <= 1) {
        return -999;
      }
      // Для многословных названий при высоком совпадении (>= 70% или exact) пропускаем кандидата,
      // так как на YouTube артистом часто записан канал перезалива / агрегатор
      if (titleRatio < 0.70) {
        return -999;
      }
    }

    let score = titleScore - durationPenalty;
    if (artistMatched) {
      score += 25;
    } else {
      score += 10;
    }
    if (item.syncedLyrics && item.syncedLyrics.trim().length > 0) {
      score += 20;
    }
    if (expectedDuration > 20 && item.duration > 20) {
      const diff = Math.abs(item.duration - expectedDuration);
      if (diff <= 5) score += 15;
      else if (diff <= 12) score += 8;
    }

    return score;
  }

  private async fetchFromLrcLib(track: Track, abortSignal: AbortSignal): Promise<ParsedLyrics | null> {
    const { artist: cleanA, title: cleanT, fallbackArtist } = this.extractSearchInfo(track);
    if (!cleanT) return null;

    const durationSec = Math.round(track.duration || 0);

    const allCandidates: any[] = [];
    const seenIds = new Set<number>();

    const addCandidates = (items: any[]) => {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        if (it && it.id && !seenIds.has(it.id)) {
          seenIds.add(it.id);
          allCandidates.push(it);
        }
      }
    };

    // 1. Попытка точного поиска через /api/get с артистом и названием
    if (cleanA) {
      try {
        let q = `track_name=${encodeURIComponent(cleanT)}&artist_name=${encodeURIComponent(cleanA)}`;
        if (durationSec > 20) q += `&duration=${durationSec}`;
        const res = await fetch(`https://lrclib.net/api/get?${q}`, { signal: abortSignal });
        if (res.ok) {
          const item = await res.json();
          addCandidates([item]);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
      }
    }

    if (abortSignal.aborted) return null;

    // 2. Попытка точного поиска без длительности
    if (allCandidates.length === 0 && cleanA) {
      try {
        const q = `track_name=${encodeURIComponent(cleanT)}&artist_name=${encodeURIComponent(cleanA)}`;
        const res = await fetch(`https://lrclib.net/api/get?${q}`, { signal: abortSignal });
        if (res.ok) {
          const item = await res.json();
          addCandidates([item]);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
      }
    }

    if (abortSignal.aborted) return null;

    // 3. Поиск по каталогу LRCLIB
    const searchQueries: string[] = [];
    if (cleanA) searchQueries.push(`${cleanA} ${cleanT}`);
    if (cleanA) searchQueries.push(`${cleanT} ${cleanA}`);
    if (fallbackArtist && fallbackArtist !== cleanA) searchQueries.push(`${fallbackArtist} ${cleanT}`);
    searchQueries.push(cleanT);

    for (const q of searchQueries) {
      if (allCandidates.length >= 8 || abortSignal.aborted) break;
      try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { signal: abortSignal });
        if (res.ok) {
          const results = await res.json();
          addCandidates(results);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') throw e;
      }
    }

    if (abortSignal.aborted || allCandidates.length === 0) return null;

    // Выбираем кандидата с максимальным совпадением
    let bestCandidate: any = null;
    let bestScore = 55; // Высокий порог: требует совпадения названия и артиста

    for (const item of allCandidates) {
      const score = this.matchScore(item, cleanT, cleanA || fallbackArtist || '', durationSec);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = item;
      }
    }

    if (bestCandidate) {
      if ((!track.duration || track.duration <= 0) && bestCandidate.duration > 0) {
        track.duration = bestCandidate.duration;
        this.audioService.duration.set(bestCandidate.duration);
      }
      let resParsed: ParsedLyrics | null = null;
      if (bestCandidate.syncedLyrics && bestCandidate.syncedLyrics.trim().length > 0) {
        resParsed = this.parseLrc(bestCandidate.syncedLyrics, 'lrclib');
      } else if (bestCandidate.plainLyrics && bestCandidate.plainLyrics.trim().length > 0) {
        resParsed = this.parseLrc(bestCandidate.plainLyrics, 'lrclib');
      }
      if (resParsed && bestCandidate.duration > 0) {
        resParsed.duration = bestCandidate.duration;
      }
      return resParsed;
    }

    return null;
  }
}
