import { Injectable, inject, signal } from '@angular/core';
import { AudioService } from './audio.service';
import { LibraryService } from './library.service';

@Injectable({
  providedIn: 'root',
})
export class BpmService {
  private readonly audioService = inject(AudioService);
  private readonly libraryService = inject(LibraryService);

  readonly currentBpm = signal<number | null>(null);
  readonly isDetecting = signal<boolean>(false);

  private beatIntervals: number[] = [];
  private lastBeatTime = 0;
  private energyHistory: number[] = [];
  private rafId: number | null = null;
  private currentTrackId: string | null = null;

  startDetectionForTrack(trackId: string, initialBpm?: number | null) {
    if (initialBpm && initialBpm >= 45 && initialBpm <= 240) {
      this.currentBpm.set(Math.round(initialBpm));
      this.currentTrackId = trackId;
      this.isDetecting.set(false);
      return;
    }

    this.currentTrackId = trackId;
    this.currentBpm.set(null);
    this.beatIntervals = [];
    this.lastBeatTime = 0;
    this.energyHistory = [];
    this.isDetecting.set(true);

    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.loopDetect();
  }

  stopDetection() {
    this.isDetecting.set(false);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private loopDetect() {
    if (!this.isDetecting()) return;

    if (!this.audioService.isPlaying()) {
      this.rafId = requestAnimationFrame(() => this.loopDetect());
      return;
    }

    const freqData = new Uint8Array(32);
    if (this.audioService.getAudioFrequencyData(freqData)) {
      // Focus on low frequencies / kick transients: bins 0, 1, 2 (~40Hz - 180Hz)
      const bassEnergy = (freqData[0] * 1.2 + freqData[1] * 1.5 + freqData[2] * 0.8) / 3.5;
      const now = performance.now();

      this.energyHistory.push(bassEnergy);
      if (this.energyHistory.length > 40) {
        this.energyHistory.shift();
      }

      const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
      // Peak detection: energy exceeds moving average by 30% and at least 260ms passed since last peak
      if (bassEnergy > 45 && bassEnergy > avgEnergy * 1.30 && (now - this.lastBeatTime > 260)) {
        if (this.lastBeatTime > 0) {
          const delta = now - this.lastBeatTime;
          // Valid musical tempo range: 270ms (~222 BPM) to 1200ms (50 BPM)
          if (delta >= 270 && delta <= 1200) {
            this.beatIntervals.push(delta);
            if (this.beatIntervals.length > 20) {
              this.beatIntervals.shift();
            }

            if (this.beatIntervals.length >= 8) {
              const bpm = this.calculateBpmFromIntervals(this.beatIntervals);
              if (bpm && bpm >= 60 && bpm <= 190) {
                this.currentBpm.set(bpm);
                if (this.beatIntervals.length >= 14) {
                  this.persistBpm(bpm);
                  this.stopDetection();
                  return;
                }
              }
            }
          }
        }
        this.lastBeatTime = now;
      }
    }

    this.rafId = requestAnimationFrame(() => this.loopDetect());
  }

  private calculateBpmFromIntervals(intervals: number[]): number | null {
    const bpms = intervals.map((dt) => 60000 / dt);
    // Normalize octave divisions into 70..165 range
    const normalized = bpms.map((b) => {
      let val = b;
      while (val < 68) val *= 2;
      while (val > 170) val /= 2;
      return Math.round(val);
    });

    const buckets = new Map<number, number>();
    for (const b of normalized) {
      let foundBucket: number | null = null;
      for (const bucket of buckets.keys()) {
        if (Math.abs(bucket - b) <= 2) {
          foundBucket = bucket;
          break;
        }
      }
      if (foundBucket !== null) {
        buckets.set(foundBucket, (buckets.get(foundBucket) || 0) + 1);
      } else {
        buckets.set(b, 1);
      }
    }

    let bestBpm = 0;
    let maxCount = 0;
    for (const [b, count] of buckets.entries()) {
      if (count > maxCount) {
        maxCount = count;
        bestBpm = b;
      }
    }

    return maxCount >= 4 ? Math.round(bestBpm) : null;
  }

  private async persistBpm(bpm: number) {
    const track = this.audioService.currentTrack();
    if (!track || track.id !== this.currentTrackId) return;

    try {
      const backendUrl = this.libraryService.getBackendUrl();
      await fetch(`${backendUrl}/api/track/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track_id: track.id,
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          bpm,
        }),
      });
    } catch {}
  }
}
