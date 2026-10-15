import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist/frontend/browser');
const indexPath = path.resolve(distDir, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('index.html not found at', indexPath);
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf-8');

const match = html.match(/<script src="(main-[a-zA-Z0-9_-]+\.js)" type="module"><\/script>/);
if (!match) {
  console.log('No unpatched main-*.js script tag found.');
  process.exit(0);
}

const bundleName = match[1];
const bundlePath = path.resolve(distDir, bundleName);
const rawBuffer = fs.readFileSync(bundlePath);
const rawSize = rawBuffer.length;

// Pre-compress with max gzip
const gzBuffer = zlib.gzipSync(rawBuffer, { level: 9 });
const gzName = `${bundleName}.gz`;
const gzPath = path.resolve(distDir, gzName);
fs.writeFileSync(gzPath, gzBuffer);
const gzSize = gzBuffer.length;

console.log(`Bundle: ${bundleName} (Raw: ${rawSize} bytes, Gzip: ${gzSize} bytes)`);

const chunkedLoaderScript = `
  <script>
    (async function() {
      const bundleName = '${bundleName}';
      const gzName = '${gzName}';
      const rawSize = ${rawSize};
      const gzSize = ${gzSize};
      const chunkSize = 16384; // 16KB slices to strictly stay under tunnel limit

      const statusEl = document.getElementById('recro-status');
      const barEl = document.getElementById('recro-bar');

      function updateUI(text, pct, isError) {
        if (statusEl) {
          statusEl.textContent = text;
          if (isError) statusEl.style.color = '#ef4444';
        }
        if (barEl && pct !== undefined) barEl.style.width = pct + '%';
      }

      window.addEventListener('error', function(e) {
        console.error('[Global JS Error]', e);
        updateUI('Ошибка: ' + (e.message || 'скрипт'), undefined, true);
      });

      function bootScript(jsCode) {
        updateUI('Запуск...', 100);
        try {
          const s = document.createElement('script');
          s.type = 'module';
          s.textContent = jsCode;
          document.head.appendChild(s);
        } catch (err) {
          console.warn('Inline boot failed, trying blob with explicit JS MIME:', err);
          try {
            const blob = new Blob([jsCode], { type: 'text/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            const s2 = document.createElement('script');
            s2.type = 'module';
            s2.src = blobUrl;
            s2.onerror = function(e2) {
              console.error('Blob boot failed:', e2);
              updateUI('Ошибка запуска JS', 0, true);
            };
            document.head.appendChild(s2);
          } catch (e2) {
            updateUI('Ошибка: ' + (e2.message || err.message), 0, true);
          }
        }
      }

      try {
        // 1. Instant Boot from Browser Cache if previously downloaded
        if ('caches' in window) {
          try {
            const cache = await caches.open('recro-bundle-v2');
            const cachedRes = await cache.match(bundleName);
            if (cachedRes) {
              updateUI('Запуск из кэша...', 100);
              const jsCode = await cachedRes.text();
              bootScript(jsCode);
              return;
            }
          } catch (e) {
            console.warn('Cache lookup failed, downloading:', e);
          }
        }

        // 2. Determine compression support
        const useGzip = typeof window.DecompressionStream === 'function';
        const targetUrl = useGzip ? gzName : bundleName;
        const totalSize = useGzip ? gzSize : rawSize;
        const totalChunks = Math.ceil(totalSize / chunkSize);
        const chunks = new Array(totalChunks);
        let loaded = 0;

        const queue = [];
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize - 1, totalSize - 1);
          queue.push({ index: i, start, end });
        }

        async function fetchSliceWithRetry(item) {
          let attempts = 7;
          let delay = 100;
          while (attempts-- > 0) {
            try {
              const url = targetUrl + '?slice=' + item.index + '&t=' + Date.now();
              const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3500) : undefined;
              const res = await fetch(url, {
                headers: { 'Range': 'bytes=' + item.start + '-' + item.end },
                signal: timeoutSignal
              });
              if (res.ok || res.status === 206) {
                const buf = await res.arrayBuffer();
                if (buf && buf.byteLength > 0) {
                  chunks[item.index] = buf;
                  return;
                }
              }
            } catch (err) {
              console.warn('Chunk ' + item.index + ' retry (' + attempts + ' left):', err);
            }
            await new Promise(r => setTimeout(r, delay));
            delay = Math.min(delay * 1.5, 800);
          }
          throw new Error('Сегмент ' + item.index + ' не ответил');
        }

        async function worker() {
          while (queue.length > 0) {
            const item = queue.shift();
            await fetchSliceWithRetry(item);
            loaded++;
            const pct = Math.round((loaded / totalChunks) * 100);
            updateUI('Загрузка: ' + pct + '%', pct);
          }
        }

        // Run 2 workers to keep connection queue clean and predictable
        updateUI('Загрузка: 0%', 0);
        await Promise.all([worker(), worker()]);

        let jsCode;
        if (useGzip) {
          updateUI('Распаковка...', 99);
          const compressedBlob = new Blob(chunks, { type: 'application/gzip' });
          const decompressedStream = compressedBlob.stream().pipeThrough(new DecompressionStream('gzip'));
          jsCode = await new Response(decompressedStream).text();
        } else {
          const textDecoder = new TextDecoder('utf-8');
          jsCode = chunks.map(c => textDecoder.decode(c, { stream: true })).join('') + textDecoder.decode();
        }

        // Cache assembled JS for instant boot on subsequent visits
        if ('caches' in window) {
          caches.open('recro-bundle-v2')
            .then(cache => cache.put(bundleName, new Response(jsCode, { headers: { 'Content-Type': 'text/javascript' } })))
            .catch(() => {});
        }

        bootScript(jsCode);
      } catch (err) {
        console.error('Chunked loader failure, attempting fallback:', err);
        updateUI('Ошибка загрузки: ' + (err.message || 'сеть'), 0, true);
        setTimeout(() => {
          import('./' + bundleName).catch(e => {
            console.error('Direct fallback failed:', e);
          });
        }, 1000);
      }
    })();
  </script>`;

html = html.replace(match[0], chunkedLoaderScript);
fs.writeFileSync(indexPath, html, 'utf-8');
console.log('Successfully patched index.html with inline-boot chunked loader!');
