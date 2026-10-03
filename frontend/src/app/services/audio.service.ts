import { Injectable, signal, computed, inject } from '@angular/core';
import { Track } from '../models/track.model';
import { LibraryService } from './library.service';
import { OfflineService } from './offline.service';
import { RecommendationService, MixMood } from './recommendation.service';
import { NavigationService } from './navigation.service';

@Injectable({
  providedIn: 'root',
})
export class AudioService {
  private libraryService = inject(LibraryService);
  private offlineService = inject(OfflineService);
  readonly recService = inject(RecommendationService);
  private navService = inject(NavigationService);
  private audio: HTMLAudioElement;

  // Web Audio API Nodes for Normalization & Crossfade & Visualizer
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private isAudioGraphReady = false;

  readonly isNormalizationEnabled = signal<boolean>(true);
  readonly isCrossfadeEnabled = signal<boolean>(true);
  readonly isVisualizerOpen = signal<boolean>(false);

  readonly currentTrack = signal<Track | null>(null);
  readonly isPlaying = signal<boolean>(false);
  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly streamSeekOffset = signal<number>(0);
  private readonly STORAGE_KEY_VOLUME = 'signal_player_volume';
  readonly volume = signal<number>(this.loadSavedVolume());
  readonly isMuted = signal<boolean>(false);
  readonly isShuffle = signal<boolean>(false);
  readonly repeatMode = signal<'off' | 'all' | 'one'>('all');
  readonly queue = signal<Track[]>([]);
  readonly queueIndex = signal<number>(-1);
  readonly preloadedNextTrack = signal<Track | null>(null);

  private isHandlingEnd = false;
  private hasAudioStartedPlaying = false;
  private isFadingOut = false;
  private hasRecordedCompletion = false;
  private hasPreloadedNextTrack = false;
  private lastPreloadedTrackId: string | null = null;
  private isReplenishingQueue = false;
  private replenishingPromise: Promise<void> | null = null;
  private consecutiveErrorCount = 0;
  private errorTimeoutId: any = null;
  private fadeIntervalId: any = null;
  private currentPlayRequestId = 0;
  private isSwitchingTrack = false;
  // Timestamp-дебаунс для ensureSmartQueue в timeupdate: не спамить вызов каждые 250ms
  private lastQueueEnsureTime = 0;
  private wakeLockSentinel: any = null;

  private async requestWakeLock() {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        if (!this.wakeLockSentinel) {
          this.wakeLockSentinel = await (navigator as any).wakeLock.request('screen');
          this.wakeLockSentinel.addEventListener('release', () => {
            this.wakeLockSentinel = null;
          });
        }
      } catch {}
    }
  }

  private releaseWakeLock() {
    if (this.wakeLockSentinel) {
      try {
        this.wakeLockSentinel.release();
      } catch {}
      this.wakeLockSentinel = null;
    }
  }

  readonly progressPercent = computed(() => {
    const d = this.duration();
    if (!d || d <= 0 || !isFinite(d)) return 0;
    return Math.min(100, (this.currentTime() / d) * 100);
  });

  readonly isLiveStream = computed(() => {
    const track = this.currentTrack();
    if (!track) return false;
    if (track.isLiveStream) return true;
    const d = this.duration();
    if ((track.duration && track.duration > 0) || (d > 0 && isFinite(d))) {
      return false;
    }
    return true;
  });

  getPreciseCurrentTime(): number {
    if (!this.audio || !this.hasAudioStartedPlaying) {
      return this.currentTime();
    }
    const audioTime = this.audio.currentTime;
    if (isNaN(audioTime) || !isFinite(audioTime) || audioTime < 0) {
      return this.currentTime();
    }
    return this.streamSeekOffset() + audioTime;
  }

  private loadSavedVolume(): number {
    if (typeof localStorage === 'undefined') return 0.35;
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_VOLUME);
      if (saved !== null) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
          // If the user had the previous loud 0.85 default, gently reset to 0.35
          return parsed > 0.60 ? 0.35 : parsed;
        }
      }
    } catch {}
    return 0.35;
  }

  /**
   * Translates linear UI slider position (0..1) to human ear perceived loudness
   * using a quadratic curve so the middle position is comfortable, gentle, and doesn't cut ears.
   */
  private effectiveVolume(sliderVol: number): number {
    const clamped = Math.max(0, Math.min(1, sliderVol));
    return Math.pow(clamped, 2);
  }

  constructor() {
    if (typeof document !== 'undefined') {
      this.audio = document.createElement('audio');
      this.audio.setAttribute('playsinline', 'true');
      this.audio.setAttribute('webkit-playsinline', 'true');
      this.audio.setAttribute('x-webkit-airplay', 'allow');
      this.audio.preload = 'auto';
      this.audio.style.display = 'none';

      if (document.body) {
        document.body.appendChild(this.audio);
      } else {
        window.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(this.audio);
        });
      }
    } else {
      this.audio = new Audio();
    }

    this.audio.volume = this.effectiveVolume(this.volume());

    if (typeof window !== 'undefined') {
      (window as any).recroMediaAction = (action: string) => {
        if (action === 'play') {
          if (this.audio.paused) this.togglePlay();
        } else if (action === 'pause') {
          if (!this.audio.paused) this.togglePlay();
        } else if (action === 'play_pause') {
          this.togglePlay();
        } else if (action === 'next') {
          this.next();
        } else if (action === 'prev') {
          this.prev();
        } else if (action.startsWith('seekto:')) {
          const ms = parseFloat(action.split(':')[1]);
          if (!isNaN(ms)) this.seek(ms / 1000);
        }
      };
    }

    this.setupEventListeners();
    this.setupMediaSession();
  }

  /**
   * Initializes Web Audio API graph:
   * HTMLAudioElement -> MediaElementSourceNode -> DynamicsCompressorNode (Peak Limiting) -> GainNode (Fade) -> Destination
   */
  private initAudioContext() {
    if (this.isAudioGraphReady || typeof window === 'undefined') return;

    // Mobile browsers (Chrome Android / iOS Safari) kill WebAudio graphs on screen lock.
    // Keeping native HTML5 audio output on mobile guarantees the Lock Screen & Notification widget stays active.
    const isMobile = typeof window !== 'undefined' && (
      /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      Boolean(navigator.maxTouchPoints && navigator.maxTouchPoints > 1) ||
      window.innerWidth <= 1024
    );
    if (isMobile) {
      return;
    }

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      this.audioCtx = new AudioCtxClass();
      this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);

      // 1. DynamicsCompressor for peak volume leveling across YouTube, SoundCloud, and Radio
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.compressorNode.threshold.setValueAtTime(-22, this.audioCtx.currentTime);
      this.compressorNode.knee.setValueAtTime(28, this.audioCtx.currentTime);
      this.compressorNode.ratio.setValueAtTime(10, this.audioCtx.currentTime);
      this.compressorNode.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      this.compressorNode.release.setValueAtTime(0.25, this.audioCtx.currentTime);

      // 2. GainNode for smooth crossfades and click-free track transitions
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

      // 3. AnalyserNode for real-time audio visualization
      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.82;

      // Connect graph: Source -> Compressor -> Gain -> Analyser -> Destination
      this.sourceNode.connect(this.compressorNode);
      this.compressorNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioCtx.destination);

      this.isAudioGraphReady = true;
    } catch (err) {
      console.warn('[AudioService] Web Audio API graph not available, using standard HTML5 Audio:', err);
    }
  }

  ensureAudioContext() {
    this.initAudioContext();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  toggleVisualizer() {
    if (this.isVisualizerOpen()) {
      this.closeVisualizer();
    } else {
      this.openVisualizer();
    }
  }

  openVisualizer(pushHistory = true) {
    this.ensureAudioContext();
    this.isVisualizerOpen.set(true);
    if (pushHistory) {
      this.navService.pushOverlay('visualizer');
    }
  }

  closeVisualizer(popHistory = true) {
    this.isVisualizerOpen.set(false);
    if (popHistory) {
      this.navService.closeOverlay('visualizer');
    }
  }

  getAudioFrequencyData(array: Uint8Array): boolean {
    if (!this.analyserNode) return false;
    try {
      this.analyserNode.getByteFrequencyData(array as any);
      return true;
    } catch {
      return false;
    }
  }

  getAudioTimeDomainData(array: Uint8Array): boolean {
    if (!this.analyserNode) return false;
    try {
      this.analyserNode.getByteTimeDomainData(array as any);
      return true;
    } catch {
      return false;
    }
  }

  private applyFadeIn(durationSec = 1.6) {
    if (this.fadeIntervalId) {
      clearInterval(this.fadeIntervalId);
      this.fadeIntervalId = null;
    }

    const isMobile = typeof navigator !== 'undefined' && (
      /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      Boolean(navigator.maxTouchPoints && navigator.maxTouchPoints > 1)
    );

    if (!this.isCrossfadeEnabled() || this.isLiveStream() || isMobile) {
      if (this.gainNode && this.audioCtx) {
        this.gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);
      }
      this.audio.volume = this.effectiveVolume(this.volume());
      return;
    }

    if (this.gainNode && this.audioCtx) {
      try {
        const now = this.audioCtx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(0.02, now);
        this.gainNode.gain.linearRampToValueAtTime(1.0, now + durationSec);
        return;
      } catch {}
    }

    // HTML5 Audio volume fallback for non-web-audio desktop
    const targetVol = this.effectiveVolume(this.volume());
    const startVol = Math.max(0.01, targetVol * 0.05);
    this.audio.volume = startVol;
    const steps = 16;
    const stepTime = Math.max(20, (durationSec * 1000) / steps);
    let currentStep = 0;
    this.fadeIntervalId = setInterval(() => {
      currentStep++;
      if (currentStep >= steps) {
        this.audio.volume = targetVol;
        clearInterval(this.fadeIntervalId);
        this.fadeIntervalId = null;
      } else {
        const factor = currentStep / steps;
        this.audio.volume = startVol + (targetVol - startVol) * factor;
      }
    }, stepTime);
  }

  private applyFadeOut(durationSec = 2.0): Promise<void> {
    return new Promise((resolve) => {
      if (this.fadeIntervalId) {
        clearInterval(this.fadeIntervalId);
        this.fadeIntervalId = null;
      }

      const isMobile = typeof navigator !== 'undefined' && (
        /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        Boolean(navigator.maxTouchPoints && navigator.maxTouchPoints > 1)
      );

      if (!this.isCrossfadeEnabled() || this.isLiveStream() || isMobile) {
        resolve();
        return;
      }

      if (this.gainNode && this.audioCtx) {
        try {
          const now = this.audioCtx.currentTime;
          this.gainNode.gain.cancelScheduledValues(now);
          this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
          this.gainNode.gain.linearRampToValueAtTime(0.02, now + durationSec);
          setTimeout(resolve, durationSec * 1000);
          return;
        } catch {}
      }

      // HTML5 Audio volume fallback for mobile / non-web-audio
      const initialVol = this.audio.volume;
      const steps = 16;
      const stepTime = Math.max(20, (durationSec * 1000) / steps);
      let currentStep = 0;
      this.fadeIntervalId = setInterval(() => {
        currentStep++;
        if (currentStep >= steps) {
          this.audio.volume = 0.02;
          clearInterval(this.fadeIntervalId);
          this.fadeIntervalId = null;
          resolve();
        } else {
          const factor = (steps - currentStep) / steps;
          this.audio.volume = Math.max(0.02, initialVol * factor);
        }
      }, stepTime);
    });
  }

  toggleNormalization() {
    this.isNormalizationEnabled.update((v) => !v);
    if (!this.sourceNode || !this.gainNode || !this.audioCtx) return;

    try {
      this.sourceNode.disconnect();
      if (this.compressorNode) this.compressorNode.disconnect();

      if (this.isNormalizationEnabled() && this.compressorNode) {
        this.sourceNode.connect(this.compressorNode);
        this.compressorNode.connect(this.gainNode);
      } else {
        this.sourceNode.connect(this.gainNode);
      }
    } catch {}
  }

  toggleCrossfade() {
    this.isCrossfadeEnabled.update((v) => !v);
  }

  private setupEventListeners() {
    this.audio.addEventListener('timeupdate', () => {
      if (!this.hasAudioStartedPlaying) return;
      const actual = this.streamSeekOffset() + this.audio.currentTime;
      this.currentTime.set(actual);

      const total = this.duration();
      // Smooth fade-out 2.5s before end of track
      if (total > 3 && actual >= total - 2.5 && !this.isFadingOut && !this.isHandlingEnd && this.isCrossfadeEnabled()) {
        this.isFadingOut = true;
        this.applyFadeOut(2.2);
      }

      // Record track completion at 80% of playback
      const cur = this.currentTrack();
      if (cur && total > 10 && actual >= total * 0.8 && !this.hasRecordedCompletion) {
        this.hasRecordedCompletion = true;
        this.recService.recordTrackCompletion(cur);
      }

      // Proactively ensure smart queue buffer before current track ends.
      // Debounced to 6s to avoid spamming ensureSmartQueue on every timeupdate tick.
      const now = Date.now();
      const remainingAhead = this.queue().length - 1 - this.queueIndex();
      if (
        this.recService.isMixActive() &&
        (remainingAhead <= 2 || (total > 15 && actual >= total - 12)) &&
        now - this.lastQueueEnsureTime > 6000
      ) {
        this.lastQueueEnsureTime = now;
        this.ensureSmartQueue();
      }

      // Preload next track audio stream in advance so transition is instantaneous
      if (actual >= 4 && !this.hasPreloadedNextTrack) {
        this.hasPreloadedNextTrack = true;
        this.preloadNextTrack();
      }
    });

    this.audio.addEventListener('loadedmetadata', () => {
      const d = this.audio.duration;
      const trackDur = this.currentTrack()?.duration;
      if (trackDur && trackDur > 0) {
        this.duration.set(trackDur);
      } else if (this.streamSeekOffset() > 0 && d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(this.streamSeekOffset() + d);
      } else if (d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(d);
      }
      this.updateMediaSessionPosition();
      this.notifyNativeBridge(this.currentTrack(), this.isPlaying());
    });

    this.audio.addEventListener('durationchange', () => {
      const d = this.audio.duration;
      const trackDur = this.currentTrack()?.duration;
      if (trackDur && trackDur > 0) {
        this.duration.set(trackDur);
      } else if (this.streamSeekOffset() > 0 && d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(this.streamSeekOffset() + d);
      } else if (d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(d);
      }
      this.updateMediaSessionPosition();
      this.notifyNativeBridge(this.currentTrack(), this.isPlaying());
    });

    this.audio.addEventListener('play', () => {
      this.isPlaying.set(true);
      this.updateMediaSessionPlaybackState('playing');
      const cur = this.currentTrack();
      if (cur) this.updateMediaSessionMetadata(cur);
      this.updateMediaSessionPosition();
    });

    this.audio.addEventListener('playing', () => {
      this.isSwitchingTrack = false;
      this.hasAudioStartedPlaying = true;
      this.consecutiveErrorCount = 0;
      this.isPlaying.set(true);
      this.updateMediaSessionPlaybackState('playing');
      const cur = this.currentTrack();
      if (cur) this.updateMediaSessionMetadata(cur);
      this.updateMediaSessionPosition();
      this.requestWakeLock();
    });

    this.audio.addEventListener('pause', () => {
      // If we are simply rebuffering, handling end, or switching tracks, ignore pause event
      if (!this.isHandlingEnd && !this.isSwitchingTrack) {
        this.isPlaying.set(false);
        this.updateMediaSessionPlaybackState('paused');
        this.updateMediaSessionPosition();
        this.releaseWakeLock();
      }
    });

    this.audio.addEventListener('waiting', () => {
      // NOTE: Do NOT set playbackState = 'paused' on waiting!
      // Mobile Chrome drops the notification shade card if set to paused while buffering.
    });

    this.audio.addEventListener('ended', () => {
      if (this.isLiveStream()) {
        console.warn('[AudioService] Live stream ended event, attempting reconnect in 2s');
        this.handlePlaybackFailure('live_stream_ended');
        return;
      }
      // Проверяем реальное время воспроизведения через нативный audio элемент
      const played = this.audio.currentTime || 0;
      const dur = this.audio.duration || this.duration();
      if (this.streamSeekOffset() === 0 && ((!this.hasAudioStartedPlaying && played < 1.0) || (dur > 5 && played < 1.5))) {
        console.warn('[AudioService] Premature ended event (<1.5s played), treating as playback failure');
        this.handlePlaybackFailure('premature_ended');
        return;
      }
      this.handleTrackEnded();
    });

    this.audio.addEventListener('error', (e) => {
      console.warn('[AudioService] Audio element error:', e);
      const cur = this.currentTrack();
      if (cur && this.audio.src.startsWith('blob:')) {
        console.warn('[AudioService] Audio element failed on blob, falling back to online stream');
        this.offlineService.removeTrackOffline(cur.id).catch(() => {});
        this.libraryService.updateTrackOfflineStatus(cur.id, false);
        this.playTrack({ ...cur, isOffline: false });
        return;
      }
      this.handlePlaybackFailure('native_error');
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.isPlaying()) {
          this.requestWakeLock();
          this.updateMediaSessionPosition();
        }
      });
    }
  }

  private handlePlaybackFailure(source: string) {
    console.warn(`[AudioService] Playback failure from ${source}`);
    this.hasAudioStartedPlaying = false;

    if (this.errorTimeoutId) {
      clearTimeout(this.errorTimeoutId);
      this.errorTimeoutId = null;
    }

    if (this.isLiveStream()) {
      const cur = this.currentTrack();
      if (cur && this.audio.src && this.audio.src.includes('/api/stream') && cur.audioUrl.startsWith('https://')) {
        console.warn('[AudioService] Proxied stream failed, trying direct HTTPS stream URL fallback');
        this.audio.removeAttribute('crossorigin');
        this.audio.src = cur.audioUrl;
        this.audio.play().catch(() => {});
        return;
      }

      console.warn('[AudioService] Live stream error/interrupted, attempting reconnect in 2s');
      this.errorTimeoutId = setTimeout(() => {
        const current = this.currentTrack();
        if (current && this.isLiveStream()) {
          this.playTrack(current, this.queue(), false, this.queueIndex());
        }
      }, 2000);
      return;
    }

    // Если воспроизведение идет из обычной очереди (альбом, плейлист, оффлайн)
    if (!this.recService.isMixActive()) {
      const q = this.queue();
      const nextIdx = this.queueIndex() + 1;
      if (nextIdx < q.length || this.repeatMode() === 'all') {
        this.consecutiveErrorCount++;
        if (this.consecutiveErrorCount <= 3) {
          console.warn('[AudioService] Track error in queue, auto-advancing to next track in 1.2s');
          this.errorTimeoutId = setTimeout(() => {
            this.next(true);
          }, 1200);
          return;
        }
      }
      this.isPlaying.set(false);
      this.updateMediaSessionPlaybackState('paused');
      this.consecutiveErrorCount = 0;
      this.releaseWakeLock();
      return;
    }

    this.consecutiveErrorCount++;

    if (this.recService.isMixActive()) {
      if (this.consecutiveErrorCount === 1) {
        console.warn('[AudioService] First transient failure in mix, retrying track once before skipping...');
        this.errorTimeoutId = setTimeout(() => {
          const cur = this.currentTrack();
          if (cur && this.recService.isMixActive()) {
            this.playTrack(cur, undefined, true);
          }
        }, 1000);
        return;
      }

      if (this.consecutiveErrorCount <= 3) {
        this.errorTimeoutId = setTimeout(() => {
          if (this.recService.isMixActive()) {
            this.next();
          }
        }, 1500);
      } else {
        console.warn('[AudioService] Multiple playback failures in mix, attempting recovery with reliable local track');
        this.consecutiveErrorCount = 0;
        const locals = this.recService.getAllLocalCandidates();
        if (locals.length > 0) {
          const rescueTrack = locals[Math.floor(Math.random() * locals.length)];
          this.playTrack(rescueTrack, undefined, true);
        } else {
          this.errorTimeoutId = setTimeout(() => {
            if (this.recService.isMixActive()) {
              this.next();
            }
          }, 1500);
        }
      }
      return;
    }
  }

  private setupMediaSession() {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    const setAction = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    };

    setAction('play', () => {
      if (this.audio.paused) {
        this.togglePlay();
      }
    });

    setAction('pause', () => {
      if (!this.audio.paused) {
        this.togglePlay();
      }
    });

    setAction('previoustrack', () => {
      this.prev();
    });

    setAction('nexttrack', () => {
      this.next();
    });

    setAction('seekto', (details) => {
      if (details.seekTime !== undefined && details.seekTime !== null) {
        this.seek(details.seekTime);
      }
    });

    setAction('seekbackward', (details) => {
      this.skipBy(-(details.seekOffset || 10));
    });

    setAction('seekforward', (details) => {
      this.skipBy(details.seekOffset || 10);
    });

    setAction('stop', () => {
      this.audio.pause();
      this.isPlaying.set(false);
      this.updateMediaSessionPlaybackState('none');
    });
  }

  private notifyNativeBridge(track: Track | null, isPlaying: boolean) {
    if (typeof window === 'undefined') return;
    const bridge = (window as any).AndroidMediaBridge;
    if (!bridge) return;
    try {
      if (!track) {
        bridge.clearMediaSession();
        return;
      }
      const title = track.title || 'Recro Track';
      const artist = track.artist || 'Recro';
      const origin = window.location.origin;
      const activeBase = this.libraryService.getBackendUrl();
      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

      const getFullUrl = (url?: string | null) => {
        if (!url) return `${origin}/icons/icon-512.png`;
        if (isHttps && url.startsWith('http://')) {
          return `${activeBase}/api/cover?url=${encodeURIComponent(url)}`;
        }
        if (url.startsWith('https://') || url.startsWith('http://')) return url;
        if (url.startsWith('/api/')) return `${activeBase}${url}`;
        return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
      };

      const coverUrl = getFullUrl(track.coverUrl);
      const posMs = Math.round((this.currentTime() || 0) * 1000);
      const durMs = Math.round((this.duration() || 0) * 1000);
      bridge.updateMediaSession(title, artist, coverUrl, isPlaying, posMs, durMs);
    } catch (e) {
      console.warn('[AudioService] AndroidMediaBridge error:', e);
    }
  }

  private updateMediaSessionPlaybackState(state: 'playing' | 'paused' | 'none') {
    if (typeof window !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = state;
      } catch {}
    }
    this.notifyNativeBridge(this.currentTrack(), state === 'playing');
  }

  private updateMediaSessionMetadata(track: Track) {
    this.notifyNativeBridge(track, this.isPlaying());
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;

    try {
      const origin = window.location.origin;
      const activeBase = this.libraryService.getBackendUrl();
      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

      const getFullUrl = (url?: string | null) => {
        if (!url) return `${origin}/icons/icon-512.png`;
        if (isHttps && url.startsWith('http://')) {
          return `${activeBase}/api/cover?url=${encodeURIComponent(url)}`;
        }
        if (url.startsWith('https://')) return url;
        if (url.startsWith('http://')) return url;
        if (url.startsWith('/api/')) return `${activeBase}${url}`;
        return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
      };

      const cover = getFullUrl(track.coverUrl);
      const artwork: MediaImage[] = [
        { src: cover, sizes: '96x96' },
        { src: cover, sizes: '128x128' },
        { src: cover, sizes: '192x192' },
        { src: cover, sizes: '256x256' },
        { src: cover, sizes: '384x384' },
        { src: cover, sizes: '512x512' },
        { src: `${origin}/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${origin}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
      ];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Recro Track',
        artist: track.artist || 'Recro',
        album: track.album || 'Recro Stream',
        artwork: artwork,
      });
    } catch {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'Recro Track',
          artist: track.artist || 'Recro',
          album: 'Recro Stream',
        });
      } catch {}
    }
  }

  private updateMediaSessionPosition() {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;
    if (!('setPositionState' in navigator.mediaSession)) return;

    const d = this.duration();
    if (!d || d <= 0 || !isFinite(d) || this.isLiveStream()) {
      try {
        (navigator.mediaSession as any).setPositionState(null);
      } catch {
        try {
          (navigator.mediaSession as any).setPositionState();
        } catch {}
      }
      return;
    }

    try {
      const safeDuration = Math.max(0.1, d);
      const pos = Math.max(0, Math.min(this.currentTime(), Math.max(0, safeDuration - 0.05)));
      navigator.mediaSession.setPositionState({
        duration: safeDuration,
        playbackRate: Math.max(0.1, this.audio.playbackRate || 1),
        position: pos,
      });
    } catch {}
  }

  private canUseCrossOrigin(url: string): boolean {
    if (!url || typeof window === 'undefined') return false;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) return false;
    if (url.startsWith('blob:')) return true;

    if (url.startsWith('/') || url.startsWith(window.location.origin) || url.includes('/api/stream')) {
      return true;
    }
    const backendUrl = this.libraryService.getBackendUrl();
    if (backendUrl && url.startsWith(backendUrl)) {
      return true;
    }
    return false;
  }

  async playTrack(track: Track, newQueue?: Track[], fromMix: boolean = false, queueIndex?: number) {
    if (!track) {
      console.warn('[AudioService] playTrack called with null/undefined track');
      if (this.recService.isMixActive()) {
        const fallbacks = this.recService.pickNextTracks(3, new Set(), this.currentTrack() || null);
        if (fallbacks.length > 0) {
          this.playTrack(fallbacks[0], undefined, true);
        }
      }
      return;
    }

    const playRequestId = ++this.currentPlayRequestId;

    if (this.errorTimeoutId) {
      clearTimeout(this.errorTimeoutId);
      this.errorTimeoutId = null;
    }

    // Only deactivate mix if user explicitly started playing from a different context (new external queue),
    // NOT when navigating or clicking within the active mix queue
    if (!fromMix && newQueue !== undefined) {
      this.recService.isMixActive.set(false);
      this.consecutiveErrorCount = 0;
    }

    // 1. Initialize Web Audio API on user gesture (non-blocking)
    this.initAudioContext();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    this.isFadingOut = false;
    this.hasAudioStartedPlaying = false;
    this.isSwitchingTrack = true;

    if (newQueue && newQueue.length > 0) {
      this.queue.set([...newQueue]);
      if (queueIndex !== undefined && queueIndex >= 0 && queueIndex < newQueue.length) {
        this.queueIndex.set(queueIndex);
      } else {
        const idx = newQueue.findIndex((t) => t.id === track.id);
        this.queueIndex.set(idx >= 0 ? idx : 0);
      }
    } else {
      const currentQueue = this.queue();
      if (queueIndex !== undefined && queueIndex >= 0 && queueIndex < currentQueue.length) {
        this.queueIndex.set(queueIndex);
      } else {
        const idx = currentQueue.findIndex((t) => t.id === track.id);
        if (idx === -1) {
          this.queue.set([...currentQueue, track]);
          this.queueIndex.set(this.queue().length - 1);
        } else {
          this.queueIndex.set(idx);
        }
      }
    }

    const isFav = this.libraryService.isTrackFavorite(track);
    this.currentTrack.set({ ...track, isFavorite: isFav });
    this.recService.recordTrackStarted(track);
    this.streamSeekOffset.set(0);
    this.currentTime.set(0);
    this.hasAudioStartedPlaying = false;
    this.hasRecordedCompletion = false;
    this.hasPreloadedNextTrack = false;

    const initialDuration = track.duration && track.duration > 0 ? track.duration : 0;
    this.duration.set(initialDuration);

    this.updateMediaSessionMetadata(track);
    this.updateMediaSessionPlaybackState('playing');

    // 1. Быстрый синхронный запуск из памяти (сохраняет жест пользователя для системной шторки Android/iOS)
    let playUrl = track.audioUrl;
    const cachedBlobUrl = this.offlineService.getCachedBlobUrlSync(track.id);
    if (cachedBlobUrl) {
      playUrl = cachedBlobUrl;
    } else if (this.offlineService.isTrackOffline(track.id)) {
      this.offlineService.getOfflineBlobUrl(track.id).then((resolvedUrl) => {
        if (resolvedUrl && this.currentTrack()?.id === track.id && playRequestId === this.currentPlayRequestId) {
          if (this.audio.src !== resolvedUrl) {
            const curPos = this.audio.currentTime;
            this.audio.src = resolvedUrl;
            this.audio.currentTime = curPos;
            this.audio.play().catch(() => {});
          }
        }
      }).catch(() => {});
    }

    if (playUrl && (playUrl.includes(':8052') || playUrl.includes('ep256.hostingradio.ru') || playUrl.includes('europaplus256.mp3'))) {
      const lower = (track.title || '').toLowerCase();
      playUrl = (lower.includes('top 40') || track.id.includes('default-2') || playUrl.includes('top'))
        ? 'https://europaplus.hostingradio.ru:8014/ep-top256.mp3'
        : 'https://ep128server.streamr.ru:8030/ep128';
    }

    // Discard stale request if a newer track was requested
    if (playRequestId !== this.currentPlayRequestId) {
      return;
    }

    const activeBase = this.libraryService.getBackendUrl();

    if (!playUrl.startsWith('blob:')) {
      if (playUrl.startsWith('/api/stream')) {
        playUrl = `${activeBase}${playUrl}`;
      } else if (playUrl.includes('/api/stream')) {
        const streamIdx = playUrl.indexOf('/api/stream');
        playUrl = `${activeBase}${playUrl.slice(streamIdx)}`;
      } else if (
        playUrl.includes('youtube.com') ||
        playUrl.includes('youtu.be') ||
        playUrl.includes('soundcloud.com')
      ) {
        playUrl = `${activeBase}/api/stream?url=${encodeURIComponent(playUrl)}`;
      } else if (
        track.isLiveStream ||
        track.format === 'stream' ||
        (typeof window !== 'undefined' && window.location.protocol === 'https:' && playUrl.startsWith('http://'))
      ) {
        playUrl = `${activeBase}/api/stream?url=${encodeURIComponent(playUrl)}&is_live=true`;
      }

      if (playUrl.includes('/api/stream')) {
        if (track.isLiveStream && !playUrl.includes('is_live=')) {
          const glue = playUrl.includes('?') ? '&' : '?';
          playUrl = `${playUrl}${glue}is_live=true`;
        }
        if (!playUrl.includes('title=') && track.title) {
          const glue = playUrl.includes('?') ? '&' : '?';
          playUrl = `${playUrl}${glue}title=${encodeURIComponent(track.title)}`;
        }
        if (!playUrl.includes('artist=') && track.artist) {
          const glue = playUrl.includes('?') ? '&' : '?';
          playUrl = `${playUrl}${glue}artist=${encodeURIComponent(track.artist)}`;
        }
      }
    }

    if (this.canUseCrossOrigin(playUrl)) {
      this.audio.crossOrigin = 'anonymous';
    } else {
      this.audio.removeAttribute('crossorigin');
    }

    // Отзываем blob URL только ПРЕДЫДУЩИХ треков, не задевая текущий
    this.offlineService.revokePreviousBlobUrls(track.id);

    // При повторе или перезапуске того же стрима форсируем обновление, сбрасывая позицию и кэш
    const isSameSrc = this.audio.src === playUrl || (
      playUrl.includes('/api/stream') &&
      this.audio.src.includes('/api/stream') &&
      this.audio.src.split('&_t=')[0] === playUrl.split('&_t=')[0]
    );

    if (isSameSrc && playUrl.includes('/api/stream')) {
      const glue = playUrl.includes('?') ? '&' : '?';
      playUrl = `${playUrl.split('&_t=')[0]}${glue}_t=${Date.now()}`;
    }

    try {
      this.audio.currentTime = 0;
    } catch {}

    this.audio.src = playUrl;
    if (isSameSrc) {
      try {
        this.audio.load();
      } catch {}
    }

    // Apply smooth fade in
    this.applyFadeIn(1.0);

    this.audio
      .play()
      .then(() => {
        this.isSwitchingTrack = false;
        if (playRequestId !== this.currentPlayRequestId) return;
        this.hasAudioStartedPlaying = true;
        this.isPlaying.set(true);
        this.updateMediaSessionPlaybackState('playing');
        this.updateMediaSessionMetadata(track);
        this.updateMediaSessionPosition();
        this.libraryService.recordHistoryPlay(track);
        this.requestWakeLock();
      })
      .catch(async (err) => {
        this.isSwitchingTrack = false;
        // If this request was superseded by a newer track, do absolutely nothing
        if (playRequestId !== this.currentPlayRequestId) {
          return;
        }
        // Interrupted by rapid navigation or browser load: do NOT set isPlaying(false)
        if (err && (err.name === 'AbortError' || err.code === 20)) {
          return;
        }
        if (err && err.name === 'NotAllowedError') {
          this.isPlaying.set(false);
          this.updateMediaSessionPlaybackState('paused');
          return;
        }

        // Если попытка воспроизведения сорвалась на оффлайн blob URL: моментальный откат на сетевой поток!
        if (playUrl.startsWith('blob:')) {
          console.warn('[AudioService] Offline blob playback failed, falling back to online stream:', err);
          await this.offlineService.removeTrackOffline(track.id);
          this.libraryService.updateTrackOfflineStatus(track.id, false);
          this.playTrack({ ...track, isOffline: false }, undefined, fromMix, queueIndex);
          return;
        }

        console.warn('[AudioService] play() error:', err);
        this.handlePlaybackFailure('play_rejection');
      });
  }

  togglePlay() {
    if (!this.currentTrack()) {
      const q = this.queue();
      if (q.length > 0) {
        this.playTrack(q[0]);
      }
      return;
    }

    this.ensureAudioContext();

    const cur = this.currentTrack();
    if (!cur) return;

    if (this.audio.paused) {
      const isEnded = this.audio.ended || (this.duration() > 2 && this.currentTime() >= this.duration() - 0.5);
      if (isEnded) {
        this.playTrack(cur, undefined, this.recService.isMixActive(), this.queueIndex());
        return;
      }

      this.updateMediaSessionMetadata(cur);
      this.updateMediaSessionPlaybackState('playing');
      this.applyFadeIn(0.5);
      this.audio
        .play()
        .then(() => {
          this.isPlaying.set(true);
          this.updateMediaSessionPlaybackState('playing');
          this.updateMediaSessionPosition();
        })
        .catch(() => {
          this.isPlaying.set(false);
          this.updateMediaSessionPlaybackState('paused');
        });
    } else {
      this.audio.pause();
      this.isPlaying.set(false);
      this.updateMediaSessionPlaybackState('paused');
    }
  }

  play() {
    if (this.audio.paused) {
      this.togglePlay();
    }
  }

  pause() {
    if (!this.audio.paused) {
      this.togglePlay();
    }
  }

  stopPlayback() {
    this.notifyNativeBridge(null, false);
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.src = '';
    } catch {}
    this.isPlaying.set(false);
    this.currentTrack.set(null);
    this.queue.set([]);
    this.queueIndex.set(-1);
    this.currentTime.set(0);
    this.duration.set(0);
    this.isReplenishingQueue = false;
    this.recService.isMixActive.set(false);
    this.updateMediaSessionPlaybackState('none');
  }

  resetSessionAudio() {
    this.stopPlayback();
    this.recService.resetMixSession();
  }

  seek(seconds: number) {
    if (this.isLiveStream()) return;
    const total = this.duration() || this.currentTrack()?.duration || 0;
    const clamped = Math.max(0, Math.min(seconds, total > 0 ? total : seconds));

    const track = this.currentTrack();
    if (!track) return;

    // 1. If audio is playing from a local blob URL or direct static audio, seek natively without restarting stream
    if (this.audio.src.startsWith('blob:') || !this.audio.src.includes('/api/stream')) {
      try {
        this.audio.currentTime = clamped;
        this.currentTime.set(clamped);
        this.updateMediaSessionPosition();
        this.notifyNativeBridge(track, this.isPlaying());
      } catch {}
      return;
    }

    // 2. Fast In-Buffer Native Seeking:
    // If target position is within the buffered ranges of the currently loaded audio, seek instantly without network request!
    const currentOffset = this.streamSeekOffset();
    const relTime = clamped - currentOffset;
    if (relTime >= 0 && this.audio.buffered && this.audio.buffered.length > 0) {
      let isBuffered = false;
      for (let i = 0; i < this.audio.buffered.length; i++) {
        if (relTime >= this.audio.buffered.start(i) && relTime <= this.audio.buffered.end(i)) {
          isBuffered = true;
          break;
        }
      }
      if (isBuffered) {
        try {
          this.audio.currentTime = relTime;
          this.currentTime.set(clamped);
          this.updateMediaSessionPosition();
          this.notifyNativeBridge(track, this.isPlaying());
          return;
        } catch {}
      }
    }

    // 3. Fast Stream Range Seek via backend with ss parameter:
    const activeBase = this.libraryService.getBackendUrl();
    let baseStreamUrl: string;

    if (track.audioUrl.includes('/api/stream')) {
      const streamIdx = track.audioUrl.indexOf('/api/stream');
      baseStreamUrl = `${activeBase}${track.audioUrl.slice(streamIdx)}`.split('&ss=')[0];
    } else if (
      track.audioUrl.includes('youtube.com') ||
      track.audioUrl.includes('youtu.be') ||
      track.audioUrl.includes('soundcloud.com')
    ) {
      baseStreamUrl = `${activeBase}/api/stream?url=${encodeURIComponent(track.audioUrl)}`;
    } else if (track.audioUrl.startsWith('/api/')) {
      baseStreamUrl = `${activeBase}${track.audioUrl}`.split('&ss=')[0];
    } else {
      baseStreamUrl = track.audioUrl.split('&ss=')[0];
    }

    if (!baseStreamUrl.includes('title=') && track.title) {
      const glue = baseStreamUrl.includes('?') ? '&' : '?';
      baseStreamUrl = `${baseStreamUrl}${glue}title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist || '')}`;
    }

    baseStreamUrl = baseStreamUrl.split('&_t=')[0];
    const ssParam = clamped > 0 ? `&ss=${Math.round(clamped)}` : '';
    const tsParam = `&_t=${Date.now()}`;
    const newUrl = `${baseStreamUrl}${ssParam}${tsParam}`;

    this.streamSeekOffset.set(clamped);
    this.currentTime.set(clamped);
    if (total > 0) {
      this.duration.set(total);
    }

    if (this.canUseCrossOrigin(newUrl)) {
      this.audio.crossOrigin = 'anonymous';
    } else {
      this.audio.removeAttribute('crossorigin');
    }

    this.audio.src = newUrl;
    try {
      this.audio.load();
    } catch {}
    this.audio
      .play()
      .then(() => {
        this.isPlaying.set(true);
        this.updateMediaSessionPlaybackState('playing');
        this.updateMediaSessionPosition();
      })
      .catch(() => {});
  }

  seekPercent(percent: number) {
    if (this.isLiveStream()) return;
    const total = this.duration() || this.currentTrack()?.duration || 0;
    if (total > 0 && isFinite(total)) {
      const target = (Math.max(0, Math.min(percent, 100)) / 100) * total;
      this.seek(target);
    }
  }

  skipBy(seconds: number) {
    if (this.isLiveStream()) return;
    this.seek(this.currentTime() + seconds);
  }

  async next(immediate: boolean = false) {
    if (this.isSwitchingTrack) return;
    this.isSwitchingTrack = true;

    try {
      const q = this.queue();
      if (q.length === 0) return;

      const cur = this.currentTrack();
      if (cur && this.currentTime() < 15 && !this.isLiveStream()) {
        this.recService.recordTrackSkip(cur);
      }

      let nextIdx = this.queueIndex() + 1;
      if (this.isShuffle() && !this.recService.isMixActive()) {
        nextIdx = Math.floor(Math.random() * q.length);
      }

      if (this.recService.isMixActive()) {
        // Proactively ensure queue has enough upcoming buffer
        if (nextIdx >= this.queue().length - 3) {
          this.ensureSmartQueue();
        }

        let updatedQ = this.queue();
        if (nextIdx >= updatedQ.length) {
          // Instant synchronous replenishment so mix never starves or halts
          const recentQueue = updatedQ.slice(Math.max(0, updatedQ.length - 15));
          const excludeIds = new Set<string>(recentQueue.map((t) => t.id));
          const recentArtists = new Set<string>(recentQueue.slice(-4).map((t) => t.artist).filter(Boolean));
          const fallbacks = this.recService.pickNextTracks(4, excludeIds, this.currentTrack() || null, recentArtists);
          if (fallbacks.length > 0) {
            this.queue.update((curQ) => [...curQ, ...fallbacks]);
          } else {
            const nonDisliked = updatedQ.filter((t) => !this.recService.isDisliked(t.id));
            if (nonDisliked.length > 0) {
              this.queue.update((curQ) => [
                ...curQ,
                ...nonDisliked.map((t) => ({ ...t, id: `${t.id}_r_${Date.now()}_${Math.random()}` })),
              ]);
            }
          }
          updatedQ = this.queue();
        }

        if (nextIdx >= updatedQ.length) {
          nextIdx = 0;
        }
      } else {
        if (nextIdx >= q.length) {
          if (this.repeatMode() === 'all') {
            nextIdx = 0;
          } else {
            this.isPlaying.set(false);
            this.updateMediaSessionPlaybackState('paused');
            return;
          }
        }
      }

      // Micro-fade перед сменой трека только при ручном переключении на десктопе (на мобилках смена мгновенная без потери фокуса шторки)
      const isMobileDevice = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!immediate && !isMobileDevice) {
        await this.applyFadeOut(0.12);
      }

      // Queue housekeeping: prevent memory bloat during infinite mix sessions (hours of listening)
      // Keep last 5 played tracks for 'previous' while trimming older history
      if (this.recService.isMixActive() && nextIdx > 20) {
        const trimCount = nextIdx - 5;
        this.queue.update((curQ) => curQ.slice(trimCount));
        nextIdx = 5;
      }

      const targetTrack = this.queue()[nextIdx];
      if (targetTrack) {
        this.queueIndex.set(nextIdx);
        await this.playTrack(targetTrack, undefined, this.recService.isMixActive(), nextIdx);
      }

      if (this.recService.isMixActive()) {
        this.ensureSmartQueue();
      }
    } finally {
      this.isSwitchingTrack = false;
    }
  }

  async prev() {
    if (this.currentTime() > 3) {
      this.seek(0);
      return;
    }

    if (this.isSwitchingTrack) return;
    this.isSwitchingTrack = true;

    try {
      const q = this.queue();
      if (q.length === 0) return;

      let prevIdx = this.queueIndex() - 1;
      if (prevIdx < 0) {
        prevIdx = q.length - 1;
      }

      // Micro-fade before changing track on desktop
      const isMobileDevice = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (!isMobileDevice) {
        await this.applyFadeOut(0.12);
      }

      const targetTrack = q[prevIdx];
      if (targetTrack) {
        this.queueIndex.set(prevIdx);
        await this.playTrack(targetTrack, undefined, this.recService.isMixActive(), prevIdx);
      }
    } finally {
      this.isSwitchingTrack = false;
    }
  }

  private handleTrackEnded() {
    if (this.isHandlingEnd) return;
    this.isHandlingEnd = true;
    setTimeout(() => {
      this.isHandlingEnd = false;
      this.isFadingOut = false;
    }, 1000);

    if (this.repeatMode() === 'one') {
      const cur = this.currentTrack();
      if (cur) {
        this.playTrack(cur, undefined, this.recService.isMixActive(), this.queueIndex()).catch(() => {});
      } else {
        this.seek(0);
        this.audio.play().catch(() => {});
      }
    } else {
      this.next(true);
    }
  }

  setVolume(vol: number) {
    if (this.fadeIntervalId) {
      clearInterval(this.fadeIntervalId);
      this.fadeIntervalId = null;
    }
    const clamped = Math.max(0, Math.min(1, vol));
    this.volume.set(clamped);
    this.audio.volume = this.isMuted() ? 0 : this.effectiveVolume(clamped);
    if (clamped > 0 && this.isMuted()) {
      this.isMuted.set(false);
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.STORAGE_KEY_VOLUME, clamped.toFixed(3));
      }
    } catch {}
  }

  toggleMute() {
    if (this.isMuted()) {
      this.audio.volume = this.effectiveVolume(this.volume());
      this.isMuted.set(false);
    } else {
      this.audio.volume = 0;
      this.isMuted.set(true);
    }
  }

  toggleShuffle() {
    this.isShuffle.update((v) => !v);
  }

  cycleRepeat() {
    const modes: ('off' | 'all' | 'one')[] = ['all', 'one', 'off'];
    const current = this.repeatMode();
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    this.repeatMode.set(next);
  }

  addToQueue(track: Track) {
    this.queue.update((q) => [...q, track]);
    if (!this.currentTrack()) {
      this.playTrack(track);
    }
  }

  playNext(track: Track) {
    const curIdx = this.queueIndex();
    const currentQ = this.queue();
    if (curIdx >= 0 && curIdx < currentQ.length) {
      const nextQ = [...currentQ];
      nextQ.splice(curIdx + 1, 0, track);
      this.queue.set(nextQ);
    } else {
      this.addToQueue(track);
    }
  }

  removeFromQueue(index: number) {
    this.queue.update((q) => q.filter((_, i) => i !== index));
    if (index === this.queueIndex()) {
      this.next();
    } else if (index < this.queueIndex()) {
      this.queueIndex.update((idx) => idx - 1);
    }
  }

  moveQueueItem(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const q = [...this.queue()];
    if (fromIndex < 0 || fromIndex >= q.length || toIndex < 0 || toIndex >= q.length) return;
    const [moved] = q.splice(fromIndex, 1);
    q.splice(toIndex, 0, moved);

    const curIdx = this.queueIndex();
    let newCurIdx = curIdx;
    if (curIdx === fromIndex) {
      newCurIdx = toIndex;
    } else if (fromIndex < curIdx && toIndex >= curIdx) {
      newCurIdx = curIdx - 1;
    } else if (fromIndex > curIdx && toIndex <= curIdx) {
      newCurIdx = curIdx + 1;
    }

    this.queue.set(q);
    this.queueIndex.set(newCurIdx);
  }

  clearQueue() {
    this.queue.set(this.currentTrack() ? [this.currentTrack()!] : []);
    this.queueIndex.set(0);
  }

  preloadNextTrack() {
    const q = this.queue();
    const idx = this.queueIndex();
    if (idx < 0 || idx >= q.length - 1) return;
    const nextTrack = q[idx + 1];
    if (!nextTrack || !nextTrack.audioUrl || nextTrack.id === this.lastPreloadedTrackId) return;
    this.lastPreloadedTrackId = nextTrack.id;
    this.preloadedNextTrack.set(nextTrack);

    // Для оффлайн-трека: заранее подготавливаем и кэшируем Blob URL в памяти
    if (this.offlineService.isTrackOffline(nextTrack.id)) {
      this.offlineService.getOfflineBlobUrl(nextTrack.id).catch(() => {});
      return;
    }

    if (nextTrack.audioUrl.startsWith('blob:') || nextTrack.isLiveStream) return;

    let targetUrl = nextTrack.audioUrl;
    const activeBase = this.libraryService.getBackendUrl();

    if (targetUrl.startsWith('/api/stream')) {
      targetUrl = `${activeBase}${targetUrl}`;
    } else if (targetUrl.includes('/api/stream')) {
      const sIdx = targetUrl.indexOf('/api/stream');
      targetUrl = `${activeBase}${targetUrl.slice(sIdx)}`;
    } else if (
      targetUrl.includes('youtube.com') ||
      targetUrl.includes('youtu.be') ||
      targetUrl.includes('soundcloud.com')
    ) {
      targetUrl = `${activeBase}/api/stream?url=${encodeURIComponent(targetUrl)}`;
    }

    if (targetUrl.includes('/api/stream')) {
      if (!targetUrl.includes('title=') && nextTrack.title) {
        const glue = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${glue}title=${encodeURIComponent(nextTrack.title)}`;
      }
      if (!targetUrl.includes('artist=') && nextTrack.artist) {
        const glue = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${glue}artist=${encodeURIComponent(nextTrack.artist)}`;
      }
      this.lastPreloadedTrackId = nextTrack.id;
      const glue = targetUrl.includes('?') ? '&' : '?';
      const prefetchUrl = `${targetUrl}${glue}prefetch=true`;
      try {
        // High priority + без cache: 'no-store' — браузер прогревает соединение и кэширует ответ бэкенда.
        // Это гарантирует что следующий трек стартует мгновенно, а не ждёт yt-dlp при переключении.
        fetch(prefetchUrl, { priority: 'high' as any }).catch(() => {});
      } catch {}
    }
  }

  async ensureSmartQueue(): Promise<void> {
    if (!this.recService.isMixActive()) return;

    if (this.replenishingPromise) {
      return this.replenishingPromise;
    }

    this.replenishingPromise = this.doEnsureSmartQueue();
    try {
      await this.replenishingPromise;
    } finally {
      this.replenishingPromise = null;
    }
  }

  private async doEnsureSmartQueue(): Promise<void> {
    const q = this.queue();
    const idx = this.queueIndex();

    // Check how many upcoming tracks are queued ahead of current
    const upcomingCount = Math.max(0, q.length - 1 - idx);
    // Keep a buffer of upcoming tracks, don't spam requests when we already have >= 3 upcoming tracks!
    if (upcomingCount >= 3) return;

    const needed = Math.max(3, 5 - upcomingCount);

    // Exclude unplayed upcoming tracks AND recently played tracks from this session queue
    const unplayedUpcoming = q.slice(Math.max(0, idx));
    const recentPlayedFromQueue = q.slice(Math.max(0, idx - 15), idx);
    const excludeIds = new Set<string>([
      ...unplayedUpcoming.map((t) => t.id),
      ...recentPlayedFromQueue.map((t) => t.id),
    ]);

    // Build context artists from current surroundings in queue
    const contextSlice = q.slice(Math.max(0, idx - 4), Math.min(q.length, idx + 4));
    const recentArtists = new Set<string>(contextSlice.map((t) => t.artist).filter(Boolean));

    const source = this.recService.mixConfig().source;
    const localCandidates = this.recService.getAllLocalCandidates();
    const curTrack = q[idx] || this.currentTrack() || null;

    let newTracks: Track[] = [];

    if (source === 'library_only') {
      newTracks = this.recService.pickNextTracks(needed, excludeIds, curTrack, recentArtists);
    } else if (source === 'discovery_heavy') {
      const onlineCount = Math.min(needed, 3);
      const discovery = await this.recService.fetchOnlineDiscoveryTracks(onlineCount, excludeIds, recentArtists);
      newTracks.push(...discovery);
      discovery.forEach((d) => {
        excludeIds.add(d.id);
        if (d.artist) recentArtists.add(d.artist);
      });

      if (newTracks.length < needed) {
        const local = this.recService.pickNextTracks(needed - newTracks.length, excludeIds, curTrack, recentArtists);
        newTracks.push(...local);
      }
    } else {
      // Balanced mode: reliably blend 50% online discovery recommendations with 50% library affinity
      const discoveryCount = Math.max(1, Math.ceil(needed / 2));
      const discovery = await this.recService.fetchOnlineDiscoveryTracks(discoveryCount, excludeIds, recentArtists);
      newTracks.push(...discovery);
      discovery.forEach((d) => {
        excludeIds.add(d.id);
        if (d.artist) recentArtists.add(d.artist);
      });

      const remainingNeeded = needed - newTracks.length;
      if (remainingNeeded > 0) {
        const local = this.recService.pickNextTracks(remainingNeeded, excludeIds, curTrack, recentArtists);
        newTracks.push(...local);
      }
    }

    // Resilience fallbacks if online discovery failed or candidates were exhausted
    if (newTracks.length === 0 && localCandidates.length > 0) {
      newTracks = this.recService.pickNextTracks(needed, new Set([q[idx]?.id].filter(Boolean) as string[]), curTrack, recentArtists);
    }

    // Emergency fallback if library is empty and online discovery yielded nothing: recycle non-disliked from queue
    if (newTracks.length === 0 && q.length > 0) {
      const pool = q.filter((t) => !this.recService.isDisliked(t.id));
      if (pool.length > 0) {
        const sample = pool.slice(0, needed);
        newTracks = sample.map((t) => ({ ...t }));
      }
    }

    if (newTracks.length > 0) {
      this.queue.update((curQ) => [...curQ, ...newTracks]);
      this.preloadNextTrack();
    }
  }

  async startSmartMix(mood: MixMood = 'all'): Promise<boolean> {
    this.recService.isMixActive.set(true);
    this.recService.setMixMood(mood);

    const curTrack = this.currentTrack() || null;
    const localCandidates = this.recService.getAllLocalCandidates();

    // Instant Cold-Start for brand new / clean accounts:
    // Instantly start playback with curated popular starter tracks in 0ms without waiting for network searches!
    if (localCandidates.length === 0 && mood !== 'favorites') {
      const starterTracks = this.recService.getStarterCandidates(mood, 5);
      if (starterTracks.length > 0) {
        this.playTrack(starterTracks[0], starterTracks, true, 0);
        // Asynchronously populate and enrich the queue ahead with discovery tracks in background
        this.ensureSmartQueue();
        return true;
      }
    }

    const recentArtists = new Set<string>();
    if (curTrack?.artist) {
      recentArtists.add(curTrack.artist);
    }

    const source = this.recService.mixConfig().source;
    let candidates: Track[] = [];

    if (mood === 'favorites' || source === 'library_only') {
      candidates = this.recService.pickNextTracks(6, new Set(), curTrack, recentArtists);
      if (candidates.length < 6 && source !== 'library_only') {
        const discovery = await this.recService.fetchOnlineDiscoveryTracks(
          6 - candidates.length,
          new Set(candidates.map((t) => t.id)),
          recentArtists
        );
        candidates = [...candidates, ...discovery];
      }
    } else {
      // Balanced / Discovery mode for "Моя волна":
      // Начинаем с потоковых рекомендаций (Deezer / похожие исполнители / вкусовой профиль),
      // чередуя их со знакомыми треками из медиатеки, чтобы волна выполняла функцию открытия новой музыки!
      const onlineCount = source === 'discovery_heavy' ? 4 : 3;
      const localCount = 6 - onlineCount;

      const discovery = await this.recService.fetchOnlineDiscoveryTracks(
        onlineCount,
        new Set(curTrack ? [curTrack.id] : []),
        recentArtists
      );
      discovery.forEach((d) => {
        if (d.artist) recentArtists.add(d.artist);
      });

      const locals = this.recService.pickNextTracks(
        localCount,
        new Set([...discovery.map((d) => d.id), ...(curTrack ? [curTrack.id] : [])]),
        curTrack,
        recentArtists
      );

      // Чередуем: рекомендация, любимый/знакомый трек, рекомендация...
      let dIdx = 0;
      let lIdx = 0;
      while (dIdx < discovery.length || lIdx < locals.length) {
        if (dIdx < discovery.length) candidates.push(discovery[dIdx++]);
        if (lIdx < locals.length) candidates.push(locals[lIdx++]);
      }

      if (candidates.length < 6) {
        const remaining = 6 - candidates.length;
        const moreLocals = this.recService.pickNextTracks(
          remaining,
          new Set(candidates.map((t) => t.id)),
          curTrack,
          recentArtists
        );
        candidates = [...candidates, ...moreLocals];
      }
    }

    if (candidates.length === 0) {
      const discovery = await this.recService.fetchOnlineDiscoveryTracks(6, new Set(), recentArtists);
      if (discovery.length === 0) {
        this.recService.isMixActive.set(false);
        return false;
      }
      candidates = discovery;
    }

    this.playTrack(candidates[0], candidates, true, 0);
    return true;
  }

  stopSmartMix() {
    this.recService.isMixActive.set(false);
  }

  setMixMood(mood: MixMood) {
    this.recService.setMixMood(mood);
    if (this.recService.isMixActive()) {
      const q = this.queue();
      const idx = this.queueIndex();
      // Keep played history up to current, discard stale upcoming, and replenish immediately with new mood
      const played = q.slice(0, idx + 1);
      this.queue.set(played);
      this.ensureSmartQueue();
    }
  }

  updateTrackFavoriteStatus(trackId: string, isFavorite: boolean, trackObj?: Track) {
    const cur = this.currentTrack();
    if (cur) {
      const match = cur.id === trackId || 
        (trackObj && (cur.audioUrl === trackObj.audioUrl || (cur.title.toLowerCase() === trackObj.title.toLowerCase() && cur.artist.toLowerCase() === trackObj.artist.toLowerCase())));
      if (match) {
        this.currentTrack.set({ ...cur, isFavorite });
      }
    }
    this.queue.update((q) =>
      q.map((t) => {
        const match = t.id === trackId || 
          (trackObj && (t.audioUrl === trackObj.audioUrl || (t.title.toLowerCase() === trackObj.title.toLowerCase() && t.artist.toLowerCase() === trackObj.artist.toLowerCase())));
        return match ? { ...t, isFavorite } : t;
      })
    );
  }

  dislikeCurrentTrack() {
    const cur = this.currentTrack();
    if (!cur) return;
    this.recService.dislikeTrack(cur.id);
    this.next();
  }
}
