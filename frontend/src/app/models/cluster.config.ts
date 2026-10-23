export const CLUSTER_BACKENDS = [
  'https://recro.177.3.217.64.sslip.io',  // Frankfurt VPS (Direct, ultra-fast in Europe / with VPN)
  'https://recro.80.87.202.157.sslip.io', // Moscow VPS (Direct, ultra-fast in RU without VPN)
  'https://80-87-202-157.sslip.io',       // Moscow VPS alternate domain
  'https://177-3-217-64.sslip.io',       // Frankfurt VPS alternate domain
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  // If running directly on a VPS host (raw IP or domain)
  if (host === '80.87.202.157' || host.includes('80.87.202.157')) {
    return window.location.origin;
  }
  if (host === '177.3.217.64' || host.includes('177.3.217.64')) {
    return window.location.origin;
  }

  // Check if we already cached the fastest proven node from a previous race
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && saved.startsWith('http')) return saved;
    } catch {}
  }

  // If on Vercel: use Vercel origin (has CDN proxy to backend) or Frankfurt (fast everywhere)
  if (host.includes('vercel.app')) {
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
  } else if (host === '80.87.202.157' || host === '177.3.217.64') {
    candidates.push(window.location.origin);
  }

  // If we already have a winning node, test it first
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && saved.startsWith('http')) candidates.push(saved);
    } catch {}
  }

  // Direct VPS nodes (handles heavy audio streams & unmetered bandwidth)
  candidates.push(...CLUSTER_BACKENDS);

  // Vercel / current origin as fast fallback for API routes
  if (window.location.origin && window.location.protocol.startsWith('http')) {
    candidates.push(window.location.origin);
  }

  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}
