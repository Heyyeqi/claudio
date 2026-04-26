require('dotenv').config()

const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const OpenAI = require('openai')
const os = require('os')
const path = require('path')
const fs = require('fs')

const router = require('./core/router')
const context = require('./core/context')
const claude = require('./core/claude')
const tts = require('./core/tts')
const state = require('./core/state')
const scheduler = require('./core/scheduler')

const explainClient = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})
const explainAngles = [
  '1. 用今天的日期/节气/农历/天气说话，让情境本身成为理由',
  '2. 借助这首歌或歌手的真实故事，找到和听者情绪的交叉点，用故事作桥梁',
  '3. 只描述这首歌的质感，说它和此刻情绪的共振关系',
  '4. 解释一个反直觉的选择——为什么这首看似不相关的歌是此刻的出口',
]
let recentExplainOpenings = []

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server, path: '/stream' })

const wsClients = []
let latestStationPayload = null
wss.on('connection', ws => {
  wsClients.push(ws)

  if (latestStationPayload) {
    ws.send(JSON.stringify(latestStationPayload))
    if (latestStationPayload.queue?.length > 0) {
      ws.send(JSON.stringify({ type: 'now-playing', ...latestStationPayload.queue[0], queue: latestStationPayload.queue }))
    }
  }

  ws.on('close', () => {
    const i = wsClients.indexOf(ws)
    if (i !== -1) wsClients.splice(i, 1)
  })
})
scheduler.setWsClients(wsClients)

// ── 内存播放队列 ──────────────────────────────
// 每项：{ song_info: {id, name, artist}, play_url }
let playQueue = []
let isReplenishingQueue = false
let currentNowPlaying = null
const MIN_BATCH_SIZE = 8
const MAX_BATCH_SIZE = 12
const LOW_WATER_MARK = 5
const ncmSearchCache = new Map()
const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const SEARCH_CACHE_MISS_TTL_MS = 30 * 60 * 1000
const NCM_ID_MAP_PREF = 'ncm_id_map_v1'
const MAX_NCM_ID_MAP_SIZE = 400
const RECENT_RECOMMENDED_PREF = 'recent_recommended_keys_v1'
const MAX_RECENT_RECOMMENDED_KEYS = 160

function loadNcmIdMap() {
  try {
    const raw = state.getPref(NCM_ID_MAP_PREF)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

let ncmIdMap = loadNcmIdMap()
let recentRecommendedKeys = loadRecentRecommendedKeys()

function queuePop() {
  return playQueue.shift() || null
}

function makeSongLookupKey(name, artist) {
  return `${normalizeNcmText(name)}::${normalizeNcmText(artist)}`
}

function persistNcmIdMap() {
  const entries = Object.entries(ncmIdMap)
    .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
    .slice(0, MAX_NCM_ID_MAP_SIZE)
  ncmIdMap = Object.fromEntries(entries)
  state.setPref(NCM_ID_MAP_PREF, JSON.stringify(ncmIdMap))
}

function rememberSongIdMapping(name, artist, songId, status = 'hit') {
  const key = makeSongLookupKey(name, artist)
  ncmIdMap[key] = { id: songId || null, status, updatedAt: Date.now() }
  persistNcmIdMap()
}

function getRememberedSongId(name, artist) {
  const remembered = ncmIdMap[makeSongLookupKey(name, artist)]
  if (!remembered) return null
  if (remembered.status === 'miss' && Date.now() - remembered.updatedAt > SEARCH_CACHE_MISS_TTL_MS) {
    delete ncmIdMap[makeSongLookupKey(name, artist)]
    persistNcmIdMap()
    return null
  }
  return remembered
}

function getCachedSearchIds(cacheKey) {
  const cached = ncmSearchCache.get(cacheKey)
  if (!cached) return null
  if (Date.now() > cached.expiresAt) {
    ncmSearchCache.delete(cacheKey)
    return null
  }
  return cached.ids
}

function setCachedSearchIds(cacheKey, ids) {
  const isHit = Array.isArray(ids) && ids.length > 0
  ncmSearchCache.set(cacheKey, {
    ids: Array.isArray(ids) ? ids.slice(0, 5) : [],
    expiresAt: Date.now() + (isHit ? SEARCH_CACHE_TTL_MS : SEARCH_CACHE_MISS_TTL_MS),
  })
}

function queueKeyFromItem(item) {
  if (!item?.song_info) return ''
  return `${item.song_info.name}::${item.song_info.artist}`.toLowerCase()
}

function loadRecentRecommendedKeys() {
  try {
    const raw = state.getPref(RECENT_RECOMMENDED_PREF)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(item => String(item).toLowerCase()) : []
  } catch {
    return []
  }
}

function persistRecentRecommendedKeys() {
  const unique = []
  const seen = new Set()
  for (let i = recentRecommendedKeys.length - 1; i >= 0; i--) {
    const key = String(recentRecommendedKeys[i] || '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.unshift(key)
    if (unique.length >= MAX_RECENT_RECOMMENDED_KEYS) break
  }
  recentRecommendedKeys = unique
  state.setPref(RECENT_RECOMMENDED_PREF, JSON.stringify(recentRecommendedKeys))
}

function rememberRecentRecommendedQueue(queue) {
  const keys = (Array.isArray(queue) ? queue : [])
    .map(queueKeyFromItem)
    .filter(Boolean)
  if (!keys.length) return
  recentRecommendedKeys = [...recentRecommendedKeys, ...keys]
  persistRecentRecommendedKeys()
}

function getRecentRecommendedKeySet() {
  return new Set(recentRecommendedKeys)
}

function makeSongPayload(song) {
  return {
    id: song?.id || null,
    name: song?.name || '',
    artist: song?.artist || '',
  }
}

function dedupeQueueItems(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = queueKeyFromItem(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function markBatchEdges(items) {
  return items.map((item, index) => ({
    ...item,
    queue_meta: {
      ...(item.queue_meta || {}),
      batch_role:
        index === 0 ? 'first'
        : index === items.length - 1 ? 'last'
        : null,
    },
  }))
}

function filterQueueCandidates(items, currentQueue, recentPlays, recentRecommended = new Set()) {
  const recentKeys = new Set(recentPlays.map(p => `${p.song_name}::${p.artist}`.toLowerCase()))
  const currentQueueKeys = new Set((currentQueue || []).map(queueKeyFromItem).filter(Boolean))

  return dedupeQueueItems(items.filter(item => {
    const key = `${item.song_info.name}::${item.song_info.artist}`.toLowerCase()
    if (recentKeys.has(key)) {
      console.log(`[queue] 过滤重复: ${item.song_info.name} / ${item.song_info.artist}`)
      return false
    }
    if (currentQueueKeys.has(key)) {
      console.log(`[queue] 过滤队列已有: ${item.song_info.name} / ${item.song_info.artist}`)
      return false
    }
    if (recentRecommended.has(key)) {
      console.log(`[queue] 过滤近期推荐: ${item.song_info.name} / ${item.song_info.artist}`)
      return false
    }
    return true
  }))
}

function getLanUrls(port) {
  const networks = os.networkInterfaces()
  const urls = []

  for (const entries of Object.values(networks)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`)
      }
    }
  }

  return [...new Set(urls)]
}

function pickExplainAngle() {
  const index = Math.floor(Math.random() * explainAngles.length)
  return explainAngles[index]
}

function extractExplainOpening(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return ''
  const firstChunk = trimmed.split(/[，。！？；,.!?;]/)[0].trim()
  return firstChunk.slice(0, 18)
}

function rememberExplainOpening(text) {
  const opening = extractExplainOpening(text)
  if (!opening) return
  recentExplainOpenings.push(opening)
  recentExplainOpenings = recentExplainOpenings.slice(-2)
}

// ── NCM 工具 ─────────────────────────────────
const COOKIE_PATH = path.join(__dirname, 'user/ncm-cookie.json')

function getNcmCookie() {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8')).raw || ''
  } catch { return '' }
}

async function ncmFetch(url) {
  const cookie = getNcmCookie()
  // NeteaseCloudMusicApi 要求 cookie 以查询参数传入，不能用请求头
  const finalUrl = cookie
    ? url + (url.includes('?') ? '&' : '?') + 'cookie=' + encodeURIComponent(cookie)
    : url
  const res = await fetch(finalUrl)
  return res.json()
}

function normalizeNcmText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/（.*?）|\(.*?\)|\[.*?\]|【.*?】/g, ' ')
    .replace(/feat\.?|ft\.?|with|live|version|ver\.?/gi, ' ')
    .replace(/[·•・,，'’":：/\\|!！?？\-.]/g, ' ')
    .replace(/\s+/g, '')
    .trim()
}

function normalizeSongCore(text) {
  return String(text || '')
    .replace(/（.*?）|\(.*?\)|\[.*?\]|【.*?】/g, ' ')
    .replace(/\b(live|demo|version|ver\.?|remaster(ed)?|acoustic|mix)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitArtistNames(text) {
  return String(text || '')
    .split(/\/|&|,|，|、| x | X | feat\.?|ft\.?|with/gi)
    .map(part => normalizeNcmText(part))
    .filter(Boolean)
}

function scoreNcmCandidate(song, expectedName, expectedArtistParts) {
  const candidateName = normalizeNcmText(song?.name)
  const candidateCore = normalizeNcmText(normalizeSongCore(song?.name))
  const expectedNameNorm = normalizeNcmText(expectedName)
  const expectedCoreNorm = normalizeNcmText(normalizeSongCore(expectedName))
  const candidateArtists = (song?.artists || []).map(a => normalizeNcmText(a.name)).filter(Boolean)

  let score = 0
  if (candidateName === expectedNameNorm) score += 70
  else if (candidateCore === expectedCoreNorm) score += 56
  else if (candidateName.includes(expectedCoreNorm) || expectedCoreNorm.includes(candidateName)) score += 40

  for (const artistPart of expectedArtistParts) {
    if (candidateArtists.includes(artistPart)) score += 24
    else if (candidateArtists.some(name => name.includes(artistPart) || artistPart.includes(name))) score += 12
  }

  if (song?.alia?.length) {
    const aliasHit = song.alia.some(alias => {
      const normalizedAlias = normalizeNcmText(alias)
      return normalizedAlias === expectedNameNorm || normalizedAlias === expectedCoreNorm
    })
    if (aliasHit) score += 16
  }

  return score
}

async function ncmSearch(name, artist) {
  const base = process.env.NCM_API_BASE || 'http://localhost:3000'
  const cacheKey = `${normalizeNcmText(name)}::${normalizeNcmText(artist)}`
  const cached = getCachedSearchIds(cacheKey)
  if (cached) {
    console.log(`[ncm] 命中搜索缓存 "${name} / ${artist}" -> ${cached.join(', ') || 'MISS'}`)
    return cached
  }

  const queries = [
    `${name} ${artist}`.trim(),
    normalizeSongCore(name),
  ].filter(Boolean)

  const seenIds = new Set()
  const candidates = []
  const expectedArtistParts = splitArtistNames(artist)

  for (const query of queries) {
    const q = encodeURIComponent(query)
    const data = await ncmFetch(`${base}/search?keywords=${q}&limit=15`)
    const songs = data?.result?.songs || []
    for (const song of songs) {
      const id = String(song.id)
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const score = scoreNcmCandidate(song, name, expectedArtistParts)
      if (score < 36) continue
      candidates.push({ id, score, song })
    }
    if (candidates.length >= 5) break
  }

  candidates.sort((a, b) => b.score - a.score)

  if (!candidates.length) {
    console.log(`[ncm] 搜索 "${name} / ${artist}" 无可靠结果，跳过`)
    setCachedSearchIds(cacheKey, [])
    return []
  }

  const ids = candidates.slice(0, 5).map(item => item.id)
  setCachedSearchIds(cacheKey, ids)
  return ids
}

async function ncmGetUrl(songId, name, artist) {
  const base = process.env.NCM_API_BASE || 'http://localhost:3000'
  const tried = new Set()
  const candidateIds = []
  const remembered = getRememberedSongId(name, artist)

  if (remembered?.id) candidateIds.push(String(remembered.id))
  if (songId && String(songId) !== '0') candidateIds.push(String(songId))

  for (const candidateId of candidateIds) {
    if (!candidateId || tried.has(candidateId)) continue
    tried.add(candidateId)

    const data = await ncmFetch(`${base}/song/url/v1?id=${candidateId}&level=standard`)
    const item = data?.data?.[0]
    if (item?.url && item.code === 200) {
      rememberSongIdMapping(name, artist, candidateId, 'hit')
      if (candidateId !== String(songId)) {
        console.log(`[ncm] 搜索命中 "${name} / ${artist}" -> ${candidateId}`)
      }
      return { url: item.url, id: candidateId }
    }
  }

  console.log(`[ncm] id ${songId} 无效，搜索 "${name} ${artist}"`)
  const searchedIds = await ncmSearch(name, artist)
  for (const candidateId of searchedIds) {
    if (!candidateId || tried.has(candidateId)) continue
    tried.add(candidateId)

    const data = await ncmFetch(`${base}/song/url/v1?id=${candidateId}&level=standard`)
    const item = data?.data?.[0]
    if (item?.url && item.code === 200) {
      rememberSongIdMapping(name, artist, candidateId, 'hit')
      console.log(`[ncm] 搜索命中 "${name} / ${artist}" -> ${candidateId}`)
      return { url: item.url, id: candidateId }
    }
  }

  rememberSongIdMapping(name, artist, null, 'miss')
  return { url: null, id: null }
}

// 并行解析一批歌曲，返回有直链的条目
async function resolveQueue(songs) {
  const results = await Promise.all(
    songs.map(async song => {
      try {
        const { url, id: realId } = await ncmGetUrl(song.id, song.name, song.artist)
        if (!url) return null
        return { song_info: { ...song, id: realId || song.id }, play_url: url }
      } catch (e) {
        console.error(`[ncm] 解析 "${song.name}" 失败:`, e.message)
        return null
      }
    })
  )
  return results.filter(Boolean)
}

async function buildDjResponse(input, options = {}) {
  const {
    persistMessages = true,
    broadcast = false,
    currentQueue = playQueue,
    appendQueue = false,
    includeSpeech = true,
  } = options

  const intent = router.route(input)
  if (intent === 'system') {
    return { say: null, say_audio: null, queue: [], reason: '', segue: '', intent }
  }

  const ctx = await context.buildContext(input, { currentQueue })
  const result = await claude.askClaude(ctx)

  let queue = []
  const recentPlays = state.getRecentPlays(120)
  const recentRecommended = getRecentRecommendedKeySet()

  if (result.play && result.play.length > 0) {
    queue = await resolveQueue(result.play)
    queue = filterQueueCandidates(queue, currentQueue, recentPlays, recentRecommended)

    for (let attempt = 0; queue.length < MIN_BATCH_SIZE && attempt < 3; attempt++) {
      const refillPrompt = `继续补足队列，还需要 ${MIN_BATCH_SIZE - queue.length} 首，避开近期已播、当前队列里已有的歌，以及最近已经推荐过的歌`
      const refillCtx = await context.buildContext(refillPrompt, {
        currentQueue: [...(currentQueue || []), ...queue],
      })
      const refillResult = await claude.askClaude(refillCtx)
      const refillQueue = await resolveQueue(refillResult.play || [])
      const mergedQueue = [...queue, ...refillQueue]
      queue = filterQueueCandidates(mergedQueue, currentQueue, recentPlays, recentRecommended)
    }

    queue = queue.slice(0, MAX_BATCH_SIZE)
    queue = markBatchEdges(queue)

    scheduler.incrementCount()
  }

  playQueue = appendQueue
    ? dedupeQueueItems([...(currentQueue || []), ...queue])
    : [...queue]

  if (queue.length > 0) {
    rememberRecentRecommendedQueue(queue)
  }

  const say_audio = includeSpeech && result.say
    ? await tts.synthesize(result.say).catch(e => {
        console.error('[tts]', e.message)
        return null
      })
    : null

  if (persistMessages) {
    state.addMessage('user', input)
    state.addMessage('assistant', JSON.stringify(result))
  }

  if (broadcast) {
    latestStationPayload = {
      type: 'playlist-ready',
      say: result.say,
      say_audio,
      queue,
      reason: result.reason,
      segue: result.segue,
    }

    scheduler.broadcast(latestStationPayload)

    if (queue.length > 0) {
      scheduler.broadcast({ type: 'now-playing', ...queue[0], queue })
    }
  }

  if (includeSpeech && playQueue.length > 0 && playQueue.length < LOW_WATER_MARK) {
    replenishQueueSilently('post-build').catch(() => {})
  }

  return {
    say: includeSpeech ? result.say : null,
    say_audio,
    queue,
    reason: result.reason,
    segue: result.segue,
    intent,
  }
}

async function replenishQueueSilently(trigger = 'auto') {
  if (isReplenishingQueue || playQueue.length >= LOW_WATER_MARK) return
  isReplenishingQueue = true

  try {
    const result = await buildDjResponse('根据当前时间继续补充几首适合接着听的歌', {
      persistMessages: false,
      broadcast: false,
      currentQueue: playQueue,
      appendQueue: true,
      includeSpeech: false,
    })

    if (result.queue.length > 0) {
      console.log(`[queue] 静默补货完成(${trigger})，新增 ${result.queue.length} 首，当前 ${playQueue.length} 首`)
      scheduler.broadcast({ type: 'queue-refresh', queue: playQueue })
    } else {
      console.log(`[queue] 静默补货未新增歌曲(${trigger})`)
    }
  } catch (e) {
    console.error(`[queue] 静默补货失败(${trigger}):`, e.message)
  } finally {
    isReplenishingQueue = false
  }
}

async function bootstrapStation() {
  try {
    await context.fetchWeatherByCity()
    const initialInput = '根据当前时间推荐几首歌'
    const result = await buildDjResponse(initialInput, {
      persistMessages: false,
      broadcast: true,
    })
    console.log(`[claudio] 开机自动选曲完成，生成 ${result.queue.length} 首`)
  } catch (e) {
    console.error('[claudio] 开机自动选曲失败:', e.message)
  }
}

// ── Express 中间件 ────────────────────────────
app.use(express.json())

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Claudio FM',
    short_name: 'Claudio',
    start_url: '/',
    display: 'standalone',
    background_color: '#0E0E0E',
    theme_color: '#0E0E0E',
    icons: [
      { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
      { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml' },
    ],
  })
})

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(`
const CACHE_NAME = 'claudio-static-v1'
const ASSETS = ['/', '/manifest.json', '/sw.js']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)))
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(response => {
        const clone = response.clone()
        if (event.request.url.startsWith(self.location.origin)) {
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {})
        }
        return response
      })
    })
  )
})
  `.trim())
})

function iconSvg(size) {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0E0E0E"/>
  <path d="M312 118v168a44 44 0 1 1-24-39V152l-100 26v153a44 44 0 1 1-24-39V160z" fill="#C9A96E"/>
</svg>
  `.trim()
}

app.get('/icon-192.svg', (req, res) => {
  res.type('image/svg+xml').send(iconSvg(192))
})

app.get('/icon-512.svg', (req, res) => {
  res.type('image/svg+xml').send(iconSvg(512))
})

app.use(express.static(path.join(__dirname, 'pwa')))
app.use('/cache', express.static(path.join(__dirname, 'cache')))

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const input = req.body.input
  if (!input) return res.status(400).json({ error: 'input 不能为空' })

  try {
    const payload = await buildDjResponse(input, { persistMessages: true, broadcast: true })
    return res.json(payload)
  } catch (e) {
    console.error('[/api/chat]', e)
    return res.status(500).json({ error: e.message })
  }
})

app.post('/api/explain', async (req, res) => {
  const { name, artist } = req.body || {}
  const userInput = (req.body?.user_input || req.body?.input || '无').trim() || '无'
  const themeName = (req.body?.theme_name || '深夜').trim() || '深夜'

  if (!name || !artist) {
    return res.status(500).json({ error: 'name 和 artist 不能为空' })
  }

  try {
    const envSnapshot = await context.getEnvironmentSnapshot()
    const selectedAngle = pickExplainAngle()
    const recentOpeningsText = recentExplainOpenings.length > 0
      ? recentExplainOpenings.join(' / ')
      : '无'
    const response = await explainClient.chat.completions.create({
      model: 'qwen-max',
      messages: [
        {
          role: 'system',
          content: `你是一个真正懂音乐的私人 DJ，现在要在这首歌播放前说几句话。

你有四种切入方式，根据此刻情境自己判断用哪一种：
1. 用今天的日期/节气/农历/天气说话，让情境本身成为理由
2. 借助这首歌或歌手的真实故事，找到和听者情绪的交叉点，用故事作桥梁
3. 只描述这首歌的质感，说它和此刻情绪的共振关系
4. 解释一个反直觉的选择——为什么这首看似不相关的歌是此刻的出口

规则：
- 60字以内
- 像朋友说话，不像AI写文案
- 不说"这首歌"三个字，直接说内容
- 留白比填满好，细腻但不煽情
- 如果用第2种，歌手/歌曲的背景必须是真实的，不能编造
- 每次必须从四种切入角度里随机选一种，不能每次都用时间/天气开头
- 禁止用"今天农历XX，XX的XX"这种固定句式开头
- 开头句式每次必须不同，可以直接从情绪、声音质感、歌手故事、反直觉角度切入`,
        },
        {
          role: 'user',
          content: `时间：${envSnapshot.timeStr}
天气：${envSnapshot.weather.description}，${envSnapshot.weather.temp}°C
农历：${envSnapshot.lunar}
当前主题：${themeName}
用户说：${userInput}
正在播放：${name} — ${artist}
本次指定角度：${selectedAngle}
今天已经说过的开头方式：${recentOpeningsText}，请避开这`,
        },
      ],
    })

    const explainText = (response.choices[0]?.message?.content || '').trim()
    rememberExplainOpening(explainText)
    const sayAudio = await tts.synthesizeSlow(explainText)

    return res.json({
      explain_text: explainText,
      say_audio: sayAudio,
    })
  } catch (e) {
    console.error('[/api/explain]', e)
    return res.status(500).json({ error: e.message })
  }
})

app.post('/api/feedback', (req, res) => {
  const { action, song_id, name, artist } = req.body || {}
  if (!['like', 'dislike', 'clear'].includes(action) || !name || !artist) {
    return res.status(400).json({ error: 'action/name/artist 参数无效' })
  }

  const song = { id: song_id || null, name, artist }
  if (action === 'clear') {
    state.setSongFeedback(song, 'neutral')
    return res.json({ ok: true, feedback: null })
  }

  state.setSongFeedback(song, action)

  if (action === 'dislike') {
    playQueue = playQueue.filter(item => queueKeyFromItem(item) !== `${name}::${artist}`.toLowerCase())
    scheduler.broadcast({ type: 'queue-refresh', queue: playQueue })
  }

  return res.json({ ok: true, feedback: action })
})

app.get('/api/feedback', (req, res) => {
  const { name, artist, song_id } = req.query || {}
  if (!name || !artist) {
    return res.status(400).json({ error: 'name 和 artist 不能为空' })
  }
  const feedback = state.getSongFeedback({
    id: song_id || null,
    name,
    artist,
  })
  return res.json({
    feedback: feedback?.feedback === 'neutral' ? null : (feedback?.feedback || null),
  })
})

app.post('/api/location', async (req, res) => {
  const { lat, lon } = req.body || {}

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'lat 和 lon 必须是数字' })
  }

  try {
    const weather = await context.fetchWeatherByCoords(lat, lon)
    return res.json({ ok: true, weather })
  } catch (e) {
    console.error('[/api/location]', e)
    return res.status(500).json({ error: e.message })
  }
})

// GET /api/next — 弹出队列下一首（前端歌曲结束时调用）
app.get('/api/next', async (req, res) => {
  let item = queuePop()
  if (!item) {
    await replenishQueueSilently('empty-next')
    item = queuePop()
  }

  if (item) {
    currentNowPlaying = item.song_info || null
    state.addPlay({
      id: item.song_info?.id,
      name: item.song_info?.name,
      artist: item.song_info?.artist,
    })
    scheduler.broadcast({ type: 'now-playing', ...item })
    if (playQueue.length < LOW_WATER_MARK) {
      replenishQueueSilently('next').catch(() => {})
    }
    res.json(item)
  } else {
    res.json({ song_info: null, play_url: null })
  }
})

// GET /api/queue — 查看当前队列
app.get('/api/queue', (req, res) => {
  res.json({ queue: playQueue })
})

// GET /api/now
app.get('/api/now', async (req, res) => {
  const plays = state.getRecentPlays(1)
  const weather = await context.getWeather()
  const fallbackTrack = playQueue[0]?.song_info || null
  const activeTrack = currentNowPlaying || fallbackTrack || null
  const feedback = activeTrack ? state.getSongFeedback(activeTrack) : null
  res.json({
    current: currentNowPlaying
      ? {
          song_id: currentNowPlaying.id,
          song_name: currentNowPlaying.name,
          artist: currentNowPlaying.artist,
          mood: null,
          played_at: plays[0]?.played_at || null,
        }
      : fallbackTrack
        ? {
            song_id: fallbackTrack.id,
            song_name: fallbackTrack.name,
            artist: fallbackTrack.artist,
            mood: null,
            played_at: null,
          }
      : plays[0] || null,
    today_count: scheduler.getTodayCount(),
    current_feedback: feedback?.feedback === 'neutral' ? null : (feedback?.feedback || null),
    weather: weather || null,
    sunrise: weather?.sunrise || null,
    sunset: weather?.sunset || null,
    sunrise_ts: weather?.sunriseTs || null,
    sunset_ts: weather?.sunsetTs || null,
  })
})

// GET /api/taste
app.get('/api/taste', (req, res) => {
  const taste = fs.readFileSync(path.join(__dirname, 'user/taste.md'), 'utf8')
  res.type('text/plain; charset=utf-8').send(taste)
})

// GET /api/plan/today
app.get('/api/plan/today', (req, res) => {
  const plays = state.getRecentPlays(20)
  res.json({ today_count: scheduler.getTodayCount(), recent_plays: plays })
})

const PORT = process.env.PORT || 8080
server.listen(PORT, () => {
  console.log(`[claudio] 服务启动 → http://localhost:${PORT}`)
  for (const url of getLanUrls(PORT)) {
    console.log(`[claudio] 局域网访问: ${url}`)
  }
  console.log(fs.existsSync(COOKIE_PATH)
    ? '[claudio] 已加载网易云 Cookie'
    : '[claudio] 提示：未登录网易云，运行 node scripts/ncm-login.js')
  bootstrapStation()
})
