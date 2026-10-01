import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { Track } from '../models/track.model';
import { AudioService } from './audio.service';
import { LibraryService } from './library.service';
import { RecommendationService } from './recommendation.service';
import { NavigationService } from './navigation.service';

export type TimerMood = 'focus' | 'workout' | 'relax' | 'my_music' | 'favorites';

export interface TimerMoodOption {
  id: TimerMood;
  title: string;
  desc: string;
  icon: string;
}

export const TIMER_MOODS: TimerMoodOption[] = [
  { id: 'focus', title: 'Фокус и учеба', desc: 'Lo-Fi, инструментал и спокойный бит', icon: 'brain' },
  { id: 'workout', title: 'Спорт и энергия', desc: 'Фонк, рок, EDM и мощный ритм', icon: 'flame' },
  { id: 'relax', title: 'Сон и релакс', desc: 'Эмбиент, акустика и мягкое звучание', icon: 'moon' },
  { id: 'favorites', title: 'Только любимое', desc: 'Ваши избранные треки', icon: 'heart' },
  { id: 'my_music', title: 'Вся моя музыка', desc: 'Случайные треки из вашей библиотеки', icon: 'library' },
];

@Injectable({
  providedIn: 'root',
})
export class TimerService {
  private readonly audioService = inject(AudioService);
  private readonly libraryService = inject(LibraryService);
  private readonly recService = inject(RecommendationService);
  private readonly navService = inject(NavigationService);

  readonly isActive = signal<boolean>(false);
  readonly isPaused = signal<boolean>(false);
  readonly targetMinutes = signal<number>(25);
  readonly selectedMood = signal<TimerMood>('focus');
  readonly selectedPlaylistId = signal<string | null>(null);

  readonly isGenerating = signal<boolean>(false);
  readonly previewTracks = signal<Track[]>([]);
  readonly remainingSeconds = signal<number>(0);
  readonly totalSessionSeconds = signal<number>(0);

  readonly isTimerModalOpen = signal<boolean>(false);
  readonly isFinishModalOpen = signal<boolean>(false);

  readonly completedSessionStats = signal<{ minutes: number; tracksCount: number } | null>(null);

  private originalQueue: Track[] = [];
  private originalQueueIndex = -1;
  private intervalTimerId: any = null;
  private timerSessionTrackIds: Set<string> = new Set();
  private isFinishTriggered = false;

  readonly previewTotalDuration = computed<number>(() => {
    return this.previewTracks().reduce((acc, t) => acc + (t.duration || 180), 0);
  });

  readonly previewDifferenceSec = computed<number>(() => {
    const target = this.targetMinutes() * 60;
    return Math.round(this.previewTotalDuration() - target);
  });

  readonly sessionProgressPercent = computed<number>(() => {
    const total = this.totalSessionSeconds();
    if (total <= 0) return 0;
    const remaining = this.remainingSeconds();
    const passed = Math.max(0, total - remaining);
    return Math.min(100, Math.max(0, (passed / total) * 100));
  });

  readonly formattedRemaining = computed<string>(() => {
    const sec = Math.max(0, Math.round(this.remainingSeconds()));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  });

  constructor() {
    effect(() => {
      const overlay = this.navService.currentOverlay();
      if (overlay === 'timer') {
        this.isTimerModalOpen.set(true);
      } else if (this.isTimerModalOpen()) {
        this.isTimerModalOpen.set(false);
      }

      if (overlay === 'timer-finish') {
        this.isFinishModalOpen.set(true);
      } else if (this.isFinishModalOpen()) {
        this.isFinishModalOpen.set(false);
      }
    });

    effect(() => {
      if (!this.isActive()) return;
      const currentTrack = this.audioService.currentTrack();
      const queue = this.audioService.queue();
      const queueIndex = this.audioService.queueIndex();

      if (currentTrack && this.timerSessionTrackIds.size > 0) {
        if (queueIndex >= queue.length - 1 && queue.length > 0) {
          const actualDuration = this.audioService.duration();
          const currentTime = this.audioService.currentTime();
          if (actualDuration > 5 && currentTime >= actualDuration - 0.8 && !this.isFinishTriggered) {
            this.finishTimer();
          }
        }
      }
    });
  }

  openTimerModal(pushHistory = true) {
    this.isTimerModalOpen.set(true);
    if (this.previewTracks().length === 0) {
      this.generatePlaylistForTimer();
    }
    if (pushHistory) {
      this.navService.pushOverlay('timer');
    }
  }

  closeTimerModal(popHistory = true) {
    this.isTimerModalOpen.set(false);
    if (popHistory && this.navService.currentOverlay() === 'timer') {
      this.navService.closeOverlay('timer');
    }
  }

  closeFinishModal(popHistory = true) {
    this.isFinishModalOpen.set(false);
    if (popHistory && this.navService.currentOverlay() === 'timer-finish') {
      this.navService.closeOverlay('timer-finish');
    }
  }

  setTargetMinutes(minutes: number) {
    const clamped = Math.max(1, Math.min(180, Math.round(minutes)));
    this.targetMinutes.set(clamped);
    this.generatePlaylistForTimer();
  }

  setMood(mood: TimerMood) {
    this.selectedMood.set(mood);
    this.selectedPlaylistId.set(null);
    this.generatePlaylistForTimer();
  }

  setPlaylist(playlistId: string) {
    this.selectedPlaylistId.set(playlistId);
    this.generatePlaylistForTimer();
  }

  async generatePlaylistForTimer() {
    this.isGenerating.set(true);
    try {
      const targetSec = this.targetMinutes() * 60;
      let candidates = await this.getCandidatesForMood(this.selectedMood(), this.selectedPlaylistId());

      const currentTotal = candidates.reduce((acc, t) => acc + (t.duration || 180), 0);
      if (currentTotal < targetSec) {
        const neededSec = targetSec - currentTotal;
        const extraCount = Math.max(3, Math.ceil(neededSec / 210));
        const onlineTracks = await this.fetchOnlineTracksForMood(this.selectedMood(), extraCount);
        candidates = [...candidates, ...onlineTracks];
      }

      if (candidates.length > 0) {
        let pool = [...candidates];
        let attempts = 0;
        while (pool.reduce((acc, t) => acc + (t.duration || 180), 0) < targetSec && attempts < 4) {
          pool = [...pool, ...this.shuffleArray([...candidates])];
          attempts++;
        }
        const selected = this.solveKnapsack(pool, targetSec);
        this.previewTracks.set(selected);
      } else {
        this.previewTracks.set([]);
      }
    } finally {
      this.isGenerating.set(false);
    }
  }

  startTimerSession() {
    const tracks = this.previewTracks();
    if (tracks.length === 0) return;

    this.originalQueue = [...this.audioService.queue()];
    this.originalQueueIndex = this.audioService.queueIndex();

    this.timerSessionTrackIds = new Set(tracks.map((t) => t.id));
    const totalDuration = tracks.reduce((acc, t) => acc + (t.duration || 180), 0);
    this.totalSessionSeconds.set(totalDuration);
    this.remainingSeconds.set(totalDuration);
    this.isFinishTriggered = false;
    this.isActive.set(true);
    this.isPaused.set(false);

    this.audioService.playTrack(tracks[0], tracks, false, 0);
    this.startTicker();
    this.closeTimerModal();
  }

  private startTicker() {
    if (this.intervalTimerId) {
      clearInterval(this.intervalTimerId);
    }

    this.intervalTimerId = setInterval(() => {
      if (!this.isActive() || this.isPaused()) return;

      const queue = this.audioService.queue();
      const curIdx = this.audioService.queueIndex();
      if (curIdx < 0 || curIdx >= queue.length) return;

      const curTrack = queue[curIdx];
      const curDuration = this.audioService.duration() || curTrack.duration || 180;
      const curTime = this.audioService.currentTime();
      const currentTrackRemaining = Math.max(0, curDuration - curTime);

      let upcomingDuration = 0;
      for (let i = curIdx + 1; i < queue.length; i++) {
        upcomingDuration += queue[i].duration || 180;
      }

      const totalLeft = currentTrackRemaining + upcomingDuration;
      this.remainingSeconds.set(Math.round(totalLeft));

      if (curIdx >= queue.length - 1 && totalLeft <= 10 && !this.isFinishTriggered) {
        this.finishTimer();
      }
    }, 1000);
  }

  finishTimer() {
    if (this.isFinishTriggered) return;
    this.isFinishTriggered = true;

    if (this.intervalTimerId) {
      clearInterval(this.intervalTimerId);
      this.intervalTimerId = null;
    }

    const count = this.timerSessionTrackIds.size;
    const minutes = this.targetMinutes();
    this.completedSessionStats.set({ minutes, tracksCount: count });

    setTimeout(() => {
      this.audioService.pause();
    }, 800);

    this.playFinishChime();

    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([250, 150, 250, 150, 400]);
      } catch {}
    }

    this.sendFinishNotification(minutes, count);

    this.isActive.set(false);
    this.isFinishModalOpen.set(true);
    this.navService.pushOverlay('timer-finish');
  }

  async addFiveMinutes() {
    this.closeFinishModal();
    this.targetMinutes.update((m) => m + 5);

    const extraTracks = await this.getCandidatesForMood(this.selectedMood(), this.selectedPlaylistId());
    let nextTrack = extraTracks.find((t) => !this.timerSessionTrackIds.has(t.id) && t.duration >= 180 && t.duration <= 360);
    if (!nextTrack && extraTracks.length > 0) {
      nextTrack = extraTracks[0];
    }

    if (nextTrack) {
      this.audioService.playNext(nextTrack);
      this.timerSessionTrackIds.add(nextTrack.id);
      this.remainingSeconds.update((r) => r + (nextTrack!.duration || 300));
      this.totalSessionSeconds.update((t) => t + (nextTrack!.duration || 300));
    }

    this.isFinishTriggered = false;
    this.isActive.set(true);
    this.startTicker();
    this.audioService.play();
  }

  cancelTimer(restoreOriginalQueue = false) {
    if (this.intervalTimerId) {
      clearInterval(this.intervalTimerId);
      this.intervalTimerId = null;
    }

    this.isActive.set(false);
    this.isPaused.set(false);
    this.timerSessionTrackIds.clear();

    if (restoreOriginalQueue && this.originalQueue.length > 0) {
      const idx = Math.max(0, this.originalQueueIndex);
      const target = this.originalQueue[idx] || this.originalQueue[0];
      this.audioService.playTrack(target, this.originalQueue, false, idx);
    }
  }

  togglePause() {
    if (!this.isActive()) return;
    if (this.audioService.isPlaying()) {
      this.audioService.pause();
      this.isPaused.set(true);
    } else {
      this.audioService.play();
      this.isPaused.set(false);
    }
  }

  private playFinishChime() {
    if (typeof window === 'undefined') return;
    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      const ctx = new AudioCtxClass();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now);
      osc1.frequency.exponentialRampToValueAtTime(1046.5, now + 1.2);

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(659.25, now);
      osc2.frequency.exponentialRampToValueAtTime(1318.5, now + 1.2);

      gain.gain.setValueAtTime(0.28, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 2.4);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 2.4);
      osc2.stop(now + 2.4);
    } catch {}
  }

  private sendFinishNotification(minutes: number, tracksCount: number) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      try {
        new Notification('Время таймера вышло! ⏱️', {
          body: `Ваша сессия на ${minutes} мин завершена (${tracksCount} треков).`,
          icon: '/favicon.ico',
        });
      } catch {}
    }
  }

  private async getCandidatesForMood(mood: TimerMood, playlistId?: string | null): Promise<Track[]> {
    const allTracks = this.libraryService.tracks().filter((t) => !t.isLiveStream && t.duration >= 30 && t.duration <= 1200);

    if (playlistId) {
      const pl = this.libraryService.playlists().find((p) => p.id === playlistId);
      if (pl) {
        const idSet = new Set(pl.trackIds);
        const fromPl = allTracks.filter((t) => idSet.has(t.id));
        if (fromPl.length > 0) return fromPl;
      }
    }

    if (mood === 'favorites') {
      const favs = allTracks.filter((t) => t.isFavorite);
      return favs.length > 0 ? favs : allTracks;
    }

    if (mood === 'my_music') {
      return allTracks;
    }

    if (mood === 'focus') {
      const focus = allTracks.filter((t) => {
        const text = `${t.genre || ''} ${t.title} ${t.artist}`.toLowerCase();
        return /\b(lo-?fi|chill|ambient|piano|study|relax|лаборатория|инструментал)\b/i.test(text);
      });
      return focus.length >= 3 ? focus : allTracks;
    }

    if (mood === 'workout') {
      const workout = allTracks.filter((t) => {
        const text = `${t.genre || ''} ${t.title} ${t.artist}`.toLowerCase();
        return /\b(phonk|rock|metal|punk|edm|bass|drill|hardstyle|hyperpop|фонк|спорт)\b/i.test(text);
      });
      return workout.length >= 3 ? workout : allTracks;
    }

    if (mood === 'relax') {
      const relax = allTracks.filter((t) => {
        const text = `${t.genre || ''} ${t.title} ${t.artist}`.toLowerCase();
        return /\b(lo-?fi|chill|ambient|acoustic|piano|sleep|calm|soft|акустика|сон)\b/i.test(text);
      });
      return relax.length >= 3 ? relax : allTracks;
    }

    return allTracks;
  }

  private async fetchOnlineTracksForMood(mood: TimerMood, count: number): Promise<Track[]> {
    try {
      let query = 'lofi focus beats';
      if (mood === 'workout') query = 'phonk workout gym motivation';
      else if (mood === 'relax') query = 'deep chill acoustic relax';
      else if (mood === 'favorites' || mood === 'my_music') query = 'popular hits mix';

      const results = await this.libraryService.searchOnline(query);
      return results
        .filter((t) => !t.isLiveStream && t.duration >= 45 && t.duration <= 720)
        .slice(0, count);
    } catch {
      return [];
    }
  }

  private solveKnapsack(pool: Track[], targetSeconds: number): Track[] {
    const shuffled = this.shuffleArray([...pool]);
    const selected: Track[] = [];
    let currentSum = 0;

    for (const track of shuffled) {
      const dur = track.duration || 180;
      if (currentSum + dur <= targetSeconds + 30) {
        selected.push(track);
        currentSum += dur;
      }
      if (currentSum >= targetSeconds - 45) {
        break;
      }
    }

    if (currentSum < targetSeconds - 60) {
      const remainingNeed = targetSeconds - currentSum;
      let bestCandidate: Track | null = null;
      let minDiff = 99999;

      for (const track of shuffled) {
        if (selected.some((s) => s.id === track.id)) continue;
        const dur = track.duration || 180;
        const diff = Math.abs(dur - remainingNeed);
        if (diff < minDiff) {
          minDiff = diff;
          bestCandidate = track;
        }
      }

      if (bestCandidate) {
        selected.push(bestCandidate);
      }
    }

    return selected.length > 0 ? selected : [shuffled[0]];
  }

  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
