import {
  Component,
  ElementRef,
  ViewChild,
  inject,
  effect,
  OnDestroy,
  AfterViewInit,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LiveBackgroundService } from '../../services/live-background.service';

@Component({
  selector: 'app-live-background',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './live-background.component.html',
  styleUrl: './live-background.component.scss',
})
export class LiveBackgroundComponent implements AfterViewInit, OnDestroy {
  readonly bgService = inject(LiveBackgroundService);

  readonly isImageLoaded = signal<boolean>(false);
  readonly isVideoLoaded = signal<boolean>(false);

  private _canvasElement: HTMLCanvasElement | null = null;
  private currentRunningPreset: string | null = null;
  private lastTrackedUrl: string | null = null;

  @ViewChild('proceduralCanvas') set proceduralCanvas(ref: ElementRef<HTMLCanvasElement> | undefined) {
    const el = ref?.nativeElement || null;
    if (el === this._canvasElement) return;
    this._canvasElement = el;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (el) {
      this.resizeCanvas();
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          this.resizeCanvas();
        });
        this.resizeObserver.observe(el.parentElement || el);
      }
      this.setupAnimation(this.bgService.activePreset());
    } else {
      this.stopAnimation();
    }
  }

  get canvasRef(): ElementRef<HTMLCanvasElement> | undefined {
    return this._canvasElement ? new ElementRef(this._canvasElement) : undefined;
  }

  @ViewChild('bgVideo') set bgVideoRef(ref: ElementRef<HTMLVideoElement> | undefined) {
    if (ref?.nativeElement) {
      this.onVideoReady(ref.nativeElement);
    }
  }

  onImageLoaded() {
    this.isImageLoaded.set(true);
  }

  onVideoReady(video: HTMLVideoElement) {
    if (!video) return;
    this.silenceVideo(video);
    this.isVideoLoaded.set(true);
    video.play().catch(() => {});
  }

  silenceVideo(video: HTMLVideoElement) {
    if (!video) return;
    try {
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
      if ('audioTracks' in video && (video as any).audioTracks) {
        const tracks = (video as any).audioTracks;
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].enabled = false;
        }
      }
    } catch {}
  }

  private animId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const preset = this.bgService.activePreset();
      const url = this.bgService.customMediaUrl();

      // Сбрасываем флаг загрузки только при реальной смене URL
      if (url !== this.lastTrackedUrl) {
        this.lastTrackedUrl = url;
        this.isImageLoaded.set(false);
        this.isVideoLoaded.set(false);
      }

      // Перезапускаем процедурную анимацию только если сменился пресет
      if (typeof window !== 'undefined') {
        if (preset !== this.currentRunningPreset) {
          this.currentRunningPreset = preset;
          requestAnimationFrame(() => this.setupAnimation(preset));
        }
      }
    });
  }

  ngAfterViewInit() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this._canvasElement) {
      this.resizeCanvas();
      this.setupAnimation(this.bgService.activePreset());
    }
  }

  ngOnDestroy() {
    this.stopAnimation();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.stopAnimation();
    } else {
      this.setupAnimation(this.bgService.activePreset());
    }
  };

  private resizeCanvas() {
    const canvas = this._canvasElement;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800);
    const h = parent?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  private stopAnimation() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  private setupAnimation(preset: string) {
    this.stopAnimation();
    if (!this._canvasElement) return;
    this.resizeCanvas();

    if (preset === 'grid') {
      this.startGridAnimation();
    } else if (preset === 'waves') {
      this.startWavesAnimation();
    } else if (preset === 'rain') {
      this.startRainAnimation();
    } else if (preset === 'stars') {
      this.startStarsAnimation();
    }
  }

  // 1. Минималистичная кибер-сетка (Grid)
  private startGridAnimation() {
    const canvas = this.canvasRef!.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let offset = 0;
    const step = 48;

    const loop = () => {
      if (this.bgService.activePreset() !== 'grid') return;
      ctx.fillStyle = '#06080f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = 'rgba(6, 182, 212, 0.08)';
      ctx.lineWidth = 1;

      offset = (offset + 0.4) % step;

      // Горизонтальные линии
      for (let y = offset; y < canvas.height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Вертикальные линии
      for (let x = offset; x < canvas.width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }

      this.animId = requestAnimationFrame(loop);
    };

    loop();
  }

  // 2. Минималистичные волны (Waves)
  private startWavesAnimation() {
    const canvas = this.canvasRef!.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let t = 0;

    const loop = () => {
      if (this.bgService.activePreset() !== 'waves') return;
      ctx.fillStyle = '#090714';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      t += 0.015;

      const waves = [
        { amp: 35, freq: 0.005, speed: 1.0, color: 'rgba(139, 92, 246, 0.15)' },
        { amp: 25, freq: 0.008, speed: 1.5, color: 'rgba(56, 189, 248, 0.12)' },
        { amp: 45, freq: 0.003, speed: 0.7, color: 'rgba(99, 102, 241, 0.08)' },
      ];

      for (const w of waves) {
        ctx.beginPath();
        ctx.moveTo(0, canvas.height);

        for (let x = 0; x <= canvas.width; x += 10) {
          const y = canvas.height * 0.55 + Math.sin(x * w.freq + t * w.speed) * w.amp;
          ctx.lineTo(x, y);
        }

        ctx.lineTo(canvas.width, canvas.height);
        ctx.closePath();
        ctx.fillStyle = w.color;
        ctx.fill();
      }

      this.animId = requestAnimationFrame(loop);
    };

    loop();
  }

  // 3. Минималистичный ночной дождь (Rain)
  private startRainAnimation() {
    const canvas = this.canvasRef!.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const count = 75;
    const drops = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      len: 12 + Math.random() * 18,
      speed: 6 + Math.random() * 6,
      opacity: 0.08 + Math.random() * 0.16,
    }));

    const loop = () => {
      if (this.bgService.activePreset() !== 'rain') return;
      ctx.fillStyle = '#050a12';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 1;

      for (const d of drops) {
        ctx.strokeStyle = `rgba(56, 189, 248, ${d.opacity})`;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 1, d.y + d.len);
        ctx.stroke();

        d.y += d.speed;
        d.x -= 0.5;

        if (d.y > canvas.height) {
          d.y = -d.len;
          d.x = Math.random() * canvas.width;
        }
      }

      this.animId = requestAnimationFrame(loop);
    };

    loop();
  }

  // 4. Минималистичный дрейф частиц (Stars)
  private startStarsAnimation() {
    const canvas = this.canvasRef!.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const count = 90;
    const stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.5 + 0.5,
      speed: Math.random() * 0.25 + 0.05,
      alpha: Math.random() * 0.5 + 0.1,
    }));

    const loop = () => {
      if (this.bgService.activePreset() !== 'stars') return;
      ctx.fillStyle = '#05060a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const s of stars) {
        ctx.fillStyle = `rgba(226, 232, 240, ${s.alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();

        s.y -= s.speed;
        if (s.y < 0) {
          s.y = canvas.height;
          s.x = Math.random() * canvas.width;
        }
      }

      this.animId = requestAnimationFrame(loop);
    };

    loop();
  }
}
