import {
  Component,
  ElementRef,
  ViewChild,
  inject,
  effect,
  OnDestroy,
  AfterViewInit,
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

  @ViewChild('proceduralCanvas') canvasRef?: ElementRef<HTMLCanvasElement>;

  private animId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const preset = this.bgService.activePreset();
      if (typeof window !== 'undefined') {
        requestAnimationFrame(() => this.setupAnimation(preset));
      }
    });
  }

  ngAfterViewInit() {
    if (this.canvasRef?.nativeElement) {
      this.resizeCanvas();
      this.setupAnimation(this.bgService.activePreset());

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
        this.resizeObserver.observe(this.canvasRef.nativeElement);
      }
    }
  }

  ngOnDestroy() {
    this.stopAnimation();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private resizeCanvas() {
    if (!this.canvasRef?.nativeElement) return;
    const canvas = this.canvasRef.nativeElement;
    canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
    canvas.height = canvas.parentElement?.clientHeight || window.innerHeight;
  }

  private stopAnimation() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  private setupAnimation(preset: string) {
    this.stopAnimation();
    if (!this.canvasRef?.nativeElement) return;

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
