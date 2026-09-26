import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  AfterViewInit,
  input,
  signal,
  inject,
  HostListener,
  ViewEncapsulation,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AudioService } from '../../services/audio.service';
import { LibraryService } from '../../services/library.service';
import { LyricsService } from '../../services/lyrics.service';

export type VisualizerType = 'bars' | 'wave' | 'circle' | 'lyrics';
export type VisualizerTheme = 'mono' | 'green' | 'album';

@Component({
  selector: 'app-visualizer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './visualizer.component.html',
  styleUrl: './visualizer.component.scss',
  encapsulation: ViewEncapsulation.None,
})
export class VisualizerComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly audioService = inject(AudioService);
  readonly libraryService = inject(LibraryService);
  readonly lyricsService = inject(LyricsService);

  readonly mode = input<'mini' | 'full'>('full');

  @ViewChild('visCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('visualizerContainer') containerRef?: ElementRef<HTMLDivElement>;
  @ViewChild('visLyricsBox') visLyricsBox?: ElementRef<HTMLDivElement>;

  readonly visualType = signal<VisualizerType>('bars');
  readonly colorTheme = signal<VisualizerTheme>('album');
  readonly sensitivity = signal<number>(1.2);
  readonly isFullscreen = signal<boolean>(false);
  readonly circleDiameter = signal<number>(220);
  readonly circleScale = signal<number>(1);

  // Динамически извлекаемый доминирующий цвет альбома
  readonly albumColor = signal<{ primary: string; secondary: string; glow: string; peak: string }>({
    primary: '#ffffff',
    secondary: '#3f3f46',
    glow: 'rgba(255, 255, 255, 0.4)',
    peak: '#ffffff',
  });

  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private smoothedPulse = 0;
  private roadOffset = 0;
  private lastTrackCover: string | null = null;

  private readonly bufferLength = 128;
  private readonly freqData = new Uint8Array(this.bufferLength);
  private readonly timeData = new Uint8Array(this.bufferLength);

  private peakCaps: number[] = [];
  private capHoldFrames: number[] = [];
  private zeroDataStreak = 0;
  private syntheticPhase = 0;

  ngOnInit() {
    this.peakCaps = new Array(this.bufferLength).fill(0);
    this.capHoldFrames = new Array(this.bufferLength).fill(0);

    const cur = this.audioService.currentTrack();
    if (cur?.coverUrl) {
      this.extractAlbumColor(cur.coverUrl);
    }
  }

  ngAfterViewInit() {
    this.setupResizeObserver();
    this.startRenderLoop();
  }

  ngOnDestroy() {
    this.stopRenderLoop();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    if (this.mode() === 'full' && this.audioService.isVisualizerOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'f' || event.key === 'F' || event.key === 'а' || event.key === 'А') {
        event.preventDefault();
        this.toggleFullscreen();
      } else if (event.key === '1') {
        this.setVisualType('bars');
      } else if (event.key === '2') {
        this.setVisualType('wave');
      } else if (event.key === '3') {
        this.setVisualType('circle');
      } else if (event.key === '4') {
        this.setVisualType('lyrics');
      }
    }
  }

  setVisualType(type: VisualizerType) {
    this.visualType.set(type);
  }

  setColorTheme(theme: VisualizerTheme) {
    this.colorTheme.set(theme);
  }

  private extractAlbumColor(coverUrl: string) {
    if (!coverUrl || typeof window === 'undefined') return;
    this.lastTrackCover = coverUrl;

    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const cvs = document.createElement('canvas');
        cvs.width = 24;
        cvs.height = 24;
        const ctx = cvs.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;

        let bestR = 255, bestG = 255, bestB = 255;
        let maxSat = 0;
        let avgR = 0, avgG = 0, avgB = 0, count = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const brightness = (r + g + b) / 3;

          if (brightness > 30 && brightness < 235) {
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;

            if (sat > maxSat) {
              maxSat = sat;
              bestR = r;
              bestG = g;
              bestB = b;
            }

            avgR += r;
            avgG += g;
            avgB += b;
            count++;
          }
        }

        const fR = maxSat > 0.2 ? bestR : (count > 0 ? Math.round(avgR / count) : 255);
        const fG = maxSat > 0.2 ? bestG : (count > 0 ? Math.round(avgG / count) : 255);
        const fB = maxSat > 0.2 ? bestB : (count > 0 ? Math.round(avgB / count) : 255);

        this.albumColor.set({
          primary: `rgb(${fR}, ${fG}, ${fB})`,
          secondary: `rgba(${fR}, ${fG}, ${fB}, 0.25)`,
          glow: `rgba(${fR}, ${fG}, ${fB}, 0.6)`,
          peak: `rgb(${Math.min(255, fR + 60)}, ${Math.min(255, fG + 60)}, ${Math.min(255, fB + 60)})`,
        });
      } catch {}
    };
    img.src = coverUrl;
  }

  close() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    this.audioService.closeVisualizer();
  }

  toggleFullscreen() {
    if (!this.containerRef) return;
    const el = this.containerRef.nativeElement;

    if (!document.fullscreenElement) {
      el.requestFullscreen()
        .then(() => this.isFullscreen.set(true))
        .catch(() => {});
    } else {
      document.exitFullscreen()
        .then(() => this.isFullscreen.set(false))
        .catch(() => {});
    }
  }

  private setupResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this.canvasRef) return;
    this.resizeObserver = new ResizeObserver(() => {
      this.adjustCanvasResolution();
    });
    this.resizeObserver.observe(this.canvasRef.nativeElement);
  }

  private adjustCanvasResolution() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private startRenderLoop() {
    const render = () => {
      this.draw();
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.animationFrameId = requestAnimationFrame(render);
  }

  private stopRenderLoop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private getThemeColors(ctx: CanvasRenderingContext2D, height: number): {
    primary: string;
    secondary: string;
    glow: string;
    gradient: string;
    peak: string;
  } {
    const theme = this.colorTheme();

    if (theme === 'album') {
      const alb = this.albumColor();
      return {
        primary: alb.primary,
        secondary: alb.secondary,
        glow: alb.glow,
        gradient: alb.primary,
        peak: alb.peak,
      };
    }

    if (theme === 'green') {
      return {
        primary: '#22c55e',
        secondary: '#3f3f46',
        glow: 'rgba(34, 197, 94, 0.4)',
        gradient: '#22c55e',
        peak: '#fafafa',
      };
    }

    return {
      primary: '#fafafa',
      secondary: '#3f3f46',
      glow: 'rgba(255, 255, 255, 0.3)',
      gradient: '#e4e4e7',
      peak: '#ffffff',
    };
  }

  private draw() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    // Автоматическое обновление цвета альбома при смене трека
    const curTrack = this.audioService.currentTrack();
    if (curTrack && curTrack.coverUrl && curTrack.coverUrl !== this.lastTrackCover) {
      this.extractAlbumColor(curTrack.coverUrl);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.adjustCanvasResolution();

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const isPlaying = this.audioService.isPlaying();
    const hasData = this.audioService.getAudioFrequencyData(this.freqData);
    if (hasData) {
      this.audioService.getAudioTimeDomainData(this.timeData);
    }

    // Check if frequency data is active or zero
    let sum = 0;
    for (let i = 0; i < 32; i++) {
      sum += this.freqData[i];
    }
    const avg = sum / 32;

    if (isPlaying && avg < 3) {
      this.zeroDataStreak++;
    } else {
      this.zeroDataStreak = 0;
    }

    // Organic procedural fallback if playing but audio stream CORS prevented analyser access
    if (isPlaying && this.zeroDataStreak > 10) {
      this.syntheticPhase += 0.05;
      const t = this.syntheticPhase;
      for (let i = 0; i < this.bufferLength; i++) {
        const falloff = Math.max(0.1, 1 - (i / this.bufferLength) * 0.85);
        const bass = Math.sin(t * 2.5 + i * 0.2) * 45 + 50;
        const rhythm = Math.cos(t * 1.2 - i * 0.15) * 35;
        const val = Math.max(0, Math.min(255, (bass + rhythm) * falloff * 1.5));
        // Soft smoothing
        this.freqData[i] = Math.round(this.freqData[i] * 0.7 + val * 0.3);
        this.timeData[i] = Math.round(128 + Math.sin(t * 3 + (i / this.bufferLength) * Math.PI * 4) * (val * 0.4));
      }
    } else if (!isPlaying) {
      // Gentle decay to 0 when paused
      for (let i = 0; i < this.bufferLength; i++) {
        this.freqData[i] = Math.max(0, this.freqData[i] - 6);
        this.timeData[i] = Math.round(128 + (this.timeData[i] - 128) * 0.85);
      }
    }

    const type = this.mode() === 'mini' ? 'bars' : this.visualType();

    if (type === 'bars') {
      this.drawBars(ctx, w, h);
    } else if (type === 'wave') {
      this.drawWaveform(ctx, w, h);
    } else if (type === 'circle') {
      this.drawCircle(ctx, w, h);
    } else if (type === 'lyrics') {
      this.drawLyricsWave(ctx, w, h);
      this.autoScrollVisualizerLyrics();
    }
  }

  private lastActiveLyricsIndex = -1;

  /**
   * Плавный автоскролл текста караоке по центру экрана в визуализаторе при смене строки
   */
  private autoScrollVisualizerLyrics() {
    const activeIdx = this.lyricsService.activeLineIndex();
    if (activeIdx === this.lastActiveLyricsIndex || activeIdx < 0 || !this.visLyricsBox) return;
    this.lastActiveLyricsIndex = activeIdx;

    const box = this.visLyricsBox.nativeElement;
    const activeEl = box.querySelector(`[data-line-index="${activeIdx}"]`) as HTMLElement;
    if (activeEl) {
      const targetTop = activeEl.offsetTop - box.clientHeight / 2 + activeEl.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }

  /**
   * Отрисовка фонового звукового эквалайзера в режиме караоке-текста
   */
  private drawLyricsWave(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const colors = this.getThemeColors(ctx, h);
    const sens = this.sensitivity();
    const numBars = Math.min(64, Math.floor(w / 14));
    const barWidth = (w / numBars) * 0.65;
    const gap = (w / numBars) * 0.35;
    const step = Math.max(1, Math.floor(this.bufferLength / numBars));

    ctx.save();
    ctx.fillStyle = colors.glow || 'rgba(255, 255, 255, 0.18)';

    for (let i = 0; i < numBars; i++) {
      const dataIdx = Math.min(this.bufferLength - 1, i * step);
      const val = Math.min(1.0, (this.freqData[dataIdx] / 255) * sens);
      const barHeight = Math.max(3, val * (h * 0.16));
      const x = i * (barWidth + gap) + gap / 2;
      const y = h - barHeight;

      ctx.fillRect(x, y, barWidth, barHeight);
    }
    ctx.restore();
  }

  private drawBars(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const isMini = this.mode() === 'mini';
    const numBars = isMini ? 24 : 54;
    const colors = this.getThemeColors(ctx, h);
    const sens = this.sensitivity();

    const barWidth = Math.max(2, (w / numBars) * (isMini ? 0.65 : 0.72));
    const gap = (w - numBars * barWidth) / (numBars + 1);

    const step = Math.max(1, Math.floor(this.bufferLength / numBars));

    for (let i = 0; i < numBars; i++) {
      const dataIdx = Math.min(this.bufferLength - 1, i * step);
      let value = (this.freqData[dataIdx] / 255) * sens;
      value = Math.min(1.0, value);

      const barHeight = Math.max(isMini ? 2 : 4, value * (h * 0.88));
      const x = gap + i * (barWidth + gap);
      const y = h - barHeight;

      // Peak Cap Logic
      if (this.peakCaps[i] === undefined) {
        this.peakCaps[i] = 0;
        this.capHoldFrames[i] = 0;
      }

      if (barHeight >= this.peakCaps[i]) {
        this.peakCaps[i] = barHeight;
        this.capHoldFrames[i] = 12; // hold for 12 frames
      } else {
        if (this.capHoldFrames[i] > 0) {
          this.capHoldFrames[i]--;
        } else {
          this.peakCaps[i] = Math.max(0, this.peakCaps[i] - (isMini ? 1.5 : 2.5));
        }
      }

      // Draw Main Bar
      ctx.fillStyle = colors.gradient;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, isMini ? [2, 2, 0, 0] : [3, 3, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      // Draw Peak Cap (only in full mode or if bar width is sufficient)
      if (!isMini && this.peakCaps[i] > 4) {
        const peakY = Math.max(0, h - this.peakCaps[i] - 3);
        ctx.fillStyle = colors.peak;
        ctx.fillRect(x, peakY, barWidth, 2);
      }
    }
  }

  private drawWaveform(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const colors = this.getThemeColors(ctx, h);
    const sliceWidth = w / this.bufferLength;
    const sens = this.sensitivity();

    ctx.save();
    ctx.lineWidth = Math.max(2, (w / 400) * 1.5);
    ctx.strokeStyle = colors.primary;
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.moveTo(0, h / 2);

    let x = 0;
    for (let i = 0; i < this.bufferLength; i++) {
      const v = (this.timeData[i] - 128) / 128; // -1.0 to 1.0
      const scaledV = v * sens;
      const y = h / 2 + scaledV * (h * 0.42);

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        // Smooth curve
        const prevX = x - sliceWidth;
        const prevV = ((this.timeData[i - 1] - 128) / 128) * sens;
        const prevY = h / 2 + prevV * (h * 0.42);
        const midX = (prevX + x) / 2;
        const midY = (prevY + y) / 2;
        ctx.quadraticCurveTo(prevX, prevY, midX, midY);
      }
      x += sliceWidth;
    }
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Fill under wave
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fill();

    ctx.restore();
  }

  private drawCircle(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // В режиме КРУГА полоски автоматически окрашиваются в оттенки обложки альбома
    const alb = this.albumColor();
    const isMono = this.colorTheme() === 'mono';
    const isGreen = this.colorTheme() === 'green';
    const colors = isMono 
      ? this.getThemeColors(ctx, h) 
      : (isGreen ? this.getThemeColors(ctx, h) : alb);

    const centerX = w / 2;
    const centerY = h / 2;
    const isMobile = w < 600 || h < 600;
    const baseRadius = Math.max(70, Math.min(w, h) * (isMobile ? 0.28 : 0.23));
    const numBars = isMobile ? 48 : 64;
    const sens = this.sensitivity();

    let bassSum = 0;
    for (let i = 0; i < 8; i++) {
      bassSum += this.freqData[i];
    }
    const targetPulse = (bassSum / 8 / 255) * (isMobile ? 8 : 14) * sens;
    this.smoothedPulse = this.smoothedPulse * 0.8 + targetPulse * 0.2;
    const currentRadius = baseRadius + this.smoothedPulse;

    const diameter = Math.round(baseRadius * 2);
    if (this.circleDiameter() !== diameter) {
      this.circleDiameter.set(diameter);
    }
    const scale = 1 + (this.smoothedPulse / baseRadius) * 0.5;
    this.circleScale.set(scale);

    ctx.save();
    ctx.translate(centerX, centerY);

    ctx.beginPath();
    ctx.arc(0, 0, currentRadius, 0, Math.PI * 2);
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 2.8;
    ctx.shadowColor = colors.glow || colors.primary;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const angleStep = (Math.PI * 2) / numBars;
    const step = Math.max(1, Math.floor(this.bufferLength / numBars));
    const maxSpike = Math.min(w, h) * (isMobile ? 0.18 : 0.22);

    for (let i = 0; i < numBars; i++) {
      const dataIdx = Math.min(this.bufferLength - 1, i * step);
      const val = Math.min(1.0, (this.freqData[dataIdx] / 255) * sens);
      const spikeLen = Math.max(3, val * maxSpike);

      const angle = i * angleStep - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const x1 = cos * (currentRadius + 3);
      const y1 = sin * (currentRadius + 3);
      const x2 = cos * (currentRadius + 3 + spikeLen);
      const y2 = sin * (currentRadius + 3 + spikeLen);

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.strokeStyle = colors.primary;
      ctx.shadowColor = colors.glow || colors.primary;
      ctx.shadowBlur = val > 0.35 ? 10 : 0;
      ctx.lineWidth = Math.max(2, (w / 500) * (isMobile ? 2.6 : 2.3));
      ctx.lineCap = 'round';
      ctx.stroke();

      if (val > 0.45) {
        ctx.beginPath();
        ctx.arc(cos * (currentRadius + spikeLen + 7), sin * (currentRadius + spikeLen + 7), 1.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.peak;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
