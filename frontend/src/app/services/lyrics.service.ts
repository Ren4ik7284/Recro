import { Injectable, signal, computed, inject } from '@angular/core';
import { AudioService } from './audio.service';
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
  source: 'lrclib' | 'embedded' | 'imported' | 'none';
}

@Injectable({
  providedIn: 'root',
})
export class LyricsService {
  private readonly audioService = inject(AudioService);

  readonly isLyricsOpen = signal<boolean>(false);
  readonly isLoading = signal<boolean>(false);
  readonly currentLyrics = signal<ParsedLyrics | null>(null);
  readonly syncOffsetMs = signal<number>(0);
  readonly errorMessage = signal<string | null>(null);
  readonly isAutoScrollLocked = signal<boolean>(false);

  private lastLoadedTrackId: string | null = null;
  private autoScrollLockTimeout: any = null;
  readonly precisePlaybackTime = signal<number>(0);

  // Индекс активной строки текста в зависимости от текущего времени трека
  readonly activeLineIndex = computed<number>(() => {
    const lyrics = this.currentLyrics();
    if (!lyrics || !lyrics.isSynced || lyrics.lines.length === 0) return -1;

    // +0.16с упреждение: караоке подсвечивает фразу в момент начала звучания первого слога
    const t = Math.max(0, this.precisePlaybackTime() + 0.16 + this.syncOffsetMs() / 1000);

    let activeIdx = -1;
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (t >= lyrics.lines[i].startTime) {
        activeIdx = i;
      } else {
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
    const adjustedTime = Math.max(0, this.precisePlaybackTime() + 0.16 + this.syncOffsetMs() / 1000);
    const start = currentLine.startTime;
    const nextLine = lyrics.lines[idx + 1];
    const end = currentLine.endTime || (nextLine ? nextLine.startTime : start + 4);

    if (end <= start) return 1;
    const progress = (adjustedTime - start) / (end - start);
    return Math.min(1, Math.max(0, progress));
  });

  private lyricsCache = new Map<string, ParsedLyrics>();

  constructor() {
    if (typeof window !== 'undefined') {
      // 1. Высокоточный таймер синхронизации (25 раз в секунду) для устранения лага timeupdate
      setInterval(() => {
        if (this.audioService.isPlaying()) {
          const exact = this.audioService.getPreciseCurrentTime();
          this.precisePlaybackTime.set(exact);
        } else {
          this.precisePlaybackTime.set(this.audioService.currentTime());
        }
      }, 40);

      // 2. Автоматическая фоновая предзагрузка текста при смене любого трека
      setInterval(() => {
        const cur = this.audioService.currentTrack();
        if (cur && cur.id !== this.lastLoadedTrackId) {
          this.lastLoadedTrackId = cur.id;
          this.loadLyricsForTrack(cur);
        }
      }, 350);
    }
  }

  toggleLyricsView() {
    const nextState = !this.isLyricsOpen();
    this.isLyricsOpen.set(nextState);
    if (nextState) {
      const cur = this.audioService.currentTrack();
      if (cur) {
        this.loadLyricsForTrack(cur);
      }
    }
  }

  openLyrics() {
    this.isLyricsOpen.set(true);
    const cur = this.audioService.currentTrack();
    if (cur) {
      this.loadLyricsForTrack(cur);
    }
  }

  closeLyrics() {
    this.isLyricsOpen.set(false);
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
    const target = Math.max(0, line.startTime - this.syncOffsetMs() / 1000);
    this.audioService.seek(target);
    this.unlockAutoScroll();
  }

  // При ручном скролле временно блокируем автоцентровку на 3.5 секунды
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

  async loadLyricsForTrack(track: Track, forceReload = false) {
    this.errorMessage.set(null);

    // Восстанавливаем сохраненный оффсет таймингов
    try {
      const savedOffset = localStorage.getItem(`signal_lyrics_offset_${track.id}`);
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
        const savedCustom = localStorage.getItem(`signal_custom_lyrics_${track.id}`);
        if (savedCustom) {
          const parsed = this.parseLrc(savedCustom, 'imported');
          if (parsed.lines.length > 0) {
            this.currentLyrics.set(parsed);
            return;
          }
        }
      } catch {}

      // Проверяем память кэша сессии
      const inMemory = this.lyricsCache.get(track.id);
      if (inMemory) {
        this.currentLyrics.set(inMemory);
        return;
      }
    }

    // 2. Ищем в базе LRCLIB
    this.isLoading.set(true);
    try {
      const lyricsData = await this.fetchFromLrcLib(track);
      if (lyricsData) {
        this.lyricsCache.set(track.id, lyricsData);
        this.currentLyrics.set(lyricsData);
        this.isLoading.set(false);
        return;
      }
    } catch (e) {
      console.warn('[Lyrics] Failed to fetch from LRCLIB:', e);
    }

    this.isLoading.set(false);
    this.currentLyrics.set(null);
  }

  importLrcText(rawContent: string, trackId?: string) {
    if (!rawContent || !rawContent.trim()) return false;
    const parsed = this.parseLrc(rawContent.trim(), 'imported');
    if (parsed.lines.length === 0) return false;

    this.currentLyrics.set(parsed);
    const tid = trackId || this.audioService.currentTrack()?.id;
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
   * Парсинг LRC и Enhanced LRC (пословного караоке)
   */
  parseLrc(lrcText: string, source: 'lrclib' | 'embedded' | 'imported' = 'imported'): ParsedLyrics {
    const lines: LyricLine[] = [];
    let isWordByWord = false;

    const rawLines = lrcText.split(/\r?\n/);
    const lineTagRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
    const wordTagRegex = /<(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?>([^<]+)/g;

    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      // Пропуск мета-тегов [ar:], [ti:], [al:], etc.
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
        const ms = msStr.length === 2 ? parseInt(msStr, 10) * 10 : parseInt(msStr.padEnd(3, '0').slice(0, 3), 10);
        const timeInSecs = mins * 60 + secs + ms / 1000;
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
          const wMs = wMsStr.length === 2 ? parseInt(wMsStr, 10) * 10 : parseInt(wMsStr.padEnd(3, '0').slice(0, 3), 10);
          const wTime = wMins * 60 + wSecs + wMs / 1000;
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

        const cleanText = textPayload.replace(/<\d{1,2}:\d{2}(?:\.\d{2,3})?>/g, '').trim();

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

    // Сортировка по времени
    lines.sort((a, b) => a.startTime - b.startTime);

    // Расчет времени окончания строк
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startTime >= 0 && i < lines.length - 1 && lines[i + 1].startTime >= 0) {
        lines[i].endTime = lines[i + 1].startTime;
      }
    }

    const isSynced = lines.some((l) => l.startTime >= 0);
    const plainText = lines.map((l) => l.text).join('\n');

    return {
      isSynced,
      isWordByWord,
      lines,
      plainText,
      raw: lrcText,
      source,
    };
  }

  private cleanTitle(title: string): string {
    return title
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\b(official|music|video|audio|lyrics|lyric|remastered|hd|hq|4k|visualizer|feat|ft|prod)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private cleanArtist(artist: string): string {
    return artist
      .replace(/\b(topic|records|vevo|official)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Строгая валидация соответствия кандидата из базы LRCLIB текущему треку.
   * Отсекает чужие треки, если не совпадают слова названия, исполнитель или хронометраж.
   */
  private matchScore(item: any, expectedTitle: string, expectedArtist: string, expectedDuration: number): number {
    let score = 0;

    // 1. Проверка длительности трека: разница более 25 секунд — это 100% чужой трек
    if (expectedDuration > 10 && item.duration) {
      const diff = Math.abs(item.duration - expectedDuration);
      if (diff <= 4) score += 40;
      else if (diff <= 8) score += 25;
      else if (diff <= 14) score += 10;
      else if (diff > 25) return -100;
    }

    const itemTitle = (item.trackName || '').toLowerCase().trim();
    const cleanExpTitle = expectedTitle.toLowerCase().trim();

    // 2. Проверка совпадения ключевых слов названия
    const expWords = cleanExpTitle.split(/\s+/).filter((w) => w.length > 2);
    let matchedWords = 0;
    for (const w of expWords) {
      if (itemTitle.includes(w)) matchedWords++;
    }
    if (expWords.length > 0) {
      score += (matchedWords / expWords.length) * 40;
    }

    if (itemTitle === cleanExpTitle) score += 30;
    else if (itemTitle.includes(cleanExpTitle) || cleanExpTitle.includes(itemTitle)) score += 20;

    // 3. Проверка исполнителя
    const itemArtist = (item.artistName || '').toLowerCase().trim();
    const cleanExpArtist = expectedArtist.toLowerCase().trim();
    if (cleanExpArtist && cleanExpArtist !== 'разные исполнители') {
      if (itemArtist.includes(cleanExpArtist) || cleanExpArtist.includes(itemArtist)) {
        score += 35;
      } else {
        const artistWords = cleanExpArtist.split(/[\s,&]+/).filter((w) => w.length > 2);
        let aMatched = 0;
        for (const aw of artistWords) {
          if (itemArtist.includes(aw)) aMatched++;
        }
        if (artistWords.length > 0 && aMatched > 0) {
          score += (aMatched / artistWords.length) * 25;
        } else {
          score -= 30;
        }
      }
    }

    // 4. Бонус за наличие синхронизированных строк
    if (item.syncedLyrics && item.syncedLyrics.trim().length > 0) {
      score += 25;
    }

    return score;
  }

  private async fetchFromLrcLib(track: Track): Promise<ParsedLyrics | null> {
    const rawTitle = track.title || '';
    const rawArtist = track.artist || '';

    let cleanT = this.cleanTitle(rawTitle);
    let cleanA = this.cleanArtist(rawArtist);

    if (rawTitle.includes(' - ')) {
      const parts = rawTitle.split(' - ');
      if (!cleanA || cleanA.toLowerCase() === 'разные исполнители') {
        cleanA = this.cleanArtist(parts[0]);
      }
      cleanT = this.cleanTitle(parts.slice(1).join(' '));
    }

    if (!cleanT) return null;

    const durationSec = Math.round(track.duration || 0);

    // 1. Попытка точного совпадения через /api/get
    try {
      let queryParams = `track_name=${encodeURIComponent(cleanT)}`;
      if (cleanA && cleanA.toLowerCase() !== 'разные исполнители') {
        queryParams += `&artist_name=${encodeURIComponent(cleanA)}`;
      }
      if (durationSec > 10) {
        queryParams += `&duration=${durationSec}`;
      }

      const exactRes = await fetch(`https://lrclib.net/api/get?${queryParams}`, {
        signal: AbortSignal.timeout(3500),
      });

      if (exactRes.ok) {
        const data = await exactRes.json();
        const score = this.matchScore(data, cleanT, cleanA, durationSec);
        if (score >= 40) {
          if (data.syncedLyrics) {
            return this.parseLrc(data.syncedLyrics, 'lrclib');
          } else if (data.plainLyrics) {
            return this.parseLrc(data.plainLyrics, 'lrclib');
          }
        }
      }
    } catch {}

    // 2. Поиск по каталогу с ранжированием и строгой фильтрацией
    const queries = [
      cleanA && cleanA.toLowerCase() !== 'разные исполнители' ? `${cleanT} ${cleanA}` : cleanT,
      cleanT,
      rawTitle,
    ];

    const allCandidates: any[] = [];
    const seenIds = new Set<number>();

    for (const q of queries) {
      if (!q || q.trim().length === 0) continue;
      try {
        const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q.trim())}`, {
          signal: AbortSignal.timeout(3500),
        });

        if (searchRes.ok) {
          const results: any[] = await searchRes.json();
          if (Array.isArray(results)) {
            for (const r of results) {
              if (r.id && !seenIds.has(r.id)) {
                seenIds.add(r.id);
                allCandidates.push(r);
              }
            }
          }
        }
      } catch {}
    }

    // Выбираем кандидата с максимальным совпадением
    let bestCandidate: any = null;
    let bestScore = 38; // Минимальный порог уверенности

    for (const item of allCandidates) {
      const score = this.matchScore(item, cleanT, cleanA, durationSec);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = item;
      }
    }

    if (bestCandidate) {
      if (bestCandidate.syncedLyrics) {
        return this.parseLrc(bestCandidate.syncedLyrics, 'lrclib');
      } else if (bestCandidate.plainLyrics) {
        return this.parseLrc(bestCandidate.plainLyrics, 'lrclib');
      }
    }

    return null;
  }
}
