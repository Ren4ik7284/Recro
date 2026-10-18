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
  if (host.includes('80.87.202.157') || host.includes('177.3.217.64')) {
    return window.location.origin;
  }
  return CLUSTER_BACKENDS[0];
}
