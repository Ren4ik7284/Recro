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

@Injectable({
  providedIn: 'root',
})
export class LyricsService {
  private readonly audioService = inject(AudioService);
  private readonly navService = inject(NavigationService);
  private readonly libraryService = inject(LibraryService);

  readonly isLyricsOpen = signal<boolean>(false);
  readonly isLoading = signal<boolean>(false);
  readonly currentLyrics = signal<ParsedLyrics | null>(null);
  readonly syncOffsetMs = signal<number>(0);
  readonly errorMessage = signal<string | null>(null);
  readonly isAutoScrollLocked = signal<boolean>(false);

  private lastLoadedTrackId: string | null = null;
  private autoScrollLockTimeout: any = null;
  private currentAbortController: AbortController | null = null;
  readonly precisePlaybackTime = signal<number>(0);

  // Индекс активной строки текста в зависимости от текущего времени трека
  readonly activeLineIndex = computed<number>(() => {
    const lyrics = this.currentLyrics();
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) return -1;

    // Упреждение (lookahead 350мс) как в Spotify и Apple Music:
    // Нивелирует аппаратную буферизацию звука и длительность плавной анимации скролла,
    // благодаря чему строка подсвечивается и встает по центру точно к моменту звучания слов
    const leadTimeSec = 0.35;
    const t = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);

    let activeIdx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) {
      const line = lyrics.lines[i];
      if (line.startTime >= 0 && t >= line.startTime) {
        activeIdx = i;
      } else if (line.startTime > t) {
        break;
      }
    }

    return activeIdx;
  });

  // Прогресс воспроизведения внутри текущей строки (0..1)
  readonly activeLineProgress = computed<number>(() => {
    const idx = this.activeLineIndex();
    const lyrics = this.currentLyrics();
    if (idx === -1 || !lyrics || idx >= lyrics.lines.length) return 0;

    const currentLine = lyrics.lines[idx];
    if (currentLine.startTime < 0) return 0;

    const leadTimeSec = 0.35;
    const adjustedTime = Math.max(0, this.precisePlaybackTime() + this.syncOffsetMs() / 1000 + leadTimeSec);
    const start = currentLine.startTime;
    const nextLine = lyrics.lines[idx + 1];
    const end = currentLine.endTime || (nextLine && nextLine.startTime >= 0 ? nextLine.startTime : start + 4);

    if (end <= start) return 1;
    const progress = (adjustedTime - start) / (end - start);
    return Math.min(1, Math.max(0, progress));
  });

  private lyricsCache = new Map<string, ParsedLyrics>();

  constructor() {
    if (typeof window !== 'undefined') {
      // 1. Плавный таймер времени воспроизведения без задержек (30 раз в секунду)
      setInterval(() => {
        if (this.audioService.isPlaying()) {
          const exact = this.audioService.getPreciseCurrentTime();
          this.precisePlaybackTime.set(exact);
        } else {
          this.precisePlaybackTime.set(this.audioService.currentTime());
        }
      }, 33);

      // 2. Реактивная мгновенная загрузка текста при смене трека (0мс задержки вместо setInterval)
      effect(() => {
        const cur = this.audioService.currentTrack();
        if (cur) {
          if (cur.id !== this.lastLoadedTrackId) {
            this.lastLoadedTrackId = cur.id;
            this.loadLyricsForTrack(cur);
          }
        } else {
          this.lastLoadedTrackId = null;
          this.currentLyrics.set(null);
          this.isLoading.set(false);
        }
      });
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
    if (pushHistory) {
      this.navService.pushOverlay('lyrics');
    }
    const cur = this.audioService.currentTrack();
    if (cur) {
      this.loadLyricsForTrack(cur);
    }
  }

  closeLyrics(popHistory = true) {
    this.isLyricsOpen.set(false);
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

    const leadTimeSec = 0.35;
    const current = this.precisePlaybackTime();
    // targetLine.startTime == current + offsetSec + leadTimeSec
    const newOffsetMs = Math.round((targetLine.startTime - current - leadTimeSec) * 1000);
    this.syncOffsetMs.set(newOffsetMs);
    const cur = this.audioService.currentTrack();
    if (cur) {
      try {
        localStorage.setItem(`signal_lyrics_offset_${cur.id}`, newOffsetMs.toString());
      } catch {}
    }
  }

  resetOffset() {
    this.syncOffsetMs.set(0);
    const cur = this.audioService.currentTrack();
    if (cur) {
      try {
        localStorage.removeItem(`signal_lyrics_offset_${cur.id}`);
      } catch {}
    }
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
  private autoCalibrateTiming(track: Track, lyrics: ParsedLyrics) {
    if (!lyrics.isSynced || lyrics.lines.length === 0) return;
    const targetTrackId = track.id;

    // Если пользователь ранее сохранил персональный оффсет — не перезаписываем его
    try {
      const saved = localStorage.getItem(`signal_lyrics_offset_${targetTrackId}`);
      if (saved !== null) return;
    } catch {}

    const audioDur = track.duration || this.audioService.duration();
    const lrcDur = lyrics.duration || 0;

    if (audioDur > 20 && lrcDur > 20) {
      const diffSec = audioDur - lrcDur;
      // Если аудио отличается от эталонного альбома на 1.2 - 14 секунд:
      // В 95% клипов это интро/аутро в видео. Если аудио длинее (diffSec > 0),
      // слова звучат позже, компенсируем сдвигом назад.
      if (Math.abs(diffSec) >= 1.2 && Math.abs(diffSec) <= 14) {
        const autoOffsetMs = Math.round(-diffSec * 1000);
        this.syncOffsetMs.set(autoOffsetMs);
      }
    }
  }

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

    // Восстанавливаем сохраненный оффсет таймингов
    try {
      const savedOffset = localStorage.getItem(`signal_lyrics_offset_${targetTrackId}`);
      if (savedOffset) {
        this.syncOffsetMs.set(parseInt(savedOffset, 10) || 0);
      } else {
        this.syncOffsetMs.set(0);
      }
    } catch {
      this.syncOffsetMs.set(0);
    }

    // 1. Проверяем локальный сохраненный пользователем текст
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

    // 2. Сначала запрашиваем через наш бэкенд-агрегатор (LRCLIB + Kugou + кэш)
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
          const parsed = this.parseLrc(data.lyrics, (data.source || 'lrclib') as any);
          if (data.duration && data.duration > 0) {
            parsed.duration = data.duration;
          }
          if (parsed.lines.length > 0) {
            this.autoCalibrateTiming(track, parsed);
            this.lyricsCache.set(targetTrackId, parsed);
            this.currentLyrics.set(parsed);
            this.isLoading.set(false);

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
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      console.warn('[Lyrics] Backend aggregator unavailable, trying direct web fallback:', e);
    }

    if (abortCtrl.signal.aborted || this.audioService.currentTrack()?.id !== targetTrackId) {
      return;
    }

    // 3. Fallback: прямой поиск через LRCLIB в браузере
    try {
      const lyricsData = await this.fetchFromLrcLib(track, abortCtrl.signal);

      // Защита от race condition: если трек уже сменился или запрос отменен - игнорируем
      if (abortCtrl.signal.aborted || this.audioService.currentTrack()?.id !== targetTrackId) {
        return;
      }

      if (lyricsData) {
        this.autoCalibrateTiming(track, lyricsData);
        this.lyricsCache.set(targetTrackId, lyricsData);
        this.currentLyrics.set(lyricsData);
        this.isLoading.set(false);

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

      // Расчет времени окончания строк с сохранением границ пауз
      for (let i = 0; i < finalLines.length; i++) {
        if (!finalLines[i].endTime) {
          if (i < finalLines.length - 1) {
            finalLines[i].endTime = finalLines[i + 1].startTime;
          } else {
            finalLines[i].endTime = finalLines[i].startTime + 5;
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
      .replace(/\b(official\s+music\s+video|official\s+video|official\s+audio|music\s+video|lyric\s+video|lyrics|official|audio|remastered|hd|hq|4k|visualizer|clip\s+officiel|full\s+album|премьера\s+клипа|премьера\s+песни|премьера\s+трека|официальный\s+клип|текст\s+песни|клип|новинка|хит|slowed\s*\+\s*reverb|slowed|reverb|speed\s*up|sped\s*up)\b/gi, ' ')
      .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private cleanArtist(artist: string): string {
    return (artist || '')
      .replace(/\b(topic|records|vevo|official|channel|music)\b/gi, ' ')
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
   * Полностью исключает показ текста чужих песен.
   */
  matchScore(item: any, expectedTitle: string, expectedArtist: string, expectedDuration: number): number {
    const itemTitleNorm = this.normalizeForComparison(item.trackName || item.name);
    const expTitleNorm = this.normalizeForComparison(expectedTitle);
    const itemArtistNorm = this.normalizeForComparison(item.artistName);
    const expArtistNorm = this.normalizeForComparison(expectedArtist);

    if (!itemTitleNorm || !expTitleNorm) return -999;

    // 1. Проверка длительности трека: отсекаем только явно чужие миксы (>50с разницы)
    let durationPenalty = 0;
    if (expectedDuration > 20 && item.duration > 20) {
      const diff = Math.abs(item.duration - expectedDuration);
      if (diff > 50) return -999;
      if (diff > 25) {
        durationPenalty = 20; // небольшой штраф за клиповые заставки
      }
    }

    // 2. Проверка артиста с поддержкой перевернутых полей (автор <-> название в базе)
    let artistMatched = false;
    const isSwapped = (expArtistNorm && (itemTitleNorm.includes(expArtistNorm) || expArtistNorm.includes(itemTitleNorm))) &&
                      (itemArtistNorm.includes(expTitleNorm) || expTitleNorm.includes(itemArtistNorm));

    if (isSwapped) {
      artistMatched = true;
    } else if (expArtistNorm && expArtistNorm.length >= 2) {
      if (itemArtistNorm === expArtistNorm || itemArtistNorm.includes(expArtistNorm) || expArtistNorm.includes(itemArtistNorm)) {
        artistMatched = true;
      } else {
        const expWords = expArtistNorm.split(' ').filter((w) => w.length >= 2);
        const itemWords = itemArtistNorm.split(' ').filter((w) => w.length >= 2);
        for (const ew of expWords) {
          if (itemWords.some((iw) => iw.includes(ew) || ew.includes(iw)) || itemTitleNorm.includes(ew)) {
            artistMatched = true;
            break;
          }
        }
        if (!artistMatched && this.checkTranslitArtistMatch(expArtistNorm, itemArtistNorm)) {
          artistMatched = true;
        }
      }

      if (!artistMatched && !itemTitleNorm.includes(expArtistNorm)) {
        return -999; // АРТИСТ НЕ СОВПАЛ
      }
    } else {
      artistMatched = true;
    }

    // 3. Проверка названия
    let titleScore = 0;
    if (itemTitleNorm === expTitleNorm || isSwapped) {
      titleScore = 60;
    } else {
      const expWords = expTitleNorm.split(' ').filter((w) => w.length >= 2);
      const itemWords = itemTitleNorm.split(' ').filter((w) => w.length >= 2);

      if (expWords.length === 1) {
        if (itemTitleNorm.includes(expWords[0]) || itemWords.includes(expWords[0])) {
          titleScore = 55;
        } else {
          return -999;
        }
      } else {
        let matched = 0;
        for (const w of expWords) {
          if (itemWords.includes(w) || itemTitleNorm.includes(w)) matched++;
        }
        const ratio = matched / expWords.length;
        if (ratio < 0.4) {
          return -999;
        }
        titleScore = Math.round(ratio * 50);
      }
    }

    let score = titleScore - durationPenalty;
    if (artistMatched) {
      score += 25;
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
