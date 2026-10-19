export const CLUSTER_BACKENDS = [
  'https://recro.80.87.202.157.sslip.io', // Moscow VPS (Ultra-fast in RU without VPN)
  'https://recro.177.3.217.64.sslip.io',  // Frankfurt VPS (Ultra-fast in Europe / with VPN)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  // When running in browser (Vercel, VPS direct, custom domain):
  // window.location.origin is always guaranteed to have working API routes / rewrites
  if (window.location.origin && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  return CLUSTER_BACKENDS[0];
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const candidates: string[] = [];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    candidates.push(`http://${host}:8085`);
  }
  if (window.location.origin && window.location.protocol.startsWith('http')) {
    candidates.push(window.location.origin);
  }
  candidates.push(...CLUSTER_BACKENDS);
  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}
