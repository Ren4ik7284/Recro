import { Injectable, signal, inject, Injector } from '@angular/core';
import { Track } from '../models/track.model';
import { LibraryService } from './library.service';

const IDB_NAME = 'signal_offline_db';
const IDB_STORE = 'audio_blobs';

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openOfflineDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        cachedDbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        cachedDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      cachedDbPromise = null;
      reject(req.error);
    };
  });
  return cachedDbPromise;
}

async function idbPutBlob(id: string, blob: Blob): Promise<void> {
  try {
    const db = await openOfflineDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(blob, id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  } catch (err) {
    cachedDbPromise = null;
    throw err;
  }
}

async function idbGetBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openOfflineDb();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(id);
        req.onsuccess = () => {
          const res = req.result;
          resolve(res instanceof Blob ? res : null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    cachedDbPromise = null;
    return null;
  }
}

async function idbDeleteBlob(id: string): Promise<void> {
  try {
    const db = await openOfflineDb();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  } catch {
    cachedDbPromise = null;
  }
}

@Injectable({
  providedIn: 'root',
})
export class OfflineService {
  private readonly CACHE_NAME = 'signal-offline-tracks-v1';
  private readonly STORAGE_KEY_OFFLINE = 'signal_offline_tracks_meta';

  private injector = inject(Injector);
  readonly offlineTrackIds = signal<Set<string>>(new Set());
  readonly downloadingTrackIds = signal<Set<string>>(new Set());

  private blobUrlByTrackId = new Map<string, string>();

  revokePreviousBlobUrls(keepTrackId?: string) {
    if (typeof window === 'undefined') return;
    for (const [id, url] of this.blobUrlByTrackId.entries()) {
      if (id !== keepTrackId) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
        this.blobUrlByTrackId.delete(id);
      }
    }
  }

  revokeAllBlobUrls() {
    if (typeof window === 'undefined') return;
    for (const [, url] of this.blobUrlByTrackId.entries()) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    this.blobUrlByTrackId.clear();
  }

  constructor() {
    this.loadOfflineIndex();
  }

  private getBackendBaseUrl(): string {
    try {
      const lib = this.injector.get(LibraryService);
      return lib.getBackendUrl();
    } catch {
      return typeof window !== 'undefined' ? window.location.origin : '';
    }
  }

  private loadOfflineIndex() {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY_OFFLINE);
      if (raw) {
        const list: Track[] = JSON.parse(raw);
        const ids = new Set(list.map((t) => t.id));
        this.offlineTrackIds.set(ids);
      }
    } catch {}

    // Фоновая сверка ключей из IndexedDB на случай очистки localStorage
    this.syncIndexedDbKeys().catch(() => {});
  }

  private async syncIndexedDbKeys(): Promise<void> {
    try {
      const db = await openOfflineDb();
      const keys = await new Promise<string[]>((resolve) => {
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const store = tx.objectStore(IDB_STORE);
          const req = store.getAllKeys();
          req.onsuccess = () => resolve((req.result as string[]) || []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });

      if (keys.length > 0) {
        const current = new Set(this.offlineTrackIds());
        let changed = false;
        for (const k of keys) {
          if (!current.has(k)) {
            current.add(k);
            changed = true;
          }
        }
        if (changed) {
          this.offlineTrackIds.set(current);
        }
      }
    } catch {}
  }

  isTrackOffline(trackId: string): boolean {
    return this.offlineTrackIds().has(trackId);
  }

  isDownloading(trackId: string): boolean {
    return this.downloadingTrackIds().has(trackId);
  }

  getOfflineTracks(): Track[] {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY_OFFLINE);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  async saveBlobOffline(track: Track, blob: Blob): Promise<boolean> {
    try {
      try {
        await idbPutBlob(track.id, blob);
      } catch (e) {
        console.warn('[OfflineService] IndexedDB save failed, fallback to Cache API:', e);
      }

      if (typeof window !== 'undefined' && 'caches' in window) {
        try {
          const cache = await caches.open(this.CACHE_NAME);
          const cacheKey = `/offline-audio/${track.id}`;
          const responseToCache = new Response(blob, {
            status: 200,
            headers: {
              'Content-Type': blob.type || 'audio/mpeg',
              'Content-Length': blob.size.toString(),
            },
          });
          await cache.put(cacheKey, responseToCache);
        } catch {}
      }

      const existing = this.getOfflineTracks().filter((t) => t.id !== track.id);
      const updatedTrack: Track = { ...track, isOffline: true };
      existing.push(updatedTrack);
      localStorage.setItem(this.STORAGE_KEY_OFFLINE, JSON.stringify(existing));

      const updatedIds = new Set(this.offlineTrackIds());
      updatedIds.add(track.id);
      this.offlineTrackIds.set(updatedIds);
      return true;
    } catch (err) {
      console.error('[OfflineService] Failed to cache blob track:', err);
      return false;
    }
  }

  async saveTrackOffline(track: Track): Promise<boolean> {
    if (typeof window === 'undefined') {
      return false;
    }
    if (track.isLiveStream) {
      return false;
    }

    const currentDownloading = new Set(this.downloadingTrackIds());
    currentDownloading.add(track.id);
    this.downloadingTrackIds.set(currentDownloading);

    try {
      let audioUrl = track.audioUrl;
      const backendBase = this.getBackendBaseUrl();

      if (!audioUrl.startsWith('blob:')) {
        if (audioUrl.startsWith('/api/stream')) {
          audioUrl = `${backendBase}${audioUrl}`;
        } else if (audioUrl.includes('/api/stream')) {
          const streamIdx = audioUrl.indexOf('/api/stream');
          audioUrl = `${backendBase}${audioUrl.slice(streamIdx)}`;
        } else if (
          audioUrl.includes('youtube.com') ||
          audioUrl.includes('youtu.be') ||
          audioUrl.includes('soundcloud.com')
        ) {
          audioUrl = `${backendBase}/api/stream?url=${encodeURIComponent(audioUrl)}`;
        } else if (!audioUrl.startsWith('http')) {
          audioUrl = `${backendBase}${audioUrl.startsWith('/') ? '' : '/'}${audioUrl}`;
        }

        if (audioUrl.includes('/api/stream')) {
          if (!audioUrl.includes('title=') && track.title) {
            const glue = audioUrl.includes('?') ? '&' : '?';
            audioUrl = `${audioUrl}${glue}title=${encodeURIComponent(track.title || '')}`;
          }
          if (!audioUrl.includes('artist=') && track.artist) {
            const glue = audioUrl.includes('?') ? '&' : '?';
            audioUrl = `${audioUrl}${glue}artist=${encodeURIComponent(track.artist || '')}`;
          }
        }
      }

      const resp = await fetch(audioUrl, { mode: 'cors' });
      if (!resp.ok) {
        throw new Error(`Failed to download audio: ${resp.status}`);
      }

      const blob = await resp.blob();

      // Защита от пустых или поврежденных ответов (страницы ошибок 404/500/429):
      // Полноценный аудиотрек не может весить меньше 40 КБ
      if (!blob || blob.size < 40 * 1024) {
        throw new Error(`Downloaded audio file is invalid or too small (${blob?.size || 0} bytes)`);
      }

      try {
        await idbPutBlob(track.id, blob);
      } catch (e) {
        console.warn('[OfflineService] IndexedDB save error:', e);
      }

      if ('caches' in window) {
        try {
          const cache = await caches.open(this.CACHE_NAME);
          const cacheKey = `/offline-audio/${track.id}`;
          const responseToCache = new Response(blob, {
            status: 200,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Length': blob.size.toString(),
            },
          });
          await cache.put(cacheKey, responseToCache);
        } catch {}
      }

      const existing = this.getOfflineTracks().filter((t) => t.id !== track.id);
      const updatedTrack: Track = { ...track, isOffline: true };
      existing.push(updatedTrack);
      localStorage.setItem(this.STORAGE_KEY_OFFLINE, JSON.stringify(existing));

      const updatedIds = new Set(this.offlineTrackIds());
      updatedIds.add(track.id);
      this.offlineTrackIds.set(updatedIds);

      return true;
    } catch (err) {
      console.error('[OfflineService] Failed to cache track:', err);
      return false;
    } finally {
      const dl = new Set(this.downloadingTrackIds());
      dl.delete(track.id);
      this.downloadingTrackIds.set(dl);
    }
  }

  async removeTrackOffline(trackId: string): Promise<boolean> {
    try {
      await idbDeleteBlob(trackId);

      if (typeof window !== 'undefined' && 'caches' in window) {
        try {
          const cache = await caches.open(this.CACHE_NAME);
          const cacheKey = `/offline-audio/${trackId}`;
          await cache.delete(cacheKey);
        } catch {}
      }

      const existingUrl = this.blobUrlByTrackId.get(trackId);
      if (existingUrl) {
        try {
          URL.revokeObjectURL(existingUrl);
        } catch {}
        this.blobUrlByTrackId.delete(trackId);
      }

      const existing = this.getOfflineTracks().filter((t) => t.id !== trackId);
      localStorage.setItem(this.STORAGE_KEY_OFFLINE, JSON.stringify(existing));

      const updatedIds = new Set(this.offlineTrackIds());
      updatedIds.delete(trackId);
      this.offlineTrackIds.set(updatedIds);
      return true;
    } catch (err) {
      console.error('[OfflineService] Failed to remove cached track:', err);
      return false;
    }
  }

  getCachedBlobUrlSync(trackId: string): string | null {
    return this.blobUrlByTrackId.get(trackId) || null;
  }

  async getOfflineBlobUrl(trackId: string): Promise<string | null> {
    if (typeof window === 'undefined') {
      return null;
    }

    // Если blob URL уже сгенерирован и активен — возвращаем моментально без обращений к IDB
    const existing = this.blobUrlByTrackId.get(trackId);
    if (existing) {
      return existing;
    }

    try {
      const blob = await idbGetBlob(trackId);
      if (blob) {
        if (blob.size < 40 * 1024) {
          console.warn('[OfflineService] Corrupt offline blob detected (<40KB), purging:', trackId);
          this.removeTrackOffline(trackId).catch(() => {});
          return null;
        }
        const url = URL.createObjectURL(blob);
        this.blobUrlByTrackId.set(trackId, url);
        return url;
      }

      if ('caches' in window) {
        const cache = await caches.open(this.CACHE_NAME);
        const cacheKey = `/offline-audio/${trackId}`;
        const match = await cache.match(cacheKey);
        if (match) {
          const b = await match.blob();
          if (b && b.size >= 40 * 1024) {
            idbPutBlob(trackId, b).catch(() => {});
            const url = URL.createObjectURL(b);
            this.blobUrlByTrackId.set(trackId, url);
            return url;
          } else {
            cache.delete(cacheKey).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('[OfflineService] getOfflineBlobUrl error:', e);
    }

    return null;
  }
}
