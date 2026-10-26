export const MONOBLOCK_NODE = 'https://node-home.80.87.202.157.sslip.io';
export const MOSCOW_NODE = 'https://recro.80.87.202.157.sslip.io';
export const FRANKFURT_NODE = 'https://recro.177.3.217.64.sslip.io';

export const CLUSTER_BACKENDS = [
  MONOBLOCK_NODE, // 1. Monoblock (Primary when online - massive 423GB cache)
  MOSCOW_NODE,    // 2. Moscow VPS (Direct in RU without VPN)
  FRANKFURT_NODE, // 3. Frankfurt VPS (Direct in Europe / with VPN)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  // If running directly on a VPS host (raw IP or domain)
  if (host === '80.87.202.157' || host.includes('80.87.202.157')) {
    return MOSCOW_NODE;
  }
  if (host === '177.3.217.64' || host.includes('177.3.217.64')) {
    return FRANKFURT_NODE;
  }

  // Check if we already cached the fastest proven node from a previous race
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && !saved.includes('vercel.app') && saved.startsWith('http')) return saved;
    } catch {}
  }

  // If on Vercel: default to Monoblock (will be verified on startup)
  if (host.includes('vercel.app')) {
    return MONOBLOCK_NODE;
  }

  return MONOBLOCK_NODE;
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const candidates: string[] = [];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    candidates.push(`http://${host}:8085`);
  } else if (host === '80.87.202.157') {
    candidates.push(MOSCOW_NODE);
  } else if (host === '177.3.217.64') {
    candidates.push(FRANKFURT_NODE);
  }

  // Direct cluster nodes in priority order (Monoblock -> Moscow -> Frankfurt)
  candidates.push(...CLUSTER_BACKENDS);

  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}
