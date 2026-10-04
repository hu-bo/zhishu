import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Only caches the public application shell; authenticated API data stays in scoped IndexedDB. */
export function offlineWorker(): Plugin {
  return {
    name: 'zhishu-offline-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = [
        'index.html',
        'favicon.svg',
        ...Object.keys(bundle).filter((file) => /\.(?:js|css|woff2?)$/.test(file)),
      ];
      const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source: `
const CACHE = 'zhishu-shell-${version}';
const FILES = ${JSON.stringify(files)};
const url = file => new URL(file, self.registration.scope).href;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => Promise.all(FILES.map(async file => {
  const response = await fetch(url(file), {cache:'reload'});
  const type = response.headers.get('content-type') || '';
  if(!response.ok || (file.endsWith('.js') && !/(?:javascript|ecmascript)/i.test(type)) || (file.endsWith('.css') && !type.includes('text/css')))
    throw new Error('Application shell is incomplete');
  await cache.put(url(file), response);
}))).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('zhishu-shell-')).slice(0,-2).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request;
  const target = new URL(request.url);
  if(request.method !== 'GET' || target.origin !== self.location.origin || target.pathname.startsWith('/api/')) return;
  if(request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match(url('index.html')))));
    return;
  }
  if(FILES.some(file => url(file) === target.href) || target.pathname.includes('/assets/'))
    event.respondWith(caches.match(request, {ignoreVary:true}).then(cached => cached || fetch(request)));
});
`,
      });
    },
  };
}
