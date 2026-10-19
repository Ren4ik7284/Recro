export const CLUSTER_BACKENDS = [
  'https://recro.80.87.202.157.sslip.io', // Moscow VPS (Direct, ultra-fast in RU without VPN)
  'https://recro.177.3.217.64.sslip.io',  // Frankfurt VPS (Direct, ultra-fast in Europe / with VPN)
  'https://80-87-202-157.sslip.io',       // Moscow VPS alternate domain
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
  // On Vercel or other frontend host: default to Moscow VPS for ultra-fast unmetered streaming
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

  // Direct VPS nodes first (handles heavy audio streams & partial content)
  candidates.push(...CLUSTER_BACKENDS);

  // Vercel / current origin as emergency fallback for API routes
  if (window.location.origin && window.location.protocol.startsWith('http')) {
    candidates.push(window.location.origin);
  }

  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}
