export const MOSCOW_NODE = 'https://recro-player.ru';
export const MOSCOW_DIRECT_NODE = 'https://recro.80.87.202.157.sslip.io';
export const MONOBLOCK_NODE = 'https://node-home.80.87.202.157.sslip.io';

export const CLUSTER_BACKENDS = [
  MOSCOW_NODE,        // 1. Москва VPS / recro-player.ru (работает стабильно и напрямую, и через VPN)
  MOSCOW_DIRECT_NODE, // 2. Москва VPS Прямой (прямой SSL без задержек)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }

  // 1. Check if we have a valid saved healthy backend (purge dead/legacy nodes)
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved) {
        if (saved.includes('177.3.217.64') || saved.includes('vercel.app')) {
          localStorage.removeItem('recro_fastest_backend');
        } else if (saved.startsWith('http')) {
          return saved;
        }
      }
    } catch {}
  }

  // 2. Host-specific defaults
  if (host.includes('node-home')) {
    return MONOBLOCK_NODE;
  }

  return MOSCOW_NODE;
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const candidates: string[] = [];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return [`http://${host}:8085`];
  }

  candidates.push(MOSCOW_NODE, MOSCOW_DIRECT_NODE);
  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}

export function getNodeDisplayName(url: string): string {
  if (!url) return 'Основной сервер';
  if (url.includes('node-home') || url === MONOBLOCK_NODE) {
    return 'Домашний моноблок';
  }
  if (url.includes('recro-player.ru') || url.includes('80.87.202.157') || url === MOSCOW_NODE || url === MOSCOW_DIRECT_NODE) {
    return 'Москва (recro-player.ru)';
  }
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return 'Локальный сервер';
  }
  return 'Облачный узел';
}
