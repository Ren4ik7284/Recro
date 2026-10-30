import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { Track } from '../models/track.model';
import { LibraryService } from './library.service';
import { OfflineService } from './offline.service';
import { RecommendationService, MixMood, isTrackLanguageMatch, normalizeArtist, extractAllArtists } from './recommendation.service';
import { NavigationService } from './navigation.service';

export type LosslessScalingMode = 'studio' | 'spatial' | 'bass' | 'off';

@Injectable({
  providedIn: 'root',
})
export class AudioService {
  private libraryService = inject(LibraryService);
  private offlineService = inject(OfflineService);
  readonly recService = inject(RecommendationService);
  private navService = inject(NavigationService);
  private audio: HTMLAudioElement;

  // Web Audio API Nodes for Lossless Scaling DSP & Normalization & Crossfade & Visualizer
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private lsBassFilter: BiquadFilterNode | null = null;
  private lsClarityFilter: BiquadFilterNode | null = null;
  private lsAirFilter: BiquadFilterNode | null = null;
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
  private readonly STORAGE_KEY_REPEAT = 'signal_player_repeat';
  private readonly STORAGE_KEY_SHUFFLE = 'signal_player_shuffle';
  private readonly STORAGE_KEY_QUALITY = 'signal_player_audio_quality';
  private readonly STORAGE_KEY_BIT_PERFECT = 'signal_player_bit_perfect';
  private readonly STORAGE_KEY_LS_MODE = 'signal_player_lossless_scaling';

  readonly volume = signal<number>(this.loadSavedVolume());
  readonly isMuted = signal<boolean>(false);
  readonly isShuffle = signal<boolean>(this.loadSavedShuffle());
  readonly repeatMode = signal<'off' | 'one' | 'all'>(this.loadSavedRepeatMode());
  readonly audioQuality = signal<'lossless' | 'high' | 'auto' | 'data_saver'>(this.loadSavedQuality());
  readonly isBitPerfect = signal<boolean>(this.loadSavedBitPerfect());

  readonly toastNotice = signal<{ message: string; timestamp: number } | null>(null);
  private originalQueue: Track[] = [];

  readonly losslessScalingMode = signal<LosslessScalingMode>(this.loadSavedLosslessScaling());
  readonly isLosslessScalingActive = computed(() => this.losslessScalingMode() !== 'off');
  readonly losslessScalingLabel = computed(() => {
    switch (this.losslessScalingMode()) {
      case 'studio': return 'LS STUDIO';
      case 'spatial': return 'LS 3D';
      case 'bass': return 'LS BASS';
      case 'off': default: return 'LS OFF';
    }
  });
  readonly audioSampleRate = signal<number>(48000);

  readonly isLosslessPlayback = computed(() => {
    const track = this.currentTrack();
    if (!track) return false;
    if (track.isLossless || track.format === 'flac' || track.format === 'wav') return true;
    if (this.audioQuality() === 'lossless' && !track.isLiveStream) return true;
    return false;
  });

  readonly queue = signal<Track[]>([]);
  readonly queueIndex = signal<number>(-1);
  readonly preloadedNextTrack = signal<Track | null>(null);
  readonly prewarmedWaveTrack = signal<Track | null>(null);
  readonly isPrewarmingWave = signal<boolean>(false);
  readonly playbackSpeed = signal<number>(1.0);

  setPlaybackSpeed(speed: number) {
    const valid = Math.max(0.5, Math.min(2.0, speed));
    this.playbackSpeed.set(valid);
    if (this.audio) {
      this.audio.playbackRate = valid;
    }
  }

  private isHandlingEnd = false;
  private hasAudioStartedPlaying = false;
  private isFadingOut = false;
  private hasRecordedCompletion = false;
  private hasPreloadedNextTrack = false;
  private lastPreloadedTrackId: string | null = null;
  private preloadAudio: HTMLAudioElement | null = null;
  private preloadedAudioUrl: string | null = null;
  private isReplenishingQueue = false;
  private replenishingPromise: Promise<void> | null = null;
  private consecutiveErrorCount = 0;
  private errorTimeoutId: any = null;
  private fadeIntervalId: any = null;
  private currentPlayRequestId = 0;
  private isSwitchingTrack = false;
  private startupWatchdogTimer: any = null;

  private clearStartupWatchdog() {
    if (this.startupWatchdogTimer) {
      clearTimeout(this.startupWatchdogTimer);
      this.startupWatchdogTimer = null;
    }
  }

  private startStartupWatchdog(track: Track, requestId: number) {
    this.clearStartupWatchdog();
    this.startupWatchdogTimer = setTimeout(() => {
      if (requestId !== this.currentPlayRequestId) return;
      // В HTML5 Audio play() сразу переводит audio.paused в false, даже во время загрузки сети.
      // Поэтому проверка audio.paused блокировала срабатывание вотчдога при зависании сети.
      if (!this.hasAudioStartedPlaying && (this.audio.currentTime === 0 || isNaN(this.audio.currentTime))) {
        console.warn(`[AudioService] Track startup stalled (>9.0s) for "${track.title}", failing over cluster...`);
        this.handlePlaybackFailure('startup_stall');
      }
    }, 9000);
  }
  // Timestamp-дебаунс для ensureSmartQueue в timeupdate: не спамить вызов каждые 250ms
  private lastQueueEnsureTime = 0;
  private lastMediaSessionPositionTime = 0;
  private lastNativeBridgeSyncTime = 0;
  private wakeLockSentinel: any = null;
  private activeStreamAbortController: AbortController | null = null;
  private endSilenceStreakSeconds = 0;
  private prematureEndedRetryCount = 0;

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

  private loadSavedRepeatMode(): 'off' | 'one' | 'all' {
    if (typeof localStorage === 'undefined') return 'off';
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_REPEAT);
      if (saved === 'off' || saved === 'all' || saved === 'one') {
        return saved as 'off' | 'one' | 'all';
      }
    } catch {}
    return 'off';
  }

  private loadSavedShuffle(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      return localStorage.getItem(this.STORAGE_KEY_SHUFFLE) === 'true';
    } catch {
      return false;
    }
  }

  notifyUser(message: string) {
    this.toastNotice.set({ message, timestamp: Date.now() });
  }

  shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Translates linear UI slider position (0..1) to human ear perceived loudness
   * using a quadratic curve so the middle position is comfortable, gentle, and doesn't cut ears.
   */
  private effectiveVolume(sliderVol: number): number {
    const clamped = Math.max(0, Math.min(1, sliderVol));
    return Math.pow(clamped, 2);
  }

  private loadSavedQuality(): 'lossless' | 'high' | 'auto' | 'data_saver' {
    if (typeof localStorage === 'undefined') return 'auto';
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_QUALITY);
      if (saved === 'lossless' || saved === 'high' || saved === 'auto' || saved === 'data_saver') {
        return saved;
      }
    } catch {}
    return 'auto';
  }

  private loadSavedBitPerfect(): boolean {
    if (typeof localStorage === 'undefined') return true;
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_BIT_PERFECT);
      if (saved !== null) {
        return saved === 'true';
      }
    } catch {}
    return true;
  }

  private loadSavedLosslessScaling(): LosslessScalingMode {
    if (typeof localStorage === 'undefined') return 'studio';
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY_LS_MODE);
      if (saved === 'studio' || saved === 'spatial' || saved === 'bass' || saved === 'off') {
        return saved as LosslessScalingMode;
      }
    } catch {}
    return 'studio';
  }

  setAudioQuality(quality: 'lossless' | 'high' | 'auto' | 'data_saver') {
    this.audioQuality.set(quality);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY_QUALITY, quality);
      } catch {}
    }
    this.applyBitPerfectState();
    const cur = this.currentTrack();
    if (cur && this.isPlaying() && !cur.audioUrl.startsWith('blob:') && !cur.isLiveStream) {
      const pos = this.currentTime();
      this.playTrack(cur).then(() => {
        if (pos > 0) {
          this.seek(pos);
        }
      });
    }
  }

  cycleAudioQuality() {
    const current = this.audioQuality();
    let next: 'lossless' | 'high' | 'auto' | 'data_saver' = 'auto';
    if (current === 'auto') next = 'lossless';
    else if (current === 'lossless') next = 'high';
    else if (current === 'high') next = 'data_saver';
    else next = 'auto';
    this.setAudioQuality(next);
  }

  toggleBitPerfect() {
    this.isBitPerfect.update((v) => !v);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY_BIT_PERFECT, String(this.isBitPerfect()));
      } catch {}
    }
    this.applyBitPerfectState();
  }

  setLosslessScalingMode(mode: LosslessScalingMode) {
    this.losslessScalingMode.set(mode);
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_KEY_LS_MODE, mode);
      } catch {}
    }
    this.ensureAudioContext();
    this.applyLosslessScaling();
  }

  cycleLosslessScaling() {
    const current = this.losslessScalingMode();
    const modes: LosslessScalingMode[] = ['studio', 'spatial', 'bass', 'off'];
    const nextIdx = (modes.indexOf(current) + 1) % modes.length;
    this.setLosslessScalingMode(modes[nextIdx]);
  }

  getLosslessScalingTooltip(): string {
    switch (this.losslessScalingMode()) {
      case 'studio':
        return 'Lossless Scaling: Studio Hi-Res (Кристальный воздух 11.8kHz+, выразительный вокал и упругий суб-бас 75Hz)';
      case 'spatial':
        return 'Lossless Scaling: Spatial 3D (Голографическая сцена, расширенная панорама и открытый верх)';
      case 'bass':
        return 'Lossless Scaling: Bass Impact (Глубокий клубный бас без искажений и грязи)';
      case 'off':
      default:
        return 'Lossless Scaling: Выключено (Direct Bit-Perfect Bypass 0.0 dB)';
    }
  }

  applyLosslessScaling(immediate = false) {
    if (!this.lsBassFilter || !this.lsClarityFilter || !this.lsAirFilter || !this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      let bassGain = 0;
      let clarityGain = 0;
      let airGain = 0;

      const mode = this.losslessScalingMode();
      if (mode === 'studio') {
        bassGain = 3.5;
        clarityGain = 2.2;
        airGain = 3.8;
      } else if (mode === 'spatial') {
        bassGain = 2.0;
        clarityGain = 1.6;
        airGain = 4.8;
      } else if (mode === 'bass') {
        bassGain = 6.0;
        clarityGain = 0.8;
        airGain = 2.0;
      } else {
        bassGain = 0;
        clarityGain = 0;
        airGain = 0;
      }

      if (immediate) {
        this.lsBassFilter.gain.setValueAtTime(bassGain, now);
        this.lsClarityFilter.gain.setValueAtTime(clarityGain, now);
        this.lsAirFilter.gain.setValueAtTime(airGain, now);
      } else {
        // Smooth 50ms exponential glide: zero audible clicks or pops during active playback
        this.lsBassFilter.gain.setTargetAtTime(bassGain, now, 0.05);
        this.lsClarityFilter.gain.setTargetAtTime(clarityGain, now, 0.05);
        this.lsAirFilter.gain.setTargetAtTime(airGain, now, 0.05);
      }
    } catch {}
  }

  applyBitPerfectState() {
    if (!this.compressorNode || !this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      if (this.isBitPerfect() || this.isLosslessPlayback()) {
        // Bit-Perfect direct output: completely neutral 1:1 ratio, 0 dB threshold
        this.compressorNode.threshold.setValueAtTime(0, now);
        this.compressorNode.ratio.setValueAtTime(1, now);
      } else {
        // Standard gentle limiter
        this.compressorNode.threshold.setValueAtTime(-14, now);
        this.compressorNode.ratio.setValueAtTime(4, now);
      }
    } catch {}
    this.applyLosslessScaling();
  }

  constructor() {
    if (typeof document !== 'undefined') {
      this.audio = document.createElement('audio');
      this.audio.setAttribute('playsinline', 'true');
      this.audio.setAttribute('webkit-playsinline', 'true');
      this.audio.setAttribute('x-webkit-airplay', 'allow');
      this.audio.preload = 'auto';
      this.audio.style.position = 'fixed';
      this.audio.style.top = '-9999px';
      this.audio.style.left = '-9999px';
      this.audio.style.width = '1px';
      this.audio.style.height = '1px';
      this.audio.style.opacity = '0.01';
      this.audio.style.pointerEvents = 'none';

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
    this.audio.loop = (this.repeatMode() === 'one');

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
        } else if (action === 'refresh_media_session') {
          const cur = this.currentTrack();
          if (cur) {
            this.updateMediaSessionMetadata(cur);
            this.updateMediaSessionPlaybackState(this.isPlaying() ? 'playing' : 'paused');
            this.updateMediaSessionPosition();
          }
        }
      };
    }

    this.setupEventListeners();
    this.setupMediaSession();

  }

  /**
   * Initializes Web Audio API graph:
   * HTMLAudioElement -> MediaElementSourceNode -> Lossless Scaling 3-Band DSP -> DynamicsCompressorNode (Peak Limiting) -> GainNode (Fade) -> AnalyserNode -> Destination
   */
  private initAudioContext() {
    if (this.isAudioGraphReady || typeof window === 'undefined') return;

    // Mobile browsers (Chrome Android / iOS Safari) kill WebAudio graphs on screen lock.
    // Keeping native HTML5 audio output on mobile smartphones guarantees the Lock Screen & Notification widget stays active.
    const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      return;
    }

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      this.audioCtx = new AudioCtxClass({
        latencyHint: 'playback'
      });
      if (this.audioCtx.sampleRate) {
        this.audioSampleRate.set(this.audioCtx.sampleRate);
      }

      this.audioCtx.onstatechange = () => {
        if (this.audioCtx && this.audioCtx.state === 'suspended' && this.isPlaying()) {
          this.audioCtx.resume().catch(() => {});
        }
      };

      try {
        if (!this.sourceNode) {
          this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
        }
      } catch (err) {
        console.warn('[AudioService] Failed to create MediaElementSource, using direct audio output:', err);
        this.sourceNode = null;
        return;
      }

      // 1. Lossless Scaling DSP Engine: 3-band high-precision studio mastering filters
      this.lsBassFilter = this.audioCtx.createBiquadFilter();
      this.lsBassFilter.type = 'lowshelf';
      this.lsBassFilter.frequency.setValueAtTime(75, this.audioCtx.currentTime);

      this.lsClarityFilter = this.audioCtx.createBiquadFilter();
      this.lsClarityFilter.type = 'peaking';
      this.lsClarityFilter.frequency.setValueAtTime(3200, this.audioCtx.currentTime);
      this.lsClarityFilter.Q.setValueAtTime(0.9, this.audioCtx.currentTime);

      this.lsAirFilter = this.audioCtx.createBiquadFilter();
      this.lsAirFilter.type = 'highshelf';
      this.lsAirFilter.frequency.setValueAtTime(11800, this.audioCtx.currentTime);

      // Apply initial DSP gains
      this.applyLosslessScaling(true);

      // 2. DynamicsCompressor for gentle peak leveling without squashing dynamics or causing pumping
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.compressorNode.threshold.setValueAtTime(-14, this.audioCtx.currentTime);
      this.compressorNode.knee.setValueAtTime(16, this.audioCtx.currentTime);
      this.compressorNode.ratio.setValueAtTime(4, this.audioCtx.currentTime);
      this.compressorNode.attack.setValueAtTime(0.01, this.audioCtx.currentTime);
      this.compressorNode.release.setValueAtTime(0.18, this.audioCtx.currentTime);

      // 3. GainNode for smooth crossfades and click-free track transitions
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

      // 4. AnalyserNode for real-time audio visualization
      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.82;

      // Connect graph: Source -> LS Bass -> LS Clarity -> LS Air -> Compressor -> Gain -> Analyser -> Destination
      this.sourceNode.connect(this.lsBassFilter);
      this.lsBassFilter.connect(this.lsClarityFilter);
      this.lsClarityFilter.connect(this.lsAirFilter);
      this.lsAirFilter.connect(this.compressorNode);
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

  private applyFadeIn(durationSec = 0.12) {
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
        this.gainNode.gain.setValueAtTime(0.7, now);
        this.gainNode.gain.linearRampToValueAtTime(1.0, now + durationSec);
        return;
      } catch {}
    }

    // HTML5 Audio volume fallback for non-web-audio desktop
    const targetVol = this.effectiveVolume(this.volume());
    const startVol = Math.max(0.01, targetVol * 0.7);
    this.audio.volume = startVol;
    const steps = 6;
    const stepTime = Math.max(15, (durationSec * 1000) / steps);
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

      if (!this.isCrossfadeEnabled() || this.isLiveStream() || isMobile || (!this.isSwitchingTrack && !this.isHandlingEnd)) {
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

  private rebuildAudioGraphConnections() {
    if (!this.sourceNode || !this.gainNode || !this.audioCtx) return;
    try {
      this.sourceNode.disconnect();
      if (this.lsBassFilter) this.lsBassFilter.disconnect();
      if (this.lsClarityFilter) this.lsClarityFilter.disconnect();
      if (this.lsAirFilter) this.lsAirFilter.disconnect();
      if (this.compressorNode) this.compressorNode.disconnect();

      let lastNode: AudioNode = this.sourceNode;
      if (this.lsBassFilter && this.lsClarityFilter && this.lsAirFilter) {
        lastNode.connect(this.lsBassFilter);
        this.lsBassFilter.connect(this.lsClarityFilter);
        this.lsClarityFilter.connect(this.lsAirFilter);
        lastNode = this.lsAirFilter;
      }

      if (this.isNormalizationEnabled() && this.compressorNode) {
        lastNode.connect(this.compressorNode);
        this.compressorNode.connect(this.gainNode);
      } else {
        lastNode.connect(this.gainNode);
      }
    } catch (err) {
      console.warn('[AudioService] Failed to rebuild audio graph:', err);
    }
  }

  toggleNormalization() {
    this.isNormalizationEnabled.update((v) => !v);
    this.rebuildAudioGraphConnections();
  }

  toggleCrossfade() {
    this.isCrossfadeEnabled.update((v) => !v);
  }

  private setupEventListeners() {
    let stallTimer: any = null;
    let deepStallTimer: any = null;
    const onStall = () => {
      if (!this.isPlaying() || this.audio.paused || this.isHandlingEnd || this.isSwitchingTrack) return;
      if (stallTimer) clearTimeout(stallTimer);
      if (deepStallTimer) clearTimeout(deepStallTimer);

      // Fast responsive nudge at 3.5s to prevent long awkward pauses
      stallTimer = setTimeout(() => {
        if (this.isPlaying() && !this.audio.ended && this.hasAudioStartedPlaying) {
          console.warn('[AudioService] Playback buffer wait (>3.5s), nudging stream...');
          this.audio.play().catch(() => {});
        }
      }, 3500);

      // Auto-recover stream position without skipping if frozen for >7s
      deepStallTimer = setTimeout(() => {
        if (this.isPlaying() && !this.audio.ended && this.hasAudioStartedPlaying) {
          console.warn('[AudioService] Deep stall (>7s), auto-recovering stream position...');
          const pos = this.currentTime();
          this.seek(pos);
          this.audio.play().catch(() => {});
        }
      }, 7000);
    };

    const clearStall = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (deepStallTimer) {
        clearTimeout(deepStallTimer);
        deepStallTimer = null;
      }
    };

    this.audio.addEventListener('waiting', onStall);
    this.audio.addEventListener('stalled', onStall);

    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.currentTime > 0) {
        this.clearStartupWatchdog();
        this.hasAudioStartedPlaying = true;
      }
      if (!this.hasAudioStartedPlaying) return;
      clearStall();
      this.clearStartupWatchdog();
      const actual = this.streamSeekOffset() + this.audio.currentTime;
      this.currentTime.set(actual);

      const total = this.duration();

      // 1. Natural end only when actual playback exceeds total track duration by at least 3.0s
      // and decoded audio has truly finished (prevents hanging in dead outro, but never cuts music)
      if (this.repeatMode() !== 'one' && total > 15 && actual >= total + 3.0 && !this.isLiveStream()) {
        const audioDur = this.audio.duration;
        if (!audioDur || isNaN(audioDur) || actual >= this.streamSeekOffset() + audioDur - 0.5) {
          console.warn(`[AudioService] Playback reached track end (${actual.toFixed(1)}s / ${total}s), advancing to next track`);
          this.handleTrackEnded();
          return;
        }
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

      // Preload next track audio stream only when nearing completion (>75% played or 15s remaining)
      if ((actual >= total * 0.75 || (total > 20 && actual >= total - 15)) && !this.hasPreloadedNextTrack) {
        this.hasPreloadedNextTrack = true;
        this.preloadNextTrack();
      }

      // Sync lock screen / notification progress bar every 1.5s
      if (now - this.lastMediaSessionPositionTime > 1500) {
        this.lastMediaSessionPositionTime = now;
        this.updateMediaSessionPosition();
        if (now - this.lastNativeBridgeSyncTime > 4000) {
          this.lastNativeBridgeSyncTime = now;
          this.notifyNativeBridge(this.currentTrack(), this.isPlaying());
        }
      }
    });

    this.audio.addEventListener('loadedmetadata', () => {
      const d = this.audio.duration;
      const trackDur = this.currentTrack()?.duration;
      if (d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(this.streamSeekOffset() + d);
      } else if (trackDur && trackDur > 0) {
        this.duration.set(trackDur);
      }
      this.updateMediaSessionPosition();
      this.notifyNativeBridge(this.currentTrack(), this.isPlaying());
    });

    this.audio.addEventListener('durationchange', () => {
      const d = this.audio.duration;
      const trackDur = this.currentTrack()?.duration;
      if (d && !isNaN(d) && isFinite(d) && d > 0) {
        this.duration.set(this.streamSeekOffset() + d);
      } else if (trackDur && trackDur > 0) {
        this.duration.set(trackDur);
      }
      this.updateMediaSessionPosition();
      this.notifyNativeBridge(this.currentTrack(), this.isPlaying());
    });

    this.audio.addEventListener('play', () => {
      clearStall();
      if (this.playbackSpeed() !== 1.0) {
        this.audio.playbackRate = this.playbackSpeed();
      }
      this.isPlaying.set(true);
      this.updateMediaSessionPlaybackState('playing');
      const cur = this.currentTrack();
      if (cur) this.updateMediaSessionMetadata(cur);
      this.updateMediaSessionPosition();
    });

    this.audio.addEventListener('playing', () => {
      clearStall();
      this.clearStartupWatchdog();
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
      clearStall();
      this.clearStartupWatchdog();
      // If we are simply rebuffering, handling end, or near end of track, ignore pause event
      const curTime = this.audio.currentTime || 0;
      const dur = this.audio.duration || 0;
      const isNearEnd = dur > 0 && curTime >= dur - 1.0;

      if (!this.isHandlingEnd && !this.isSwitchingTrack && !isNearEnd) {
        // Если браузер временно поставил на паузу при переключении вкладки в фон (visibilityState === 'hidden'),
        // но пользователь не нажимал кнопку паузы — сразу же пробуем возобновить воспроизведение!
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && this.isPlaying()) {
          console.warn('[AudioService] Background tab pause intercepted, auto-resuming...');
          this.audio.play().catch(() => {
            this.isPlaying.set(false);
            this.updateMediaSessionPlaybackState('paused');
          });
          return;
        }

        this.isPlaying.set(false);
        this.updateMediaSessionPlaybackState('paused');
        this.updateMediaSessionPosition();
        this.releaseWakeLock();
      }
    });

    this.audio.addEventListener('ended', () => {
      this.endSilenceStreakSeconds = 0;
      if (this.isLiveStream()) {
        console.warn('[AudioService] Live stream ended event, attempting reconnect in 2s');
        this.handlePlaybackFailure('live_stream_ended');
        return;
      }

      const played = this.audio.currentTime || 0;
      const totalPlayed = this.streamSeekOffset() + played;
      const dur = this.duration() || this.currentTrack()?.duration || 0;

      // 1. Если поток завершился едва начавшись (<1.5с) — сбой сети
      if (totalPlayed < 1.5) {
        console.warn('[AudioService] Premature ended event (<1.5s played), treating as playback failure');
        this.handlePlaybackFailure('premature_ended');
        return;
      }

      // 2. Трек завершился естественно ТОЛЬКО если доиграл практически до конца (в пределах 2.5с до duration)
      // или если длительность трека неизвестна/очень короткая (<= 15с)
      if (dur <= 15 || totalPlayed >= dur - 2.5) {
        this.prematureEndedRetryCount = 0;
        this.handleTrackEnded();
        return;
      }

      // 3. Преждевременный обрыв потока в середине/конце трека — бесшовно переподключаем с текущей секунды!
      if (this.prematureEndedRetryCount < 3) {
        this.prematureEndedRetryCount++;
        console.warn(`[AudioService] Stream cut off prematurely at ${totalPlayed.toFixed(1)}s / ${dur}s, reconnecting from position (attempt ${this.prematureEndedRetryCount}/3)...`);
        this.seek(totalPlayed, true);
        return;
      }

      // Если 3 попытки переподключения не удались, не скипаем трек молча в медиатеке, а останавливаем воспроизведение
      console.warn('[AudioService] Stream repeatedly cut off, pausing cleanly without skipping library queue');
      this.prematureEndedRetryCount = 0;
      this.pause();
    });

    this.audio.addEventListener('error', (e) => {
      console.warn('[AudioService] Audio element error:', e);
      const cur = this.currentTrack();
      if (cur && this.audio.src.startsWith('blob:')) {
        console.warn('[AudioService] Audio element transient error on blob, re-resolving blob URL without deleting cache');
        this.offlineService.getOfflineBlobUrl(cur.id).then((freshUrl) => {
          if (freshUrl && this.currentTrack()?.id === cur.id) {
            this.audio.src = freshUrl;
            this.audio.play().catch(() => {});
          } else {
            this.playTrack({ ...cur, isOffline: false });
          }
        }).catch(() => {
          this.playTrack({ ...cur, isOffline: false });
        });
        return;
      }

      // Если произошла ошибка при crossOrigin = 'anonymous' (частый сбой CORS на VPN),
      // мгновенно снимаем crossorigin и пробуем воспроизвести как opaque media!
      if (this.audio.hasAttribute('crossorigin')) {
        console.warn('[AudioService] Potential CORS/VPN block detected, retrying without crossorigin attribute');
        this.audio.removeAttribute('crossorigin');
        const retryUrl = this.audio.src;
        if (retryUrl && !retryUrl.startsWith('blob:')) {
          try {
            this.audio.load();
            this.audio.play().catch((err) => {
              if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
                this.isPlaying.set(false);
                this.updateMediaSessionPlaybackState('paused');
                return;
              }
              this.handlePlaybackFailure('native_error');
            });
            return;
          } catch {}
        }
      }

      this.handlePlaybackFailure('native_error');
    });

    if (typeof document !== 'undefined') {
      const keepAudioAlive = () => {
        if (this.audioCtx && this.audioCtx.state === 'suspended' && this.isPlaying()) {
          this.audioCtx.resume().catch(() => {});
        }
        if (this.isPlaying()) {
          // If track should play but browser tried to pause it on background/window blur
          if (this.audio.paused && !this.audio.ended && this.hasAudioStartedPlaying) {
            console.log('[AudioService] Ensuring audio playback stays active during window/tab state change');
            this.audio.play().catch(() => {});
          }
        }
      };

      document.addEventListener('visibilitychange', () => {
        keepAudioAlive();
        if (document.visibilityState === 'visible') {
          this.requestWakeLock();
          this.updateMediaSessionPosition();
        }
      });
      window.addEventListener('focus', keepAudioAlive);
      window.addEventListener('blur', keepAudioAlive);
    }
  }

  private handlePlaybackFailure(source: string) {
    console.warn(`[AudioService] Playback failure from ${source}`);
    this.hasAudioStartedPlaying = false;
    this.clearStartupWatchdog();

    if (this.errorTimeoutId) {
      clearTimeout(this.errorTimeoutId);
      this.errorTimeoutId = null;
    }

    if (this.isLiveStream()) {
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
      this.consecutiveErrorCount++;

      // Попытка 1: мгновенно переключить ноду кластера (Москва <-> Франкфурт) и повторить
      if (this.consecutiveErrorCount === 1) {
        const cur = this.currentTrack();
        if (cur) {
          console.warn('[AudioService] Transient failure or stall, failing over cluster (attempt 1)...');
          this.libraryService.failoverBackend();
          const activeBase = this.libraryService.getBackendUrl();
          const cleanTitle = encodeURIComponent(cur.title.replace(/\(.*?\)|\[.*?]/g, '').trim());
          const cleanArt = encodeURIComponent((cur.artist || '').replace(/\(.*?\)|\[.*?]/g, '').trim());
          const idParam = cur.id && !cur.id.startsWith('default-') && !cur.id.startsWith('radio-') ? `&id=${encodeURIComponent(cur.id)}` : '';
          const altUrl = `${activeBase}/api/stream?title=${cleanTitle}&artist=${cleanArt}${idParam}`;
          const updatedTrack = { ...cur, audioUrl: altUrl };
          this.errorTimeoutId = setTimeout(() => {
            this.playTrack(updatedTrack, this.queue(), false, this.queueIndex());
          }, 150);
          return;
        }
      }

      // Попытка 2: повторить со вторым фоллбэком через search query на альтернативной ноде
      if (this.consecutiveErrorCount === 2) {
        const cur = this.currentTrack();
        if (cur) {
          console.warn('[AudioService] Attempt 2: failover to alternative node with search query...');
          this.libraryService.failoverBackend();
          const activeBase = this.libraryService.getBackendUrl();
          const cleanTitle = cur.title.replace(/\(.*?\)|\[.*?]/g, '').trim();
          const cleanArt = (cur.artist || '').replace(/\(.*?\)|\[.*?]/g, '').trim();
          const altUrl = `${activeBase}/api/stream?url=${encodeURIComponent(`search:${cleanTitle} ${cleanArt}`.trim())}`;
          const updatedTrack = { ...cur, audioUrl: altUrl };
          this.errorTimeoutId = setTimeout(() => {
            this.playTrack(updatedTrack, this.queue(), false, this.queueIndex());
          }, 150);
          return;
        }
      }

      // Если и повтор не удался: аккуратно ставим на паузу, НЕ пропуская треки в библиотеке пачками!
      console.warn('[AudioService] Track playback failed after cluster retries, stopping gracefully without skipping user queue');
      this.isPlaying.set(false);
      this.updateMediaSessionPlaybackState('paused');
      this.consecutiveErrorCount = 0;
      this.releaseWakeLock();
      return;
    }

    this.consecutiveErrorCount++;

    if (this.recService.isMixActive()) {
      if (this.consecutiveErrorCount === 1) {
        console.warn(`[AudioService] Transient failure in mix (attempt 1), failing over cluster immediately...`);
        this.libraryService.failoverBackend();
        const cur = this.currentTrack();
        if (cur) {
          const activeBase = this.libraryService.getBackendUrl();
          const cleanTitle = encodeURIComponent(cur.title.replace(/\(.*?\)|\[.*?]/g, '').trim());
          const cleanArt = encodeURIComponent((cur.artist || '').replace(/\(.*?\)|\[.*?]/g, '').trim());
          const idParam = cur.id && !cur.id.startsWith('default-') && !cur.id.startsWith('radio-') ? `&id=${encodeURIComponent(cur.id)}` : '';
          const altUrl = `${activeBase}/api/stream?title=${cleanTitle}&artist=${cleanArt}${idParam}`;
          const updatedTrack = { ...cur, audioUrl: altUrl };
          this.errorTimeoutId = setTimeout(() => {
            if (this.recService.isMixActive()) {
              this.playTrack(updatedTrack, undefined, true);
            }
          }, 150);
          return;
        }
      }

      if (this.consecutiveErrorCount === 2) {
        const cur = this.currentTrack();
        if (cur && cur.title) {
          console.warn('[AudioService] Primary stream failed in mix (attempt 2), failing over cluster and resolving search stream...');
          this.libraryService.failoverBackend();
          const activeBase = this.libraryService.getBackendUrl();
          const cleanTitle = cur.title.replace(/\(.*?\)|\[.*?]/g, '').trim();
          const cleanArt = (cur.artist || '').replace(/\(.*?\)|\[.*?]/g, '').trim();
          const altUrl = `${activeBase}/api/stream?url=${encodeURIComponent(`search:${cleanTitle} ${cleanArt}`.trim())}`;
          const updatedTrack = { ...cur, audioUrl: altUrl };
          this.errorTimeoutId = setTimeout(() => {
            if (this.recService.isMixActive()) {
              this.playTrack(updatedTrack, undefined, true);
            }
          }, 150);
          return;
        }
      }

      console.warn('[AudioService] Playback failure in mix after cluster retries, smoothly advancing to next track');
      this.consecutiveErrorCount = 0;
      this.errorTimeoutId = setTimeout(() => {
        if (this.recService.isMixActive()) {
          this.next();
        }
      }, 300);
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
      this.play();
      this.updateMediaSessionPlaybackState('playing');
    });

    setAction('pause', () => {
      this.pause();
      this.updateMediaSessionPlaybackState('paused');
    });

    setAction('stop', () => {
      this.pause();
      this.updateMediaSessionPlaybackState('paused');
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
          const apiCover = `/api/cover?url=${encodeURIComponent(url)}`;
          return activeBase.startsWith('http') ? `${activeBase}${apiCover}` : `${origin}${apiCover}`;
        }
        if (url.startsWith('https://') || url.startsWith('http://')) return url;
        if (url.startsWith('/api/')) {
          return activeBase.startsWith('http') ? `${activeBase}${url}` : `${origin}${url}`;
        }
        return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
      };

      const coverUrl = getFullUrl(track.coverUrl);
      const posMs = Math.max(0, Math.round((this.currentTime() || 0) * 1000));
      const durMs = Math.max(0, Math.round((this.duration() || 0) * 1000));
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

      const getFullUrl = (url?: string | null): string => {
        if (!url || typeof url !== 'string') return `${origin}/icons/icon-512.png`;
        const trimmed = url.trim();
        if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
          return `${origin}/icons/icon-512.png`;
        }
        if (isHttps && trimmed.startsWith('http://')) {
          const apiCover = `/api/cover?url=${encodeURIComponent(trimmed)}`;
          return activeBase.startsWith('http') ? `${activeBase}${apiCover}` : `${origin}${apiCover}`;
        }
        if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return trimmed;
        if (trimmed.startsWith('/api/')) {
          return activeBase.startsWith('http') ? `${activeBase}${trimmed}` : `${origin}${trimmed}`;
        }
        return `${origin}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
      };

      const cover = getFullUrl(track.coverUrl);
      const isDefault = cover.endsWith('/icons/icon-512.png');
      const artwork: MediaImage[] = [];
      if (!isDefault) {
        artwork.push(
          { src: cover, sizes: '512x512' },
          { src: cover, sizes: '256x256' },
          { src: cover, sizes: '128x128' },
        );
      }
      artwork.push(
        { src: `${origin}/icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `${origin}/icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
      );

      const title = (track.title || 'Recro Track').trim();
      const artist = (track.artist || 'Recro').trim();
      const album = (track.album || 'Recro Music').trim();

      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork,
      });

      if (typeof document !== 'undefined') {
        document.title = `${title} • ${artist} | Recro`;
      }
    } catch {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: (track.title || 'Recro Track').trim(),
          artist: (track.artist || 'Recro').trim(),
          album: 'Recro Music',
        });
      } catch {}
    }
  }

  private updateMediaSessionPosition() {
    if (typeof window === 'undefined' || !('mediaSession' in navigator)) return;
    if (!('setPositionState' in navigator.mediaSession)) return;

    const d = this.duration();
    if (!d || d <= 0 || !isFinite(d) || this.isLiveStream()) {
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

    if (
      url.startsWith('/') ||
      url.startsWith(window.location.origin) ||
      url.includes('/api/stream') ||
      url.includes('80.87.202.157') ||
      url.includes('177.3.217.64') ||
      url.includes('sslip.io')
    ) {
      return true;
    }
    const backendUrl = this.libraryService?.getBackendUrl?.() || '';
    if (backendUrl && url.startsWith(backendUrl)) {
      return true;
    }
    return false;
  }

  async playTrack(track: Track, newQueue?: Track[], fromMix: boolean = false, queueIndex?: number) {
    if (!track) {
      console.warn('[AudioService] playTrack called with null/undefined track');
      if (this.recService.isMixActive()) {
        const mood = this.recService.currentMood();
        const lang = this.recService.mixConfig().language;
        const starters = this.recService.getStarterCandidates(mood, 6, lang).filter((t) => !this.recService.isLibraryTrack(t));
        if (starters.length > 0) {
          const randIdx = Math.floor(Math.random() * starters.length);
          const chosen = starters[randIdx];
          this.recService.recordStarterUsed(chosen);
          this.playTrack(chosen, undefined, true);
        }
      }
      return;
    }

    if (this.recService.isDisliked(track.id) || this.libraryService.isDisliked(track)) {
      if (this.recService.isMixActive()) {
        this.next();
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
      this.originalQueue = [...newQueue];
      if (this.isShuffle() && newQueue.length > 1 && !fromMix) {
        // User started playing a playlist / library / chart with Shuffle active!
        // Keep the chosen track first, shuffle the rest of the queue
        const otherTracks = newQueue.filter((t) => t.id !== track.id);
        const shuffledRest = this.shuffleArray(otherTracks);
        this.queue.set([track, ...shuffledRest]);
        this.queueIndex.set(0);
      } else {
        this.queue.set([...newQueue]);
        if (queueIndex !== undefined && queueIndex >= 0 && queueIndex < newQueue.length) {
          this.queueIndex.set(queueIndex);
        } else {
          const idx = newQueue.findIndex((t) => t.id === track.id);
          this.queueIndex.set(idx >= 0 ? idx : 0);
        }
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

    const isFav = typeof this.libraryService.isTrackFavorite === 'function'
      ? this.libraryService.isTrackFavorite(track)
      : (track.isFavorite ?? false);
    if (this.currentTrack()?.id !== track.id) {
      this.consecutiveErrorCount = 0;
    }
    this.currentTrack.set({ ...track, isFavorite: isFav });
    this.recService.recordTrackStarted(track);
    this.recService.registerSessionPlayed(track);
    this.streamSeekOffset.set(0);
    this.currentTime.set(0);
    this.endSilenceStreakSeconds = 0;
    this.prematureEndedRetryCount = 0;
    this.hasAudioStartedPlaying = false;
    this.hasRecordedCompletion = false;
    this.hasPreloadedNextTrack = false;

    const initialDuration = track.duration && track.duration > 0 ? track.duration : 0;
    this.duration.set(initialDuration);
    this.setupMediaSession();
    this.updateMediaSessionMetadata(track);

    // 1. Для оффлайн-треков получаем локальный blob URL ДО старта, исключая сброс и прерывание аудиопотока
    let playUrl = track.audioUrl;
    if (this.offlineService.isTrackOffline(track.id)) {
      const cachedBlobUrl = this.offlineService.getCachedBlobUrlSync(track.id);
      if (cachedBlobUrl) {
        playUrl = cachedBlobUrl;
      } else {
        const resolvedUrl = await this.offlineService.getOfflineBlobUrl(track.id);
        if (resolvedUrl && playRequestId === this.currentPlayRequestId) {
          playUrl = resolvedUrl;
        }
      }
    }

    if (playUrl && (playUrl.includes(':8052') || playUrl.includes('ep256.hostingradio.ru') || playUrl.includes('europaplus256.mp3') || playUrl.includes('streamr.ru') || playUrl.includes('hostingradio.ru:8014') || playUrl.includes('gkvr.ru'))) {
      const lower = (track.title || '').toLowerCase();
      if (lower.includes('дача') || lower.includes('dacha') || track.id.includes('default-11') || playUrl.includes('gkvr.ru')) {
        playUrl = 'https://stream.n340.com/14_dacha_64';
      } else {
        playUrl = (lower.includes('top 40') || track.id.includes('default-2') || playUrl.includes('top'))
          ? 'https://hls-01-regions.emgsound.ru/11_top40/playlist.m3u8'
          : 'https://hls-01-regions.emgsound.ru/11_msk/playlist.m3u8';
      }
    }

    // Discard stale request if a newer track was requested
    if (playRequestId !== this.currentPlayRequestId) {
      return;
    }

    if (!playUrl.startsWith('blob:')) {
      playUrl = this.formatStreamUrl(track);
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

    // Apply bit-perfect audio graph state according to track and user settings
    this.applyBitPerfectState();
    this.audio.loop = (this.repeatMode() === 'one');

    // Apply smooth immediate fade in
    this.applyFadeIn(0.12);

    // Arm startup watchdog: if node is blocked/stalling, trigger cluster failover in 3.8s!
    this.startStartupWatchdog(track, playRequestId);

    const playPromise = this.audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          this.isSwitchingTrack = false;
          if (playRequestId !== this.currentPlayRequestId) return;
          this.isPlaying.set(true);
          this.updateMediaSessionPlaybackState('playing');
          this.updateMediaSessionMetadata(track);
          this.updateMediaSessionPosition();
          this.libraryService.recordHistoryPlay(track);
          this.requestWakeLock();
          if (this.recService.isMixActive()) {
            this.ensureSmartQueue();
          }
        })
        .catch(async (err) => {
        this.clearStartupWatchdog();
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

        // Если попытка воспроизведения сорвалась на оффлайн blob URL: пробуем получить свежий blob URL или стримим без удаления кэша!
        if (playUrl.startsWith('blob:')) {
          console.warn('[AudioService] Offline blob playback transient failure, attempting fresh blob URL or online stream:', err);
          try {
            const freshUrl = await this.offlineService.getOfflineBlobUrl(track.id);
            if (freshUrl && playRequestId === this.currentPlayRequestId) {
              this.audio.src = freshUrl;
              await this.audio.play();
              this.isPlaying.set(true);
              this.updateMediaSessionPlaybackState('playing');
              return;
            }
          } catch {}
          this.playTrack({ ...track, isOffline: false }, undefined, fromMix, queueIndex);
          return;
        }

        console.warn('[AudioService] play() error:', err);
        this.handlePlaybackFailure('play_rejection');
      });
    } else {
      this.isSwitchingTrack = false;
      this.hasAudioStartedPlaying = true;
      this.isPlaying.set(true);
    }
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
      this.applyFadeIn(0.1);
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
    this.activeStreamAbortController?.abort();
    this.activeStreamAbortController = null;
    this.notifyNativeBridge(null, false);
    try {
      this.audio.pause();
      this.audio.currentTime = 0;
      this.audio.src = '';
    } catch {}
    if (this.preloadAudio) {
      try {
        this.preloadAudio.pause();
        this.preloadAudio.removeAttribute('src');
        this.preloadAudio.load();
      } catch {}
    }
    this.preloadedAudioUrl = null;
    this.lastPreloadedTrackId = null;
    this.preloadedNextTrack.set(null);
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

  seek(seconds: number, forceNetwork = false) {
    if (this.isLiveStream()) return;
    const total = this.duration() || this.currentTrack()?.duration || 0;
    const clamped = Math.max(0, Math.min(seconds, total > 0 ? total : seconds));

    const track = this.currentTrack();
    if (!track) return;

    // 1. If audio is playing from a local blob URL or direct static audio, seek natively without restarting stream
    if (!forceNetwork && (this.audio.src.startsWith('blob:') || !this.audio.src.includes('/api/stream'))) {
      try {
        this.audio.currentTime = clamped;
        this.currentTime.set(clamped);
        this.updateMediaSessionPosition();
        this.notifyNativeBridge(track, this.isPlaying());
      } catch {}
      return;
    }

    // 2. Fast In-Buffer Native Seeking (skipped when recovering from stream end/drop):
    if (!forceNetwork) {
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
    }

    // 3. Fast Stream Range Seek via backend with ss parameter:
    const baseStreamUrl = this.formatStreamUrl(track).split('&ss=')[0].split('&_t=')[0];
    const glue = baseStreamUrl.includes('?') ? '&' : '?';
    const ssParam = clamped > 0 ? `${glue}ss=${Math.round(clamped)}` : '';
    const tsParam = `${ssParam ? '&' : glue}_t=${Date.now()}`;
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
    try {
      const q = this.queue();
      if (q.length === 0) return;

      const cur = this.currentTrack();
      if (cur && this.currentTime() < 15 && !this.isLiveStream()) {
        this.recService.recordTrackSkip(cur);
      }

      let nextIdx = this.queueIndex() + 1;

      if (this.recService.isMixActive()) {
        const source = this.recService.mixConfig().source;
        const lang = this.recService.mixConfig().language;
        const mood = this.recService.currentMood();

        // Proactively replenish queue in background
        if (nextIdx >= this.queue().length - 4) {
          this.ensureSmartQueue().catch(() => {});
        }

        let updatedQ = this.queue();
        if (nextIdx >= updatedQ.length) {
          // Check buffered discoveries first
          const buffered = this.recService.getBufferedDiscoveries(lang, 4);
          if (buffered.length > 0) {
            this.queue.update((curQ) => [...curQ, ...buffered]);
            this.ensureSmartQueue().catch(() => {});
          } else {
            // Await queue replenishment so we genuinely load fresh discoveries
            await this.ensureSmartQueue();
          }
          updatedQ = this.queue();
        }

        if (nextIdx >= updatedQ.length) {
          // If queue is still empty (e.g. offline), grab unplayed starter candidates
          const cur = this.currentTrack();
          const playedIds = this.recService.getSessionPlayedIds();
          let starters = this.recService.getStarterCandidates(mood, 12, lang).filter(
            (t) => t.id !== cur?.id && !playedIds.has(t.id) && !this.recService.isLibraryTrack(t)
          );
          if (starters.length === 0) {
            starters = this.recService.getStarterCandidates(mood, 12, lang).filter(
              (t) => t.id !== cur?.id && !this.recService.isLibraryTrack(t)
            );
          }
          if (starters.length > 0) {
            // Pick a random starter, never loop starters[0]!
            const chosen = starters[Math.floor(Math.random() * starters.length)];
            this.queue.update((curQ) => [...curQ, chosen]);
            nextIdx = this.queue().length - 1;
          } else {
            nextIdx = Math.max(0, updatedQ.length - 1);
          }
        }
      } else {
        if (nextIdx >= q.length) {
          if (this.repeatMode() === 'all' && q.length > 0) {
            nextIdx = 0;
            if (this.isShuffle() && q.length > 1) {
              const reshuffled = this.shuffleArray(q);
              this.queue.set(reshuffled);
            }
          } else {
            // Бесконечное автовоспроизведение: если очередь закончилась (например, доиграли треки или играл 1 трек),
            // бесшовно подхватываем следующие похожие треки, которые могут понравиться пользователю,
            // И СТРОГО ИСКЛЮЧАЕМ ЛЮБЫЕ ТРЕКИ ИЗ ЕГО МЕДИАТЕКИ!
            const recentIds = new Set<string>(q.map((t) => t.id));
            const recentArtists = new Set<string>(q.slice(-4).map((t) => t.artist).filter(Boolean));
            const cur = this.currentTrack();

            let recs: Track[] = [];
            try {
              recs = await this.recService.fetchOnlineDiscoveryTracks(4, recentIds, recentArtists, cur || null);
            } catch (e) {
              console.warn('[AudioService] Failed to fetch discovery tracks for auto-advance:', e);
            }

            if (recs.length === 0 && cur && (cur.title || cur.artist)) {
              try {
                const similar = await this.libraryService.getSimilarTracks(cur.title, cur.artist, 8, cur.genre);
                recs = similar.filter((t) => !recentIds.has(t.id) && !this.libraryService.isDisliked(t) && !this.recService.isLibraryTrack(t));
              } catch (e) {
                console.warn('[AudioService] Failed to fetch online similar tracks for auto-advance:', e);
              }
            }

            if (recs.length === 0) {
              const mood = this.recService.currentMood();
              const lang = this.recService.mixConfig().language;
              const starters = this.recService.getStarterCandidates(mood, 6, lang);
              recs = starters.filter((t) => !recentIds.has(t.id) && !this.libraryService.isDisliked(t) && !this.recService.isLibraryTrack(t));
            }

            const pureRecs = recs.filter((t) => !this.recService.isLibraryTrack(t));

            if (pureRecs.length > 0) {
              this.queue.update((curQ) => [...curQ, ...pureRecs]);
            } else {
              nextIdx = 0;
            }
          }
        }
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
        this.preloadNextTrack();
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

    try {
      const q = this.queue();
      if (q.length === 0) return;

      let prevIdx = this.queueIndex() - 1;
      if (prevIdx < 0) {
        prevIdx = this.repeatMode() === 'all' ? q.length - 1 : 0;
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
    this.isSwitchingTrack = true;
    setTimeout(() => {
      this.isHandlingEnd = false;
      this.isFadingOut = false;
    }, 1000);

    if (this.repeatMode() === 'one') {
      if (this.audio) {
        this.audio.currentTime = 0;
        this.currentTime.set(0);
        this.audio.play().catch(() => {});
      }
      return;
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
    const nextVal = !this.isShuffle();
    this.isShuffle.set(nextVal);
    try {
      localStorage.setItem(this.STORAGE_KEY_SHUFFLE, String(nextVal));
    } catch {}

    const curQ = this.queue();
    const curTrack = this.currentTrack();
    const curIdx = this.queueIndex();

    if (nextVal) {
      if (curQ.length > 1) {
        if (this.originalQueue.length === 0) {
          this.originalQueue = [...curQ];
        }
        const history = curIdx > 0 ? curQ.slice(0, curIdx) : [];
        const current = curTrack ? [curTrack] : (curIdx >= 0 && curIdx < curQ.length ? [curQ[curIdx]] : []);
        const upcoming = curQ.slice(curIdx + 1);
        const shuffledUpcoming = this.shuffleArray(upcoming);

        const newQ = [...history, ...current, ...shuffledUpcoming];
        this.queue.set(newQ);
        this.queueIndex.set(history.length);
      }
      this.notifyUser('Случайный порядок включен');
    } else {
      if (this.originalQueue.length > 0) {
        const restored = [...this.originalQueue];
        this.queue.set(restored);
        if (curTrack) {
          const idx = restored.findIndex((t) => t.id === curTrack.id);
          this.queueIndex.set(idx >= 0 ? idx : 0);
        }
        this.originalQueue = [];
      }
      this.notifyUser('Случайный порядок выключен');
    }
  }

  cycleRepeat() {
    const modes: ('off' | 'one' | 'all')[] = ['off', 'one', 'all'];
    const current = this.repeatMode();
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    this.repeatMode.set(next);
    if (this.audio) {
      this.audio.loop = (next === 'one');
    }
    try {
      localStorage.setItem(this.STORAGE_KEY_REPEAT, next);
    } catch {}

    if (next === 'one') {
      this.notifyUser('Повтор текущего трека включен');
    } else if (next === 'all') {
      this.notifyUser('Повтор всей очереди включен');
    } else {
      this.notifyUser('Повтор выключен');
    }
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

  private initPreloadAudio() {
    if (this.preloadAudio || typeof document === 'undefined') return;
    try {
      this.preloadAudio = document.createElement('audio');
      this.preloadAudio.preload = 'auto';
      this.preloadAudio.muted = true;
      this.preloadAudio.volume = 0;
      this.preloadAudio.setAttribute('playsinline', 'true');
      this.preloadAudio.setAttribute('webkit-playsinline', 'true');
      this.preloadAudio.style.position = 'fixed';
      this.preloadAudio.style.top = '-9999px';
      this.preloadAudio.style.left = '-9999px';
      this.preloadAudio.style.width = '1px';
      this.preloadAudio.style.height = '1px';
      this.preloadAudio.style.opacity = '0.01';
      this.preloadAudio.style.pointerEvents = 'none';
      if (document.body) {
        document.body.appendChild(this.preloadAudio);
      }
    } catch {}
  }

  formatStreamUrl(track: Track): string {
    let playUrl = (track.audioUrl || '').trim();
    if (!playUrl || playUrl.startsWith('blob:')) return playUrl;
    let activeBase = typeof this.libraryService?.getDirectStreamNode === 'function'
      ? this.libraryService.getDirectStreamNode()
      : (typeof this.libraryService?.getBackendUrl === 'function' ? this.libraryService.getBackendUrl() : '');

    const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (isHttps) {
      if (activeBase.includes('node-home')) {
        activeBase = 'https://node-home.80.87.202.157.sslip.io';
      } else if (activeBase.includes('80.87.202.157')) {
        activeBase = 'https://recro.80.87.202.157.sslip.io';
      } else if (activeBase.includes('177.3.217.64')) {
        activeBase = 'https://recro.177.3.217.64.sslip.io';
      } else if (activeBase.startsWith('http://') && !activeBase.includes('localhost') && !activeBase.includes('127.0.0.1')) {
        activeBase = activeBase.replace(/^http:\/\//, 'https://');
      }
    }

    if (playUrl.includes('/api/stream')) {
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
      track.id.startsWith('radio-') ||
      track.id.startsWith('default-')
    ) {
      playUrl = `${activeBase}/api/stream?url=${encodeURIComponent(playUrl)}&is_live=true`;
    } else if (playUrl.startsWith('/')) {
      playUrl = `${activeBase}${playUrl}`;
    } else if (!playUrl.startsWith('http://') && !playUrl.startsWith('https://')) {
      playUrl = `${activeBase}/${playUrl}`;
    } else if (!playUrl.startsWith(activeBase)) {
      // External HTTP/HTTPS URLs (Deezer, VK, remote CDN) MUST be proxied through the backend
      // so browser CORS and hotlink protection never fail!
      playUrl = `${activeBase}/api/stream?url=${encodeURIComponent(playUrl)}`;
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
      if (!playUrl.includes('quality=') && this.audioQuality() !== 'auto') {
        const glue = playUrl.includes('?') ? '&' : '?';
        playUrl = `${playUrl}${glue}quality=${this.audioQuality()}`;
      }
      if (!playUrl.includes('id=') && track.id && !track.id.startsWith('default-') && !track.id.startsWith('radio-')) {
        const glue = playUrl.includes('?') ? '&' : '?';
        playUrl = `${playUrl}${glue}id=${encodeURIComponent(track.id)}`;
      }
    }
    return playUrl;
  }

  preloadNextTrack() {
    const q = this.queue();
    const idx = this.queueIndex();
    if (idx < 0 || idx >= q.length - 1) return;
    const nextTrack = q[idx + 1];
    if (!nextTrack || !nextTrack.audioUrl || nextTrack.id === this.lastPreloadedTrackId) return;
    this.lastPreloadedTrackId = nextTrack.id;
    this.preloadedNextTrack.set(nextTrack);

    // 1. Preload next track's cover image in background memory so when switched, it renders with 0ms delay!
    if (typeof window !== 'undefined') {
      const coverUrl = this.libraryService.formatCoverUrl(nextTrack.coverUrl, nextTrack.title, nextTrack.artist);
      if (coverUrl) {
        const preImg = new Image();
        preImg.decoding = 'async';
        preImg.src = coverUrl;
      }
    }

    // 2. Для оффлайн-трека: заранее подготавливаем и кэшируем Blob URL в памяти
    if (this.offlineService.isTrackOffline(nextTrack.id)) {
      this.offlineService.getOfflineBlobUrl(nextTrack.id).then((blobUrl) => {
        if (blobUrl) {
          this.initPreloadAudio();
          if (this.preloadAudio && this.preloadedAudioUrl !== blobUrl) {
            this.preloadedAudioUrl = blobUrl;
            try {
              this.preloadAudio.src = blobUrl;
              this.preloadAudio.load();
            } catch {}
          }
        }
      }).catch(() => {});
      return;
    }

    if (nextTrack.audioUrl.startsWith('blob:') || nextTrack.isLiveStream) return;

    const targetUrl = this.formatStreamUrl(nextTrack);

    // 3. Low priority prefetch to warm backend cache without opening a competing stream connection
    if (targetUrl.includes('/api/stream')) {
      const glue = targetUrl.includes('?') ? '&' : '?';
      const prefetchUrl = `${targetUrl}${glue}prefetch=true`;
      try {
        fetch(prefetchUrl, { priority: 'low' as any }).catch(() => {});
      } catch {}
    }
  }

  private bufferIntoPreloadAudio(_targetUrl: string) {
    // No-op: do not open concurrent stream downloads that compete for bandwidth with the active player
  }

  prewarmTracks(_tracks: Track[]) {
    // No-op: do not flood server CPU or client connection pool with speculative stream downloads
  }

  /**
   * Prewarms the best matching starter track for "Моя Волна" immediately upon app entry / offline detection.
   * Resolves offline Blob URLs, warms backend cache with prefetch=true, pre-buffers first 384KB via Range,
   * primes the browser audio element and preloads cover art so playback starts with 0ms latency!
   */
  async prewarmSmartWaveStarter(mood: MixMood = this.recService.currentMood()): Promise<Track | null> {
    if (this.isPlaying() || this.isSwitchingTrack) {
      return this.prewarmedWaveTrack();
    }
    if (this.isPrewarmingWave()) {
      return this.prewarmedWaveTrack();
    }

    this.isPrewarmingWave.set(true);
    try {
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      const offlineTracks = (typeof this.offlineService?.getOfflineTracks === 'function' ? this.offlineService.getOfflineTracks() : []).filter(
        (t) => !this.recService.isDisliked(t.id) && !this.libraryService.isDisliked(t)
      );

      let starter: Track | null = null;

      // 1. Offline Mode: Look through cached offline storage for a diverse personalized starter
      if (isOffline || (offlineTracks.length > 0 && typeof navigator !== 'undefined' && !navigator.onLine)) {
        if (offlineTracks.length > 0) {
          let pool = offlineTracks.filter((t) => this.recService.doesTrackMatchMood(t, mood));
          if (pool.length === 0) pool = offlineTracks;

          const nonRecent = pool.filter((t) =>
            !this.recService.isRecentStarter(t, 15) &&
            !this.recService.isRecentStarterArtist(t.artist, 6) &&
            !this.recService.isRecentlyPlayed(t, 60)
          );
          const candidatePool = nonRecent.length > 0 ? nonRecent : pool.filter((t) => !this.recService.isRecentStarter(t, 2));
          const finalPool = candidatePool.length > 0 ? candidatePool : pool;

          const shuffled = [...finalPool];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          starter = shuffled[0] || null;
        }
      }

      // 2. Online Mode: Intelligently pick a diverse starter track
      if (!starter && (!isOffline || offlineTracks.length === 0)) {
        const effectiveLang = this.recService.getEffectiveLanguage(null);
        starter = this.recService.pickDiverseStarterTrack(mood, effectiveLang);

        const currentSource = this.recService.mixConfig().source;
        if (currentSource === 'discovery_heavy' && starter && this.recService.isLibraryTrack(starter)) {
          starter = null;
        }

        if (!starter) {
          const starters = this.recService.getStarterCandidates(mood, 8, effectiveLang)
            .filter((t) => !this.recService.isLibraryTrack(t) && !this.recService.isRecentStarter(t, 5));
          if (starters.length > 0) {
            starter = starters[Math.floor(Math.random() * starters.length)] || null;
          }
        }

        if (!starter && offlineTracks.length > 0) {
          const shuffled = [...offlineTracks];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          starter = shuffled[0] || null;
        }
      }

      if (!starter) {
        return null;
      }

      // 3. Process / Pre-buffer the track so the user does not wait the first seconds!
      let preparedStarter: Track = { ...starter };

      // Case A: Track is offline in IndexedDB
      if (this.offlineService.isTrackOffline(starter.id) || starter.isOffline) {
        const blobUrl = await this.offlineService.getOfflineBlobUrl(starter.id);
        if (blobUrl) {
          preparedStarter = { ...preparedStarter, audioUrl: blobUrl, isOffline: true };
          this.initPreloadAudio();
          if (this.preloadAudio && this.preloadedAudioUrl !== blobUrl) {
            this.preloadedAudioUrl = blobUrl;
            try {
              this.preloadAudio.src = blobUrl;
              this.preloadAudio.load();
            } catch {}
          }
        }
      } else if (!starter.audioUrl.startsWith('blob:') && !starter.isLiveStream) {
        // Case B: Online stream track
        const targetUrl = this.formatStreamUrl(starter);

        // Low priority prefetch to warm backend FFmpeg transcode & disk cache
        if (targetUrl.includes('/api/stream')) {
          const glue = targetUrl.includes('?') ? '&' : '?';
          try {
            fetch(`${targetUrl}${glue}prefetch=true`, { priority: 'low' as any }).catch(() => {});
          } catch {}

          // Range request to warm first 384 KB in browser HTTP cache
          try {
            fetch(targetUrl, {
              headers: { Range: 'bytes=0-393215' },
              mode: 'cors',
              priority: 'low' as any,
            }).catch(() => {});
          } catch {}
        }
      }

      // Pre-cache cover art in memory
      if (typeof window !== 'undefined') {
        const coverUrl = typeof this.libraryService?.formatCoverUrl === 'function'
          ? this.libraryService.formatCoverUrl(preparedStarter.coverUrl, preparedStarter.title, preparedStarter.artist)
          : preparedStarter.coverUrl;
        if (coverUrl) {
          const img = new Image();
          img.decoding = 'async';
          img.src = coverUrl;
        }
      }

      this.prewarmedWaveTrack.set(preparedStarter);
      return preparedStarter;
    } finally {
      this.isPrewarmingWave.set(false);
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
    // Keep a buffer of upcoming tracks, don't spam requests when we already have >= 4 upcoming tracks!
    if (upcomingCount >= 4) return;

    const needed = Math.max(4, 6 - upcomingCount);

    // Exclude unplayed upcoming tracks AND all tracks played during this active session
    const unplayedUpcoming = q.slice(Math.max(0, idx));
    const recentPlayedFromQueue = q.slice(0, idx);
    const excludeIds = new Set<string>([
      ...unplayedUpcoming.map((t) => t.id),
      ...recentPlayedFromQueue.map((t) => t.id),
      ...this.recService.getSessionPlayedIds(),
    ]);

    // Build context artists from queue surroundings (last 6 queued/played tracks)
    const contextSlice = q.slice(Math.max(0, idx - 4), q.length);
    const recentArtists = new Set<string>();
    for (const t of contextSlice) {
      if (t.artist) {
        for (const a of extractAllArtists(t.artist, t.title)) {
          const normA = normalizeArtist(a);
          if (normA) recentArtists.add(normA);
        }
      }
    }

    const source = this.recService.mixConfig().source;
    const mood = this.recService.currentMood();
    const localCandidates = this.recService.getAllLocalCandidates();
    const curTrack = q[idx] || this.currentTrack() || null;
    const effectiveLang = this.recService.getEffectiveLanguage(curTrack);
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (isOffline) {
      const offlineTracks = (typeof this.offlineService?.getOfflineTracks === 'function' ? this.offlineService.getOfflineTracks() : []).filter(
        (t) => !excludeIds.has(t.id) && !this.recService.isDisliked(t.id) && !this.libraryService.isDisliked(t)
      );
      if (offlineTracks.length > 0) {
        let pool = offlineTracks.filter((t) => this.recService.doesTrackMatchMood(t, mood));
        if (pool.length === 0) pool = offlineTracks;
        if (pool.length > 0) {
          this.queue.update((curQ) => [...curQ, ...pool.slice(0, needed)]);
          this.preloadNextTrack();
        }
      }
      return;
    }

    let newTracks: Track[] = [];

    if (source === 'library_only' && localCandidates.length > 0) {
      newTracks = this.recService.pickNextTracks(needed, excludeIds, curTrack, recentArtists);
    } else if (source === 'balanced' && localCandidates.length > 0) {
      // Balanced: Adaptive library/discovery ratio based on library size.
      // Small libraries (< 8 unique artists) get fewer library tracks to prevent repetitive cycling.
      const uniqueLibraryArtists = new Set(
        localCandidates.map((t) => normalizeArtist(t.artist)).filter(Boolean)
      );
      const isSmallLibrary = uniqueLibraryArtists.size < 8;

      // Small library: max 1 library track per ~5 discoveries (20%)
      // Normal library: 1 library track per 2 discoveries (33%)
      const libraryCount = isSmallLibrary
        ? (Math.random() < 0.20 ? 1 : 0)
        : Math.max(1, Math.floor(needed / 3));
      const discoveryCount = Math.max(2, needed - libraryCount);

      let libTracks: Track[] = [];
      if (libraryCount > 0) {
        libTracks = this.recService.pickNextTracks(libraryCount, excludeIds, curTrack, recentArtists);
        libTracks.forEach((t) => {
          excludeIds.add(t.id);
          if (t.artist) {
            for (const a of extractAllArtists(t.artist, t.title)) {
              const normA = normalizeArtist(a);
              if (normA) recentArtists.add(normA);
            }
          }
        });
      }

      const discovery = await this.recService.fetchOnlineDiscoveryTracks(discoveryCount, excludeIds, recentArtists, curTrack);
      const pureDiscovery = discovery.filter((d) => !this.recService.isLibraryTrack(d));
      pureDiscovery.forEach((d) => {
        excludeIds.add(d.id);
        if (d.artist) {
          for (const a of extractAllArtists(d.artist, d.title)) {
            const normA = normalizeArtist(a);
            if (normA) recentArtists.add(normA);
          }
        }
      });

      // Interleave discovery and library tracks
      let libIdx = 0;
      let discIdx = 0;
      while (libIdx < libTracks.length || discIdx < pureDiscovery.length) {
        if (discIdx < pureDiscovery.length) newTracks.push(pureDiscovery[discIdx++]);
        if (discIdx < pureDiscovery.length) newTracks.push(pureDiscovery[discIdx++]);
        if (libIdx < libTracks.length) newTracks.push(libTracks[libIdx++]);
      }
    } else {
      // Discovery Wave: strictly new online discovery tracks calibrated against user's library taste!
      const discovery = await this.recService.fetchOnlineDiscoveryTracks(needed, excludeIds, recentArtists, curTrack);
      const pureDiscovery = discovery.filter((d) => !this.recService.isLibraryTrack(d));
      newTracks.push(...pureDiscovery);
      pureDiscovery.forEach((d) => {
        excludeIds.add(d.id);
        if (d.artist) {
          for (const a of extractAllArtists(d.artist, d.title)) {
            const normA = normalizeArtist(a);
            if (normA) recentArtists.add(normA);
          }
        }
      });
    }

    if (newTracks.length === 0) {
      const starters = this.recService.getStarterCandidates(mood, needed * 3, effectiveLang);
      const freshStarters = starters.filter(
        (t) => !excludeIds.has(t.id) && !this.recService.isSessionDuplicate(t) && !this.recService.isLibraryTrack(t)
      );
      if (freshStarters.length > 0) {
        newTracks = freshStarters.slice(0, needed);
      }
    }

    const existingQueueIds = new Set(q.map((t) => t.id));
    const strictlyUniqueTracks: Track[] = [];

    // Pass 1: Strict artist diversity
    for (const t of newTracks) {
      if (existingQueueIds.has(t.id)) continue;
      if (this.recService.isSessionDuplicate(t)) continue;
      if (source === 'discovery_heavy' && this.recService.isLibraryTrack(t)) continue;
      if (!isTrackLanguageMatch(t, effectiveLang)) continue;

      const candArtists = extractAllArtists(t.artist, t.title).map((a) => normalizeArtist(a));
      if (candArtists.some((a) => a && recentArtists.has(a))) {
        continue;
      }

      strictlyUniqueTracks.push(t);
      existingQueueIds.add(t.id);
      for (const a of candArtists) {
        if (a) recentArtists.add(a);
      }
    }

    // Pass 2: If strict artist spacing filtered too aggressively, accept remaining unique discoveries
    if (strictlyUniqueTracks.length === 0) {
      for (const t of newTracks) {
        if (existingQueueIds.has(t.id)) continue;
        if (this.recService.isSessionDuplicate(t)) continue;
        if (source === 'discovery_heavy' && this.recService.isLibraryTrack(t)) continue;
        if (!isTrackLanguageMatch(t, effectiveLang)) continue;

        strictlyUniqueTracks.push(t);
        existingQueueIds.add(t.id);
        if (strictlyUniqueTracks.length >= 2) break;
      }
    }

    if (strictlyUniqueTracks.length > 0) {
      this.queue.update((curQ) => [...curQ, ...strictlyUniqueTracks]);
      this.preloadNextTrack();

      if (typeof window !== 'undefined') {
        for (const t of strictlyUniqueTracks.slice(0, 3)) {
          const u = this.libraryService.formatCoverUrl(t.coverUrl, t.title, t.artist);
          if (u) {
            const preImg = new Image();
            preImg.decoding = 'async';
            preImg.src = u;
          }
        }
      }
    }
  }

  async startSmartMix(mood: MixMood = this.recService.currentMood()): Promise<boolean> {
    this.recService.isMixActive.set(true);
    this.recService.setMixMood(mood);

    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    const offlineTracks = (typeof this.offlineService?.getOfflineTracks === 'function' ? this.offlineService.getOfflineTracks() : []).filter(
      (t) => !this.recService.isDisliked(t.id) && !this.libraryService.isDisliked(t)
    );

    // 1. Instant 0ms playback: check if prewarmed wave starter is ready in memory/cache
    const prewarmed = this.prewarmedWaveTrack();
    const currentMixSource = this.recService.mixConfig().source;
    if (prewarmed) {
      const isMoodMatch = mood === 'all' || this.recService.doesTrackMatchMood(prewarmed, mood);
      const isNotDisliked = !this.recService.isDisliked(prewarmed.id) && !this.libraryService.isDisliked(prewarmed);
      const isNotRecentStarter = !this.recService.isRecentStarter(prewarmed, 5);
      const isNotLibraryWhenDiscovery = currentMixSource !== 'discovery_heavy' || !this.recService.isLibraryTrack(prewarmed);
      if (isMoodMatch && isNotDisliked && isNotRecentStarter && isNotLibraryWhenDiscovery) {
        this.prewarmedWaveTrack.set(null);
        this.recService.recordStarterUsed(prewarmed);

        let initialTracks: Track[] = [prewarmed];
        if (isOffline) {
          const offlineRemaining = offlineTracks.filter((t) => t.id !== prewarmed.id);
          initialTracks = [prewarmed, ...offlineRemaining.slice(0, 5)];
        } else {
          const effectiveLang = this.recService.getEffectiveLanguage(prewarmed);
          const buffered = this.recService.getBufferedDiscoveries(effectiveLang, 4)
            .filter((t) => t.id !== prewarmed.id && !this.recService.isLibraryTrack(t));
          initialTracks = [prewarmed, ...buffered];
        }

        this.playTrack(prewarmed, initialTracks, true, 0);
        this.preloadNextTrack();
        this.ensureSmartQueue().catch(() => {});
        return true;
      } else {
        this.prewarmedWaveTrack.set(null);
      }
    }

    // 2. Offline fallback: Start immediately from saved offline tracks without waiting for network
    if (isOffline && offlineTracks.length > 0) {
      let pool = offlineTracks.filter((t) => this.recService.doesTrackMatchMood(t, mood));
      if (pool.length === 0) pool = offlineTracks;

      const nonRecent = pool.filter((t) =>
        !this.recService.isRecentStarter(t, 15) &&
        !this.recService.isRecentStarterArtist(t.artist, 6) &&
        !this.recService.isRecentlyPlayed(t, 60)
      );
      const candidatePool = nonRecent.length > 0 ? nonRecent : pool.filter((t) => !this.recService.isRecentStarter(t, 2));
      const finalPool = candidatePool.length > 0 ? candidatePool : pool;
      const shuffled = [...finalPool];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const starter = shuffled[0];
      this.recService.recordStarterUsed(starter);

      const blobUrl = await this.offlineService.getOfflineBlobUrl(starter.id);
      const preparedStarter = blobUrl ? { ...starter, audioUrl: blobUrl, isOffline: true } : starter;
      const remainingPool = pool.filter((t) => t.id !== starter.id);
      const initialTracks = [preparedStarter, ...remainingPool.slice(0, 5)];

      this.playTrack(preparedStarter, initialTracks, true, 0);
      this.preloadNextTrack();
      return true;
    }

    const source = this.recService.mixConfig().source;
    const curTrack = this.currentTrack() || null;
    const effectiveLang = this.recService.getEffectiveLanguage(curTrack);
    const candidates = this.recService.getAllLocalCandidates();

    let initialTracks: Track[] = [];

    // Dynamically pick a diverse starter track that has NOT been played or started recently!
    let starter = this.recService.pickDiverseStarterTrack(mood, effectiveLang);
    if (source === 'discovery_heavy' && starter && this.recService.isLibraryTrack(starter)) {
      starter = null;
    }

    if (starter) {
      this.recService.recordStarterUsed(starter);
      initialTracks.push(starter);

      if (source === 'library_only') {
        const nextLib = this.recService.pickNextTracks(5, new Set([starter.id]), starter);
        initialTracks.push(...nextLib);
      } else {
        let discoveries = this.recService.getBufferedDiscoveries(effectiveLang, 4)
          .filter((t) => t.id !== starter.id && !this.recService.isLibraryTrack(t));
        if (discoveries.length === 0) {
          const exclude = new Set<string>([starter.id]);
          const fetched = await this.recService.fetchOnlineDiscoveryTracks(4, exclude, new Set(), starter);
          discoveries = fetched.filter((t) => !this.recService.isLibraryTrack(t));
        }
        initialTracks.push(...discoveries);
      }
    } else {
      // Emergency online discovery
      let discoveryTracks = this.recService.getBufferedDiscoveries(effectiveLang, 5)
        .filter((t) => !this.recService.isLibraryTrack(t));

      if (discoveryTracks.length === 0) {
        if (candidates.length > 0) {
          const fetched = await this.recService.fetchOnlineDiscoveryTracks(5, new Set(), new Set(), null);
          discoveryTracks = fetched.filter((t) => !this.recService.isLibraryTrack(t));
        } else {
          const starters = this.recService.getStarterCandidates(mood, 6, effectiveLang)
            .filter((t) => !this.recService.isLibraryTrack(t) && !this.recService.isSessionDuplicate(t));
          if (starters.length > 0) {
            discoveryTracks = starters.slice(0, 4);
          }
        }
      }

      if (discoveryTracks.length > 0) {
        const randIdx = Math.floor(Math.random() * discoveryTracks.length);
        const first = discoveryTracks[randIdx];
        this.recService.recordStarterUsed(first);
        const rest = discoveryTracks.filter((t) => t.id !== first.id);
        initialTracks = [first, ...rest];
      }
    }

    if (initialTracks.length > 0) {
      const immediateTrack = initialTracks[0];
      this.playTrack(immediateTrack, initialTracks, true, 0);
      this.preloadNextTrack();
      this.ensureSmartQueue().catch(() => {});
      return true;
    }

    // Absolute fallback
    const fetched = await this.recService.fetchOnlineDiscoveryTracks(5, new Set(), new Set(), null);
    const pureFetched = fetched.filter((t) => !this.recService.isLibraryTrack(t));
    if (pureFetched.length > 0) {
      const randIdx = Math.floor(Math.random() * pureFetched.length);
      const first = pureFetched[randIdx];
      this.recService.recordStarterUsed(first);
      const rest = pureFetched.filter((t) => t.id !== first.id);
      const fallbackQueue = [first, ...rest];
      this.playTrack(first, fallbackQueue, true, 0);
      this.preloadNextTrack();
      this.ensureSmartQueue().catch(() => {});
      return true;
    }

    this.recService.isMixActive.set(false);
    return false;
  }

  stopSmartMix() {
    this.recService.isMixActive.set(false);
  }

  setMixMood(mood: MixMood) {
    this.recService.clearDiscoveryBuffer();
    this.recService.setMixMood(mood);
    if (this.recService.isMixActive()) {
      const cur = this.currentTrack();
      const curMatchesMood = cur ? this.recService.doesTrackMatchMood(cur, mood) : false;
      const curIsLibrary = cur ? this.recService.isLibraryTrack(cur) : false;

      // If current track violates new mood or is a library track, immediately jump to a fresh matching starter!
      if (!curMatchesMood || curIsLibrary) {
        this.queue.set([]);
        this.queueIndex.set(0);
        this.startSmartMix(mood).catch(() => {});
      } else {
        const q = this.queue();
        const idx = this.queueIndex();
        const played = q.slice(0, idx + 1);
        this.queue.set(played);
        this.ensureSmartQueue().catch(() => {});
      }
    } else {
      this.prewarmSmartWaveStarter(mood).catch(() => {});
    }
  }

  async applyMixFilterChange(): Promise<void> {
    if (!this.recService.isMixActive()) return;

    this.recService.clearDiscoveryBuffer();
    const cur = this.currentTrack();
    const effectiveLang = this.recService.getEffectiveLanguage(cur);

    const curMatchesLang = !cur || isTrackLanguageMatch(cur, effectiveLang);
    const curIsLibrary = cur ? this.recService.isLibraryTrack(cur) : false;

    if (!curMatchesLang || curIsLibrary) {
      this.queue.set([]);
      this.queueIndex.set(0);
      await this.startSmartMix(this.recService.currentMood());
    } else {
      const q = this.queue();
      const idx = this.queueIndex();
      const played = q.slice(0, idx + 1);
      this.queue.set(played);
      await this.ensureSmartQueue();
    }
  }

  updateTrackFavoriteStatus(trackId: string, isFavorite: boolean, trackObj?: Track) {
    if (!trackId) return;
    const cur = this.currentTrack();
    if (cur && cur.id === trackId) {
      this.currentTrack.set({ ...cur, isFavorite });
    }
    this.queue.update((q) =>
      q.map((t) => (t.id === trackId ? { ...t, isFavorite } : t))
    );
  }

  dislikeTrack(track: Track) {
    if (!track) return;
    this.recService.dislikeTrack(track);
    this.libraryService.dislikeTrack(track);

    if (this.currentTrack()?.id === track.id) {
      this.next().then(() => {
        this.queue.update((q) => q.filter((t) => t.id !== track.id));
        const curIdx = this.queue().findIndex((t) => t.id === this.currentTrack()?.id);
        if (curIdx >= 0) this.queueIndex.set(curIdx);
      });
    } else {
      const dislikedIdx = this.queue().findIndex((t) => t.id === track.id);
      this.queue.update((q) => q.filter((t) => t.id !== track.id));
      if (dislikedIdx >= 0 && dislikedIdx < this.queueIndex()) {
        this.queueIndex.update((idx) => Math.max(0, idx - 1));
      }
    }
  }

  dislikeCurrentTrack() {
    const cur = this.currentTrack();
    if (!cur) return;
    this.dislikeTrack(cur);
  }
}
