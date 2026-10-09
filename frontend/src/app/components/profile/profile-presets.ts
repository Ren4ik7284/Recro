export interface AvatarPreset {
  id: string;
  name: string;
  url: string;
}

export interface BannerPreset {
  id: string;
  name: string;
  gradient: string;
}

export interface AvatarFrame {
  id: string;
  name: string;
  color: string;
  cssClass: string;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg.trim())}`;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: 'studio-headphones',
    name: 'Наушники',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_sh" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#18181b"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_sh)"/>
        <path d="M36 68 C36 46, 46 34, 64 34 C82 34, 92 46, 92 68" fill="none" stroke="#e4e4e7" stroke-width="5" stroke-linecap="round"/>
        <rect x="28" y="60" width="14" height="26" rx="7" fill="#27272a" stroke="#a1a1aa" stroke-width="2"/>
        <rect x="86" y="60" width="14" height="26" rx="7" fill="#27272a" stroke="#a1a1aa" stroke-width="2"/>
        <line x1="56" y1="73" x2="56" y2="81" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
        <line x1="64" y1="68" x2="64" y2="86" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
        <line x1="72" y1="73" x2="72" y2="81" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'vinyl-groove',
    name: 'Винил',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_vg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#141416"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_vg)"/>
        <circle cx="64" cy="64" r="48" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
        <circle cx="64" cy="64" r="38" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.5"/>
        <circle cx="64" cy="64" r="28" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
        <circle cx="64" cy="64" r="18" fill="#27272a" stroke="#71717a" stroke-width="1.5"/>
        <circle cx="64" cy="64" r="5" fill="#09090b" stroke="#ffffff" stroke-width="1.5"/>
        <path d="M42 36 A48 48 0 0 1 86 36" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3.5" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'soundwave-dark',
    name: 'Сигнал',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_sw" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#1e1b4b"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_sw)"/>
        <line x1="32" y1="64" x2="32" y2="64" stroke="#818cf8" stroke-width="4" stroke-linecap="round"/>
        <line x1="40" y1="56" x2="40" y2="72" stroke="#818cf8" stroke-width="4" stroke-linecap="round"/>
        <line x1="48" y1="46" x2="48" y2="82" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/>
        <line x1="56" y1="38" x2="56" y2="90" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
        <line x1="64" y1="32" x2="64" y2="96" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
        <line x1="72" y1="38" x2="72" y2="90" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
        <line x1="80" y1="46" x2="80" y2="82" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/>
        <line x1="88" y1="56" x2="88" y2="72" stroke="#818cf8" stroke-width="4" stroke-linecap="round"/>
        <line x1="96" y1="64" x2="96" y2="64" stroke="#818cf8" stroke-width="4" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'studio-microphone',
    name: 'Микрофон',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_sm" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#18181b"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_sm)"/>
        <rect x="52" y="32" width="24" height="40" rx="12" fill="#27272a" stroke="#d4d4d8" stroke-width="2"/>
        <line x1="56" y1="44" x2="72" y2="44" stroke="#71717a" stroke-width="1.8"/>
        <line x1="56" y1="52" x2="72" y2="52" stroke="#71717a" stroke-width="1.8"/>
        <path d="M44 58 C44 76, 84 76, 84 58" fill="none" stroke="#d4d4d8" stroke-width="4" stroke-linecap="round"/>
        <line x1="64" y1="76" x2="64" y2="92" stroke="#d4d4d8" stroke-width="4" stroke-linecap="round"/>
        <line x1="50" y1="92" x2="78" y2="92" stroke="#d4d4d8" stroke-width="4" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'synthesizer-keys',
    name: 'Синтезатор',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_sk" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#1f2937"/>
            <stop offset="100%" stop-color="#0f172a"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_sk)"/>
        <g transform="translate(24, 38)">
          <rect x="0" y="0" width="80" height="52" rx="8" fill="#f4f4f5"/>
          <line x1="16" y1="0" x2="16" y2="52" stroke="#cbd5e1" stroke-width="1.5"/>
          <line x1="32" y1="0" x2="32" y2="52" stroke="#cbd5e1" stroke-width="1.5"/>
          <line x1="48" y1="0" x2="48" y2="52" stroke="#cbd5e1" stroke-width="1.5"/>
          <line x1="64" y1="0" x2="64" y2="52" stroke="#cbd5e1" stroke-width="1.5"/>
          <rect x="11" y="0" width="10" height="32" rx="2" fill="#18181b"/>
          <rect x="27" y="0" width="10" height="32" rx="2" fill="#18181b"/>
          <rect x="43" y="0" width="10" height="32" rx="2" fill="#18181b"/>
          <rect x="59" y="0" width="10" height="32" rx="2" fill="#18181b"/>
        </g>
      </svg>
    `),
  },
  {
    id: 'audio-cassette',
    name: 'Кассета',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_ac" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2e1065"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_ac)"/>
        <rect x="28" y="44" width="72" height="42" rx="6" fill="#18181b" stroke="#71717a" stroke-width="2"/>
        <rect x="38" y="52" width="52" height="24" rx="4" fill="#27272a"/>
        <circle cx="50" cy="64" r="6" fill="#09090b" stroke="#a1a1aa" stroke-width="1.5"/>
        <circle cx="78" cy="64" r="6" fill="#09090b" stroke="#a1a1aa" stroke-width="1.5"/>
        <rect x="60" y="61" width="8" height="6" fill="#ffffff"/>
      </svg>
    `),
  },
  {
    id: 'equalizer-mixer',
    name: 'Микшер',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_em" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#064e3b"/>
            <stop offset="100%" stop-color="#022c22"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_em)"/>
        <line x1="42" y1="36" x2="42" y2="92" stroke="#27272a" stroke-width="4" stroke-linecap="round"/>
        <line x1="64" y1="36" x2="64" y2="92" stroke="#27272a" stroke-width="4" stroke-linecap="round"/>
        <line x1="86" y1="36" x2="86" y2="92" stroke="#27272a" stroke-width="4" stroke-linecap="round"/>
        <rect x="36" y="52" width="12" height="16" rx="3" fill="#ffffff" stroke="#10b981" stroke-width="1.5"/>
        <rect x="58" y="42" width="12" height="16" rx="3" fill="#ffffff" stroke="#10b981" stroke-width="1.5"/>
        <rect x="80" y="68" width="12" height="16" rx="3" fill="#ffffff" stroke="#10b981" stroke-width="1.5"/>
      </svg>
    `),
  },
  {
    id: 'studio-speaker',
    name: 'Монитор',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="bg_sp" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#27272a"/>
            <stop offset="100%" stop-color="#18181b"/>
          </linearGradient>
        </defs>
        <rect width="128" height="128" rx="64" fill="url(#bg_sp)"/>
        <rect x="38" y="30" width="52" height="68" rx="8" fill="#18181b" stroke="#71717a" stroke-width="2"/>
        <circle cx="64" cy="46" r="8" fill="#09090b" stroke="#a1a1aa" stroke-width="1.5"/>
        <circle cx="64" cy="74" r="16" fill="#09090b" stroke="#a1a1aa" stroke-width="2"/>
        <circle cx="64" cy="74" r="6" fill="#27272a"/>
      </svg>
    `),
  },
];

export const BANNER_PRESETS: BannerPreset[] = [
  {
    id: 'obsidian-noir',
    name: 'Обсидиан',
    gradient: 'linear-gradient(135deg, #1f1f23 0%, #141416 50%, #09090b 100%)',
  },
  {
    id: 'midnight-violet',
    name: 'Полуночный индиго',
    gradient: 'linear-gradient(135deg, #2e1065 0%, #170938 50%, #09090b 100%)',
  },
  {
    id: 'deep-slate',
    name: 'Графит',
    gradient: 'linear-gradient(135deg, #334155 0%, #1e293b 50%, #09090b 100%)',
  },
  {
    id: 'navy-noir',
    name: 'Глубокий синий',
    gradient: 'linear-gradient(135deg, #0f172a 0%, #020617 60%, #09090b 100%)',
  },
  {
    id: 'emerald-noir',
    name: 'Изумрудный нуар',
    gradient: 'linear-gradient(135deg, #064e3b 0%, #022c22 60%, #09090b 100%)',
  },
  {
    id: 'burgundy-noir',
    name: 'Темный бордо',
    gradient: 'linear-gradient(135deg, #450a0a 0%, #1c0404 60%, #09090b 100%)',
  },
  {
    id: 'platinum-noir',
    name: 'Платина',
    gradient: 'linear-gradient(135deg, #52525b 0%, #27272a 60%, #09090b 100%)',
  },
  {
    id: 'carbon-steel',
    name: 'Карбон',
    gradient: 'linear-gradient(135deg, #27272a 0%, #18181b 50%, #09090b 100%)',
  },
];

export const AVATAR_FRAMES: AvatarFrame[] = [
  { id: 'default', name: 'Обычный', color: '#71717a', cssClass: 'avatar-frame-default' },
  { id: 'white-clean', name: 'Белый монохром', color: '#ffffff', cssClass: 'avatar-frame-white-clean' },
  { id: 'cyber-cyan', name: 'Бирюзовый', color: '#06b6d4', cssClass: 'avatar-frame-cyber-cyan' },
  { id: 'emerald-pulse', name: 'Изумрудный', color: '#10b981', cssClass: 'avatar-frame-emerald-pulse' },
  { id: 'silver-clean', name: 'Серебристый', color: '#e4e4e7', cssClass: 'avatar-frame-silver-clean' },
  { id: 'gold-vip', name: 'Бронза', color: '#d97706', cssClass: 'avatar-frame-gold-vip' },
];

export const VIBE_PRESETS: string[] = [
  'В наушниках',
  'В поиске звука',
  'Только новый материал',
  'Ночной режим',
  'Максимальная громкость',
  'Работа со звуком',
  'Слушаю плейлист',
  'Фокус',
];

export interface PlaylistCoverPreset {
  id: string;
  name: string;
  url: string;
}

export const PLAYLIST_COVER_PRESETS: PlaylistCoverPreset[] = [
  {
    id: 'pl-minimal-white',
    name: 'Минимал',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_g1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#18181b"/>
            <stop offset="50%" stop-color="#0f0f12"/>
            <stop offset="100%" stop-color="#050507"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_g1)"/>
        <circle cx="200" cy="180" r="100" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.25"/>
        <circle cx="200" cy="180" r="70" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.6"/>
        <polygon points="185,150 230,180 185,210" fill="#ffffff"/>
        <line x1="120" y1="310" x2="280" y2="310" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
        <line x1="150" y1="322" x2="250" y2="322" stroke="#71717a" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'pl-vinyl-record',
    name: 'Винил',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_v1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#18181b"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_v1)"/>
        <circle cx="200" cy="200" r="150" fill="#121215" stroke="#27272a" stroke-width="4"/>
        <circle cx="200" cy="200" r="120" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.5"/>
        <circle cx="200" cy="200" r="90" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>
        <circle cx="200" cy="200" r="60" fill="#27272a" stroke="#d97706" stroke-width="3"/>
        <circle cx="200" cy="200" r="16" fill="#09090b" stroke="#fafafa" stroke-width="2"/>
        <path d="M110 110 A150 150 0 0 1 290 110" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="6" stroke-linecap="round"/>
      </svg>
    `),
  },
  {
    id: 'pl-cassette-tape',
    name: 'Кассета',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_c1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#1e1b4b"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_c1)"/>
        <rect x="70" y="110" width="260" height="170" rx="16" fill="#18181b" stroke="#3f3f46" stroke-width="3"/>
        <rect x="110" y="145" width="180" height="70" rx="8" fill="#27272a"/>
        <circle cx="150" cy="180" r="20" fill="#09090b" stroke="#a1a1aa" stroke-width="3"/>
        <circle cx="250" cy="180" r="20" fill="#09090b" stroke="#a1a1aa" stroke-width="3"/>
        <rect x="180" y="170" width="40" height="20" rx="3" fill="#3f3f46"/>
        <path d="M95 240 L130 270 L270 270 L305 240 Z" fill="#27272a" stroke="#3f3f46" stroke-width="2"/>
      </svg>
    `),
  },
  {
    id: 'pl-spectrum-wave',
    name: 'Эквалайзер',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_sp" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#064e3b"/>
            <stop offset="100%" stop-color="#021c16"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_sp)"/>
        <g transform="translate(60, 110)">
          <rect x="20" y="120" width="16" height="60" rx="4" fill="#10b981"/>
          <rect x="50" y="80" width="16" height="100" rx="4" fill="#10b981"/>
          <rect x="80" y="40" width="16" height="140" rx="4" fill="#34d399"/>
          <rect x="110" y="10" width="16" height="170" rx="4" fill="#6ee7b7"/>
          <rect x="140" y="60" width="16" height="120" rx="4" fill="#34d399"/>
          <rect x="170" y="30" width="16" height="150" rx="4" fill="#6ee7b7"/>
          <rect x="200" y="90" width="16" height="90" rx="4" fill="#10b981"/>
          <rect x="230" y="130" width="16" height="50" rx="4" fill="#059669"/>
        </g>
      </svg>
    `),
  },
  {
    id: 'pl-vinyl-groove',
    name: 'Винил',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_vg_bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#27272a"/>
            <stop offset="100%" stop-color="#09090b"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_vg_bg)"/>
        <circle cx="200" cy="200" r="140" fill="#18181b" stroke="#3f3f46" stroke-width="2"/>
        <circle cx="200" cy="200" r="110" fill="none" stroke="#27272a" stroke-width="2"/>
        <circle cx="200" cy="200" r="80" fill="none" stroke="#27272a" stroke-width="2"/>
        <circle cx="200" cy="200" r="45" fill="#fafafa"/>
        <circle cx="200" cy="200" r="10" fill="#09090b"/>
      </svg>
    `),
  },
  {
    id: 'pl-lofi-moon',
    name: 'Лоу-фай',
    url: svgToDataUrl(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
        <defs>
          <linearGradient id="pl_lf_bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0f172a"/>
            <stop offset="100%" stop-color="#020617"/>
          </linearGradient>
        </defs>
        <rect width="400" height="400" fill="url(#pl_lf_bg)"/>
        <circle cx="200" cy="180" r="75" fill="#f1f5f9" opacity="0.9"/>
        <circle cx="230" cy="165" r="70" fill="#0f172a"/>
        <path d="M50 290 Q 200 240, 350 290 L 350 350 L 50 350 Z" fill="#1e293b"/>
        <path d="M50 320 Q 200 275, 350 320 L 350 350 L 50 350 Z" fill="#090d16"/>
      </svg>
    `),
  },
];
