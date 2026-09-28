/* Frana Tattoo Control — service worker (abrir sem internet)
 *
 * - Página do app: busca na internet primeiro (pega atualização); sem conexão, usa a última cópia.
 * - Biblioteca do Supabase (cdn.jsdelivr.net) e fontes do Google: guarda cópia e usa ela.
 * - Chamadas pro supabase.co NÃO passam por aqui (dados sempre pela internet; o app cuida da cópia dele).
 *
 * Quando mudar este arquivo, troque a VERSION (ela também vira o nome do cache).
 */
const VERSION = '2026.09.28-offline-1';
const CACHE = 'ftc-' + VERSION;

const SCOPE_URL = self.registration.scope;
const INDEX_URL = new URL('./index.html', SCOPE_URL).href;
const ROOT_URL = new URL('./', SCOPE_URL).href;

const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const NAV_TIMEOUT_MS = 4000; // internet ruim: depois disso usa a cópia guardada

async function putSafe(cache, key, res) {
  try { if (res && (res.ok || res.type === 'opaque')) await cache.put(key, res); } catch (e) { /* cota cheia etc. */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    // 1) a página
    try {
      const res = await fetch(new Request(INDEX_URL, { cache: 'reload' }));
      if (res.ok) { await putSafe(cache, INDEX_URL, res.clone()); await putSafe(cache, ROOT_URL, res.clone()); }
    } catch (e) { /* sem internet agora: a página é guardada no primeiro acesso */ }

    // 2) biblioteca do Supabase
    try { await putSafe(cache, SUPABASE_LIB, await fetch(SUPABASE_LIB, { mode: 'cors', credentials: 'omit' })); } catch (e) {}

    // 3) fontes do Google (o CSS + só os arquivos "latin", que cobrem o português)
    try {
      const cssRes = await fetch(FONTS_CSS, { mode: 'cors', credentials: 'omit' });
      if (cssRes.ok) {
        const css = await cssRes.clone().text();
        await putSafe(cache, FONTS_CSS, cssRes);
        const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g;
        let m;
        while ((m = re.exec(css))) {
          if (m[1] !== 'latin') continue;
          try { await putSafe(cache, m[2], await fetch(m[2], { mode: 'cors', credentials: 'omit' })); } catch (e) {}
        }
      }
    } catch (e) {}

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ftc-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// biblioteca e fontes: usa a cópia; se não tiver, busca e guarda
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  let res;
  try { res = await fetch(req.url, { mode: 'cors', credentials: 'omit' }); }
  catch (e) { res = await fetch(req); }
  await putSafe(cache, req.url, res.clone());
  return res;
}

// a página do app: internet primeiro; sem conexão (ou muito lenta), última cópia guardada
async function networkFirst(event) {
  const req = event.request;
  const isNav = req.mode === 'navigate';
  const key = isNav ? INDEX_URL : req.url;
  const cache = await caches.open(CACHE);

  const netInit = { cache: 'no-cache', credentials: 'same-origin' };
  const netPromise = fetch(isNav ? new Request(req.url, netInit) : new Request(req, { cache: 'no-cache' }))
    .then(async (res) => {
      if (res && res.ok) await putSafe(cache, key, res.clone());
      return res;
    });
  try { event.waitUntil(netPromise.catch(() => {})); } catch (e) {} // deixa a atualização terminar em segundo plano

  const fromCache = async () => (await cache.match(key, { ignoreVary: true })) || (isNav ? await cache.match(ROOT_URL, { ignoreVary: true }) : null);

  try {
    const res = isNav
      ? await Promise.race([netPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), NAV_TIMEOUT_MS))])
      : await netPromise;
    if (res.status >= 500) { const c = await fromCache(); if (c) return c; }
    return res;
  } catch (e) {
    const cached = await fromCache();
    if (cached) return cached;
    return netPromise; // nada guardado ainda: espera a internet mesmo
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // dados: sempre pela internet, sem service worker no meio
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;

  if (CDN_HOSTS.includes(url.hostname)) { event.respondWith(cacheFirst(req)); return; }
  if (url.origin === self.location.origin) { event.respondWith(networkFirst(event)); return; }
  // outras origens: segue normal
});
