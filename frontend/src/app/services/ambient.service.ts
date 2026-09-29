import { Injectable, signal, effect, inject } from '@angular/core';
import { AudioService } from './audio.service';

export interface AmbientPalette {
  primary: string;
  secondary: string;
}

const DEFAULT_PALETTE: AmbientPalette = {
  primary: 'rgba(99, 102, 241, 0.32)',
  secondary: 'rgba(236, 72, 153, 0.22)',
};

/** Размер канваса для извлечения цвета из обложки: 64×64 даёт в 7× больше пикселей чем 24×24 */
const PALETTE_CANVAS_SIZE = 64;

@Injectable({
  providedIn: 'root',
})
export class AmbientService {
  private readonly audioService = inject(AudioService);
  private readonly STORAGE_KEY = 'recro_ambient_glow';

  readonly isEnabled = signal<boolean>(
    typeof localStorage !== 'undefined' ? localStorage.getItem(this.STORAGE_KEY) !== 'false' : true
  );

  readonly palette = signal<AmbientPalette>(DEFAULT_PALETTE);

  /** Ссылка на текущий загружаемый Image — отменяем предыдущий при смене трека */
  private currentImg: HTMLImageElement | null = null;

  constructor() {
    effect(() => {
      const track = this.audioService.currentTrack();
      if (!track) {
        this.cancelCurrentImage();
        this.palette.set(DEFAULT_PALETTE);
        return;
      }
      this.updateColorsForTrack(track.title, track.artist, track.coverUrl);
    });
  }

  toggle() {
    const next = !this.isEnabled();
    this.isEnabled.set(next);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.STORAGE_KEY, String(next));
    }
  }

  private cancelCurrentImage() {
    if (this.currentImg) {
      // Обнуляем handlers и src — браузер прекратит загрузку
      this.currentImg.onload = null;
      this.currentImg.onerror = null;
      this.currentImg.src = '';
      this.currentImg = null;
    }
  }

  private updateColorsForTrack(title: string, artist: string, coverUrl?: string | null) {
    // Сначала мгновенно выставляем текстовый фоллбэк — без ожидания картинки
    const textFallback = this.generatePaletteFromText(`${title} ${artist}`);
    this.palette.set(textFallback);

    if (coverUrl && typeof window !== 'undefined') {
      this.extractPaletteFromImage(coverUrl);
    }
  }

  private generatePaletteFromText(text: string): AmbientPalette {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    const hue1 = Math.abs(hash) % 360;
    const hue2 = (hue1 + 55 + (Math.abs(hash >> 3) % 90)) % 360;

    return {
      primary: `hsla(${hue1}, 75%, 52%, 0.35)`,
      secondary: `hsla(${hue2}, 70%, 48%, 0.24)`,
    };
  }

  private extractPaletteFromImage(url: string) {
    // Отменяем предыдущую загрузку — предотвращает накопление Image объектов
    this.cancelCurrentImage();

    const img = new Image();
    this.currentImg = img;
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onerror = () => {
      // Ошибка CORS или 404 — просто очищаем, текстовый фоллбэк уже выставлен
      if (this.currentImg === img) {
        this.currentImg = null;
      }
    };

    img.onload = () => {
      // Проверяем что этот Image всё ещё актуален (трек не сменился пока грузился)
      if (this.currentImg !== img) return;
      this.currentImg = null;

      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        canvas.width = PALETTE_CANVAS_SIZE;
        canvas.height = PALETTE_CANVAS_SIZE;
        ctx.drawImage(img, 0, 0, PALETTE_CANVAS_SIZE, PALETTE_CANVAS_SIZE);
        const data = ctx.getImageData(0, 0, PALETTE_CANVAS_SIZE, PALETTE_CANVAS_SIZE).data;

        let bestScore = -1;
        let primaryRgb = [99, 102, 241];
        let secondaryRgb = [236, 72, 153];

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];

          if (a < 128) continue;

          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const lum = (max + min) / 2;
          const delta = max - min;
          const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * (lum / 255) - 1));

          if (lum < 20 || lum > 235 || sat < 0.15) continue;

          const score = sat * (1 - Math.abs(lum / 255 - 0.5));
          if (score > bestScore) {
            bestScore = score;
            secondaryRgb = [...primaryRgb];
            primaryRgb = [r, g, b];
          }
        }

        if (bestScore > 0) {
          this.palette.set({
            primary: `rgba(${primaryRgb[0]}, ${primaryRgb[1]}, ${primaryRgb[2]}, 0.36)`,
            secondary: `rgba(${secondaryRgb[0]}, ${secondaryRgb[1]}, ${secondaryRgb[2]}, 0.24)`,
          });
        }
      } catch {
        // Silent fallback to text-generated palette on CORS restrictions
      }
    };

    img.src = url;
  }
}
