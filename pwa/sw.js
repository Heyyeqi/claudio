const CACHE = 'claudio-v1'
const STATIC = ['/', '/index.html', '/app.js', '/style.css']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ))
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)

  // cache/tts/ → cache-first
  if (url.pathname.startsWith('/cache/tts/')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached
        return fetch(e.request).then(res => {
          const clone = res.clone()
          caches.open(CACHE).then(c => c.put(e.request, clone))
          return res
        })
      })
    )
    return
  }

  // 静态文件 → cache-first
  if (STATIC.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    )
  }
})
