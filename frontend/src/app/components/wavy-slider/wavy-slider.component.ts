import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  AfterViewInit,
  Output,
  SimpleChanges,
  ViewChild,
  inject,
  PLATFORM_ID,
  HostListener,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';

@Component({
  selector: 'app-wavy-slider',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './wavy-slider.component.html',
  styleUrl: './wavy-slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WavySliderComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly hostRef = inject(ElementRef<HTMLElement>);

  @ViewChild('waveCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() value = 0;
  @Input() max = 100;
  @Input() isPlaying = false;
  @Input() disabled = false;
  @Input() color = '';
  @Input() waveLength = 32; // px per wave cycle (crisp squiggly wave)
  @Input() amplitude = 4.5; // px amplitude for visible wave
  @Input() waveDuration = 1100; // ms for one full wave phase cycle (like Caelestia Shell)
  @Input() showHandle = true;
  @Input() showTooltip = true;

  @Output() seek = new EventEmitter<number>();
  @Output() scrub = new EventEmitter<number>();
  @Output() scrubStart = new EventEmitter<void>();
  @Output() scrubEnd = new EventEmitter<void>();

  // Internal state
  isHovered = false;
  isDragging = false;
  hoverTime = 0;
  hoverX = 0;
  formattedHoverTime = '0:00';
  currentDragPct = 0;

  private ctx: CanvasRenderingContext2D | null = null;
  private animFrameId: number | null = null;
  private lastTimestamp = 0;
  private wavePhase = 0;
  private resizeObserver?: ResizeObserver;

  // Bound window listener references for safe removal
  private onWindowPointerMoveRef = (e: PointerEvent) => this.onWindowPointerMove(e);
  private onWindowPointerUpRef = (e: PointerEvent) => this.onWindowPointerUp(e);

  get isBrowser(): boolean {
    return isPlatformBrowser(this.platformId);
  }

  ngOnInit(): void {
    if (!this.isBrowser) return;

    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      this.ctx = canvas.getContext('2d');
    }
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;

    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      if (!this.ctx) {
        this.ctx = canvas.getContext('2d');
      }
      this.setupResizeObserver();
      this.syncCanvasSize();
      this.requestDraw();
      if (this.isPlaying) {
        this.startWaveAnimation();
      }
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.isBrowser) return;

    if (changes['isPlaying']) {
      if (this.isPlaying) {
        this.startWaveAnimation();
      } else {
        this.stopWaveAnimation();
        this.requestDraw();
      }
    }

    if (changes['value'] || changes['max'] || changes['amplitude'] || changes['waveLength']) {
      if (!this.animFrameId) {
        this.requestDraw();
      }
    }
  }

  ngOnDestroy(): void {
    this.stopWaveAnimation();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.removeWindowDragListeners();
  }

  // --- Animation loop ---
  private startWaveAnimation(): void {
    if (!this.isBrowser || this.animFrameId !== null) return;

    this.lastTimestamp = performance.now();
    const loop = (timestamp: number) => {
      const delta = timestamp - this.lastTimestamp;
      this.lastTimestamp = timestamp;

      // Phase cycle speed: 2*PI radians in waveDuration ms
      const phaseSpeed = (Math.PI * 2) / Math.max(200, this.waveDuration);
      this.wavePhase = (this.wavePhase + delta * phaseSpeed) % (Math.PI * 2);

      this.draw();

      if (this.isPlaying) {
        this.animFrameId = requestAnimationFrame(loop);
      } else {
        this.animFrameId = null;
      }
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  private stopWaveAnimation(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private requestDraw(): void {
    if (!this.isBrowser) return;
    if (this.animFrameId === null) {
      requestAnimationFrame(() => this.draw());
    }
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          this.syncCanvasSize();
          this.requestDraw();
        }
      }
    });
    this.resizeObserver.observe(this.hostRef.nativeElement);
  }

  private syncCanvasSize(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const width = Math.max(10, Math.floor(rect.width));
    const height = Math.max(10, Math.floor(rect.height));

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
  }

  // --- Rendering ---
  private draw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas || !this.ctx) return;

    const ctx = this.ctx;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Color resolution from CSS theme or fallback
    const style = getComputedStyle(canvas);
    const activeColor =
      this.color ||
      style.getPropertyValue('--slider-fill-color').trim() ||
      style.getPropertyValue('--theme-c1').trim() ||
      style.getPropertyValue('--accent-blue').trim() ||
      '#ffffff';
    const remainingColor =
      style.getPropertyValue('--slider-bg-color').trim() ||
      'rgba(255, 255, 255, 0.2)';

    const centerY = height / 2;
    const effectiveValue = this.isDragging ? this.currentDragPct * this.max : this.value;
    const pct = this.max > 0 ? Math.min(1, Math.max(0, effectiveValue / this.max)) : 0;

    const handleWidth = this.isHovered || this.isDragging ? 5 : 4;
    const handleHeight = this.isDragging ? 18 : this.isHovered ? 16 : 14;
    const halfHandle = handleWidth / 2;

    // Usable track bounds
    const startX = 2;
    const endX = width - 4;
    const availableWidth = endX - startX;
    const progressX = startX + pct * availableWidth;

    // 1. Draw remaining unplayed track line (от бегунка до конца трека)
    const remainingStartX = Math.min(endX, progressX + halfHandle + 3);
    const remainingEndX = endX - 6;

    if (remainingEndX > remainingStartX) {
      ctx.beginPath();
      ctx.moveTo(remainingStartX, centerY);
      ctx.lineTo(remainingEndX, centerY);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = remainingColor;
      ctx.shadowBlur = 0;
      ctx.stroke();

      // Caelestia Shell signature endpoint dot at the far right
      ctx.beginPath();
      ctx.arc(endX - 2, centerY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = activeColor;
      ctx.fill();
    }

    // 2. Draw animated Wavy line for played progress (от начала до бегунка)
    const waveEndX = Math.max(startX, progressX - (this.showHandle ? halfHandle + 2 : 0));
    const playedLength = waveEndX - startX;

    if (playedLength > 1) {
      const wLen = Math.max(16, this.waveLength);
      const baseAmp = (this.isHovered || this.isDragging ? this.amplitude * 1.15 : this.amplitude);

      ctx.beginPath();
      ctx.moveTo(startX, centerY);

      const step = 1.5;
      for (let x = startX; x <= waveEndX; x += step) {
        const distFromStart = x - startX;
        const distFromEnd = waveEndX - x;

        // Smooth envelope fade-in at start and fade-out at handle
        const envelopeIn = Math.min(1, distFromStart / 14);
        const envelopeOut = Math.min(1, distFromEnd / 14);
        const curAmp = baseAmp * envelopeIn * envelopeOut;

        // Traveling sine wave formula (Caelestia Shell squiggly snake)
        const angle = ((x - startX) / wLen) * Math.PI * 2 - this.wavePhase;
        const y = centerY + Math.sin(angle) * curAmp;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(waveEndX, centerY);

      ctx.lineWidth = this.isHovered || this.isDragging ? 3.8 : 3.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = activeColor;

      // Glow effect in Caelestia / modern shell style
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = this.isHovered || this.isDragging ? 8 : 4;
      ctx.stroke();
    }

    // 3. Draw Handle / Thumb (Pill/Capsule in Caelestia Shell style)
    if (this.showHandle) {
      const hx = Math.max(startX + halfHandle, Math.min(endX - halfHandle, progressX));
      const hy = centerY - handleHeight / 2;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(hx - halfHandle, hy, handleWidth, handleHeight, 999);
      } else {
        ctx.rect(hx - halfHandle, hy, handleWidth, handleHeight);
      }
      ctx.fillStyle = activeColor;
      ctx.shadowColor = activeColor;
      ctx.shadowBlur = this.isDragging ? 12 : this.isHovered ? 8 : 4;
      ctx.fill();
    }

    ctx.restore();
  }

  // --- Interaction & Gestures ---
  onPointerDown(e: PointerEvent): void {
    if (this.disabled) return;
    this.isDragging = true;
    this.addWindowDragListeners();
    this.scrubStart.emit();

    const canvas = this.canvasRef.nativeElement;
    canvas.setPointerCapture?.(e.pointerId);

    const pct = this.getPctFromEvent(e);
    this.currentDragPct = pct;
    const scrubVal = pct * this.max;
    this.scrub.emit(scrubVal);
    this.requestDraw();
  }

  private onWindowPointerMove(e: PointerEvent): void {
    if (!this.isDragging) return;
    const pct = this.getPctFromEvent(e);
    this.currentDragPct = pct;
    const scrubVal = pct * this.max;
    this.scrub.emit(scrubVal);
    this.updateHoverFromEvent(e);
    this.requestDraw();
  }

  private onWindowPointerUp(e: PointerEvent): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.removeWindowDragListeners();

    const pct = this.getPctFromEvent(e);
    const finalVal = pct * this.max;
    this.seek.emit(finalVal);
    this.scrubEnd.emit();
    this.requestDraw();
  }

  onPointerEnter(): void {
    if (this.disabled) return;
    this.isHovered = true;
    this.requestDraw();
  }

  onPointerMove(e: PointerEvent): void {
    if (this.disabled) return;
    this.updateHoverFromEvent(e);
  }

  onPointerLeave(): void {
    this.isHovered = false;
    this.requestDraw();
  }

  private updateHoverFromEvent(e: PointerEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    this.hoverX = relX;

    const pct = rect.width > 0 ? relX / rect.width : 0;
    this.hoverTime = Math.max(0, Math.min(this.max, pct * this.max));
    this.formattedHoverTime = this.formatTime(this.hoverTime);
  }

  private getPctFromEvent(e: PointerEvent): number {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const relX = e.clientX - rect.left;
    return Math.max(0, Math.min(1, relX / rect.width));
  }

  private addWindowDragListeners(): void {
    if (!this.isBrowser) return;
    window.addEventListener('pointermove', this.onWindowPointerMoveRef);
    window.addEventListener('pointerup', this.onWindowPointerUpRef);
    window.addEventListener('pointercancel', this.onWindowPointerUpRef);
  }

  private removeWindowDragListeners(): void {
    if (!this.isBrowser) return;
    window.removeEventListener('pointermove', this.onWindowPointerMoveRef);
    window.removeEventListener('pointerup', this.onWindowPointerUpRef);
    window.removeEventListener('pointercancel', this.onWindowPointerUpRef);
  }

  // Keyboard accessibility
  @HostListener('keydown', ['$event'])
  onKeyDown(e: KeyboardEvent): void {
    if (this.disabled || !this.max) return;

    const step = Math.max(1, this.max * 0.02); // 2% or 5s
    let newVal = this.value;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        newVal = Math.max(0, this.value - step);
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        newVal = Math.min(this.max, this.value + step);
        e.preventDefault();
        break;
      case 'Home':
        newVal = 0;
        e.preventDefault();
        break;
      case 'End':
        newVal = this.max;
        e.preventDefault();
        break;
      default:
        return;
    }

    this.seek.emit(newVal);
    this.requestDraw();
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  }
}
