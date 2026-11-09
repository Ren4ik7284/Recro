export const MOSCOW_NODE = 'https://recro-player.ru';
export const MOSCOW_DIRECT_NODE = 'https://recro.80.87.202.157.sslip.io';
export const FRANKFURT_NODE = 'https://recro.177.3.217.64.sslip.io';
export const MONOBLOCK_NODE = 'https://node-home.80.87.202.157.sslip.io';

export const CLUSTER_BACKENDS = [
  MOSCOW_NODE,        // 1. Москва VPS / recro-player.ru (без VPN в РФ через Cloudflare)
  FRANKFURT_NODE,     // 2. Франкфурт VPS (с VPN / в Европе)
  MOSCOW_DIRECT_NODE, // 3. Москва VPS Прямой (прямой SSL без Cloudflare IPv6 задержек)
  MONOBLOCK_NODE,     // 4. Домашний моноблок (423GB RU cache)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  if (host === 'recro-player.ru' || host.endsWith('recro-player.ru') || host === '80.87.202.157' || host.includes('80.87.202.157')) {
    if (host.includes('node-home')) return MONOBLOCK_NODE;
    return MOSCOW_NODE;
  }
  if (host === '177.3.217.64' || host.includes('177.3.217.64')) {
    return FRANKFURT_NODE;
  }

  // Check if we already cached a proven healthy node from a previous session
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && !saved.includes('vercel.app') && saved.startsWith('http')) {
        return saved;
      }
    } catch {}
  }

  // На международных/облачных CDN доменах (vercel.app, github pages) по умолчанию выбираем Франкфурт,
  // так как за пределами РФ (или с VPN) соединение с Франкфуртом на порядок быстрее и стабильнее
  if (host.includes('vercel.app')) {
    return FRANKFURT_NODE;
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
  if (url.includes('node-home') || url === MONOBLOCK_NODE) {
    return 'Домашний моноблок';
  }
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
