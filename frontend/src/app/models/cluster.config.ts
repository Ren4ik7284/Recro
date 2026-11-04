export const MOSCOW_NODE = 'https://recro-player.ru';
export const FRANKFURT_NODE = 'https://recro.177.3.217.64.sslip.io';
export const MONOBLOCK_NODE = 'https://node-home.80.87.202.157.sslip.io';

export const CLUSTER_BACKENDS = [
  MOSCOW_NODE,    // 1. Москва VPS / recro-player.ru (без VPN в РФ)
  FRANKFURT_NODE, // 2. Франкфурт VPS (с VPN / в Европе)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  if (host === 'recro-player.ru' || host.endsWith('recro-player.ru') || host === '80.87.202.157' || host.includes('80.87.202.157')) {
    return MOSCOW_NODE;
  }
  if (host === '177.3.217.64' || host.includes('177.3.217.64')) {
    return FRANKFURT_NODE;
  }

  // Очищаем старые закэшированные в localStorage узлы, если там был сломанный узел
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && !saved.includes('vercel.app') && !saved.includes('node-home') && saved.startsWith('http')) {
        return saved;
      }
    } catch {}
  }

  return MOSCOW_NODE;
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const candidates: string[] = [];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return [`http://${host}:8085`];
  } else if (host === 'recro-player.ru' || host.endsWith('recro-player.ru') || host === '80.87.202.157') {
    candidates.push(MOSCOW_NODE);
  } else if (host === '177.3.217.64') {
    candidates.push(FRANKFURT_NODE);
  }

  candidates.push(...CLUSTER_BACKENDS);

  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}

export function getNodeDisplayName(url: string): string {
  if (!url) return 'Основной сервер';
  if (url.includes('177.3.217.64') || url.includes('recro.177.3.217.64') || url === FRANKFURT_NODE) {
    return 'Франкфурт (VPN)';
  }
  if (url.includes('recro-player.ru') || url.includes('80.87.202.157') || url.includes('recro.80.87.202.157') || url === MOSCOW_NODE) {
    return 'Москва (recro-player.ru)';
  }
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return 'Локальный сервер';
  }
  return 'Облачный узел';
}
