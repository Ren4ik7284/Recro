export const MOSCOW_NODE = 'https://recro-player.ru';
export const FRANKFURT_NODE = 'https://recro.177.3.217.64.sslip.io';
export const MONOBLOCK_NODE = 'https://node-home.80.87.202.157.sslip.io';

export const CLUSTER_BACKENDS = [
  MOSCOW_NODE,
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }

  // Очищаем старые закэшированные в localStorage узлы, вызывавшие сбои
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem('recro_fastest_backend');
    } catch {}
  }

  return MOSCOW_NODE;
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return [`http://${host}:8085`];
  }
  return [MOSCOW_NODE];
}

export function getNodeDisplayName(url: string): string {
  if (!url) return 'Основной сервер';
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return 'Локальный сервер';
  }
  return 'Москва (recro-player.ru)';
}
