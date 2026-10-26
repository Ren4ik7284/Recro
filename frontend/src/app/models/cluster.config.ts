export const CLUSTER_BACKENDS = [
  'https://recro.80.87.202.157.sslip.io',      // Moscow VPS (Direct in RU without VPN)
  'https://recro.177.3.217.64.sslip.io',       // Frankfurt VPS (Direct in Europe / with VPN)
  'https://node-home.80.87.202.157.sslip.io',  // Monoblock Edge Node (High-Capacity RU Cache)
];

export function resolveDefaultBackend(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8085';
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://${host}:8085`;
  }
  // If running directly on a VPS host (raw IP or domain)
  if (host === '80.87.202.157' || host.includes('80.87.202.157')) {
    return 'https://recro.80.87.202.157.sslip.io';
  }
  if (host === '177.3.217.64' || host.includes('177.3.217.64')) {
    return 'https://recro.177.3.217.64.sslip.io';
  }

  // Check if we already cached the fastest proven node from a previous race
  if (typeof localStorage !== 'undefined') {
    try {
      const saved = localStorage.getItem('recro_fastest_backend');
      if (saved && !saved.includes('vercel.app') && saved.startsWith('http')) return saved;
    } catch {}
  }

  // If on Vercel: use direct Moscow node by default
  if (host.includes('vercel.app')) {
    return CLUSTER_BACKENDS[0];
  }

  return CLUSTER_BACKENDS[0];
}

export function getClusterCandidates(): string[] {
  if (typeof window === 'undefined') return ['http://127.0.0.1:8085'];
  const candidates: string[] = [];
  const host = window.location.hostname || '';
  if (host === 'localhost' || host === '127.0.0.1') {
    candidates.push(`http://${host}:8085`);
  } else if (host === '80.87.202.157') {
    candidates.push('https://recro.80.87.202.157.sslip.io');
  } else if (host === '177.3.217.64') {
    candidates.push('https://recro.177.3.217.64.sslip.io');
  }

  // Direct VPS nodes (Moscow & Frankfurt)
  candidates.push(...CLUSTER_BACKENDS);

  return Array.from(new Set(candidates.map((u) => u.replace(/\/+$/, ''))));
}
