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
const { getAstronomyContext } = require('./core/astronomy')
const spotify = require('./core/spotify')
const { createQueueManager } = require('./core/queue-manager')
const {
  artistMatchScore,
  buildArtistVariants,
  buildTitleVariants,
  makeSongSearchProfile,
  normalizeArtistKey,
  normalizeSongKey,
  stripTitleNoise,
  titleMatchScore,
} = require('./core/search-utils')

const explainClient = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})
const explainAngles = [
  'B. 声音质感——这首歌听起来像什么物理感受或材质，用通感切入，不依赖歌词',
  'C. 反直觉——为什么这首看似和此刻气质不搭的歌，反而是此刻最准确的出口',
  'D. 一个具体的画面或物件——不靠时间天气，只靠一个细节锚定情绪',
  'E. 此刻的情境与这首歌之间有一条隐秘的线——说出这条线是什么',
]
let recentExplainOpenings = []

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server, path: '/stream' })

process.on('unhandledRejection', error => {
  console.error('[claudio] 未处理的 Promise 拒绝:', error)
})

process.on('uncaughtException', error => {
  console.error('[claudio] 未捕获异常:', error)
})

const wsClients = []
let latestStationPayload = null
wss.on('connection', ws => {
  wsClients.push(ws)

  if (latestStationPayload) {
    ws.send(JSON.stringify(latestStationPayload))
  } else if (queueManager.size() > 0) {
    ws.send(JSON.stringify({ type: 'queue-refresh', queue: queueManager.getSnapshot() }))
  }

  ws.on('close', () => {
    const i = wsClients.indexOf(ws)
    if (i !== -1) wsClients.splice(i, 1)
  })
})
scheduler.setWsClients(wsClients)

// ── 内存播放队列 ──────────────────────────────
let currentNowPlaying = null
const DEFAULT_MIN_BATCH_SIZE = 8
const DEFAULT_MAX_BATCH_SIZE = 12
const READY_POOL_TARGET_SIZE = 30
const READY_POOL_REFILL_THRESHOLD = 10
const LOW_WATER_MARK = READY_POOL_REFILL_THRESHOLD
const READY_POOL_ROUND_SIZE = 15
const READY_POOL_MAX_ROUNDS = 8
const READY_POOL_PARALLEL_ROUNDS = 2
const STARTUP_PREWARM_TIMEOUT_MS = 30 * 1000
const ncmSearchCache = new Map()
const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const SEARCH_CACHE_MISS_TTL_MS = 30 * 60 * 1000
const NCM_ID_MAP_HIT_TTL_MS = 72 * 60 * 60 * 1000
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
let lastWeatherMain = null
let weatherPollTimer = null
const WEATHER_POLL_INTERVAL = 5 * 60 * 1000 // 5分钟
let shouldAutoplayAfterRefill = false
let suppressQueueBroadcasts = false

const queueManager = createQueueManager({
  targetSize: READY_POOL_TARGET_SIZE,
  refillThreshold: READY_POOL_REFILL_THRESHOLD,
  itemKey: queueKeyFromItem,
  onQueueChange(queue) {
    if (latestStationPayload) latestStationPayload = { ...latestStationPayload, queue }
    if (suppressQueueBroadcasts) return
    scheduler.broadcast({ type: 'queue-refresh', queue })
  },
  onRefillStart({ reason, needed, sizeBefore }) {
    console.log(`[queue] 开始补货(${reason})，缺口 ${needed}，当前 ${sizeBefore} 首`)
  },
  onRefillComplete({ reason, sizeBefore, sizeAfter, insertedCount }) {
    console.log(`[queue] 补货完成(${reason})，新增 ${insertedCount} 首，当前 ${sizeAfter} 首`)
    if (shouldAutoplayAfterRefill && sizeBefore === 0 && sizeAfter > 0) {
      shouldAutoplayAfterRefill = false
      const item = queueManager.pop('auto-resume')
      if (item) {
        currentNowPlaying = item.song_info || null
        state.addPlay({
          id: item.song_info?.id,
          name: item.song_info?.name,
          artist: item.song_info?.artist,
        })
        scheduler.broadcast({ type: 'now-playing', ...item, queue: queueManager.getSnapshot() })
      }
    }
  },
  onRefillError(error, { reason }) {
    console.error(`[queue] 补货失败(${reason}):`, error.message)
  },
})

function makeSongLookupKey(name, artist) {
  return `${normalizeNcmText(name)}::${normalizeNcmText(artist)}`
}

function isLikelyNcmSongId(songId) {
  const id = String(songId || '').trim()
  return /^\d{6,}$/.test(id)
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
  const key = makeSongLookupKey(name, artist)
  const remembered = ncmIdMap[key]
  if (!remembered) return null
  if (remembered.status === 'hit' && !isLikelyNcmSongId(remembered.id)) {
    delete ncmIdMap[key]
    persistNcmIdMap()
    return null
  }
  if (remembered.status === 'miss' && Date.now() - remembered.updatedAt > SEARCH_CACHE_MISS_TTL_MS) {
    delete ncmIdMap[key]
    persistNcmIdMap()
    return null
  }
  if (remembered.status === 'hit' && Date.now() - remembered.updatedAt > NCM_ID_MAP_HIT_TTL_MS) {
    delete ncmIdMap[key]
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

async function checkWeatherChange() {
  try {
    const coords = context.getStoredCoordinates()
    const weather = coords
      ? await context.fetchWeatherByCoords(coords.lat, coords.lon)
      : await context.fetchWeatherByCity()

    const currentMain = weather?.main || null
    if (!currentMain) return

    // 首次记录，不触发
    if (lastWeatherMain === null) {
      lastWeatherMain = currentMain
      return
    }

    // 天气没变，不触发
    if (lastWeatherMain === currentMain) return

    const prevMain = lastWeatherMain
    lastWeatherMain = currentMain

    console.log(`[claudio] 天气变化: ${prevMain} → ${currentMain}，触发重新选曲`)

    // 构造有质感的天气变化 prompt，让 AI 感知变化本身
    const weatherTransitionPrompts = {
      Rain: `天空开始下雨了，从${prevMain}变成了雨天。雨不只是一种天气，是一种心情的转场。根据此刻的城市、时间和季节，选几首最契合这场雨质感的歌——不要只是"雨歌单"，要感受这场雨是绵长的还是急促的，是春雨还是秋雨。`,
      Clear: `雨停了，天空放晴，从${prevMain}变成了晴天。阳光重新出现时，人的心情会有一种特别的轻盈感。选几首能捕捉这种"雨后"情绪的歌，不一定是欢快的，可以是安静的满足。`,
      Clouds: `天空开始转阴，云层聚拢，从${prevMain}变成了阴天。这种光线的改变会带来微妙的情绪转变，选几首符合阴天质感的歌。`,
      Snow: `开始下雪了，从${prevMain}变成了雪天。雪是一种特殊的安静，选几首能配得上雪落时那种空旷感的音乐。`,
      Thunderstorm: `雷雨来了，从${prevMain}变成了雷暴天气。这种天气有一种戏剧性，选几首有张力的歌。`,
      Drizzle: `开始飘起细雨，从${prevMain}变成了毛毛雨。选几首适合这种若即若离的雨天质感的歌。`,
      Mist: `雾气弥漫，从${prevMain}变成了雾天。选几首有朦胧感的音乐。`,
      Haze: `变得有些灰蒙蒙的，从${prevMain}变成了霾天。选几首不那么明亮、有些内敛的音乐。`,
    }

    const prompt = weatherTransitionPrompts[currentMain]
      || `天气从${prevMain}变成了${currentMain}，根据这个变化和当前时间地点，选几首最契合此刻的歌。`

    scheduler.broadcast({
      type: 'weather-change',
      from: prevMain,
      to: currentMain,
      weather,
    })

    const result = await buildDjResponse(prompt, {
      persistMessages: false,
      broadcast: true,
      appendQueue: false,
    })

    console.log(`[claudio] 天气变化选曲完成，生成 ${result.queue.length} 首`)
  } catch (e) {
    console.error('[claudio] 天气变化检测失败:', e.message)
  }
}

let buildDjResponseChain = Promise.resolve()
let stationBuildVersion = 0

function runSerializedBuildDjResponse(task) {
  const next = buildDjResponseChain.then(task, task)
  buildDjResponseChain = next.then(() => undefined, () => undefined)
  return next
}

function makeSongPayload(song) {
  return {
    id: song?.id || null,
    name: song?.name || '',
    artist: song?.artist || '',
  }
}

function broadcastPlaylistReady(payload, queue = queueManager.getSnapshot()) {
  latestStationPayload = {
    type: 'playlist-ready',
    say: payload.say || null,
    say_audio: payload.say_audio || null,
    queue,
    reason: payload.reason || '',
    segue: payload.segue || '',
  }
  scheduler.broadcast(latestStationPayload)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

function extractEmotionFromInput(userText) {
  const triggers = [
    { pattern: /烟花|firework/i, mood: '华丽短暂', suggestion: '陈绮贞《华丽的冒险》风格' },
    { pattern: /害怕|恐惧|黑暗|一个人.*路/i, mood: '需要陪伴', suggestion: '热闹有人声、节奏感强' },
    { pattern: /散步|漫步|走走/i, mood: '轻盈流动', suggestion: '方大同《春风吹》风格，轻盈律动' },
    { pattern: /下雨|雨声/i, mood: '雨天慵懒', suggestion: '慢节奏、有质感的编曲' },
    { pattern: /想家|思念|好久不见/i, mood: '思念', suggestion: '温柔、有故事感' },
    { pattern: /失眠|睡不着/i, mood: '深夜清醒', suggestion: '极简、呼吸感强' },
    { pattern: /开心|高兴|好消息/i, mood: '愉悦', suggestion: '明快、有光泽感的编曲' },
    { pattern: /难过|伤心|哭/i, mood: '需要共鸣', suggestion: '贴近情绪而非刻意治愈' },
    { pattern: /累|疲惫|下班/i, mood: '身心疲惫', suggestion: '慢下来、有托住感的音乐' },
    { pattern: /喝酒|小酌|一杯/i, mood: '微醺', suggestion: '爵士感、慵懒、带点诗意' },
  ]

  for (const trigger of triggers) {
    if (trigger.pattern.test(userText)) return { mood: trigger.mood, suggestion: trigger.suggestion }
  }
  return null
}

// ── NCM 工具 ─────────────────────────────────
const COOKIE_PATH = path.join(__dirname, 'user/ncm-cookie.json')

function getNcmCookie() {
  if (process.env.NCM_COOKIE) return process.env.NCM_COOKIE
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
  return normalizeSongKey(text)
}

function normalizeSongCore(text) {
  return stripTitleNoise(text)
}

function scoreNcmCandidate(song, requestedSong) {
  const candidateArtists = (song?.artists || []).map(a => a.name).filter(Boolean)
  const titleScore = titleMatchScore(buildTitleVariants(requestedSong), song?.name)
  const artistScore = artistMatchScore(buildArtistVariants(requestedSong), candidateArtists)

  let score = 0
  score += titleScore
  score += Math.round(artistScore * 0.8)

  if (song?.alia?.length) {
    const aliasHit = song.alia.some(alias => {
      const normalizedAlias = normalizeNcmText(alias)
      return buildTitleVariants(requestedSong).some(title => normalizeSongKey(title) === normalizedAlias)
    })
    if (aliasHit) score += 16
  }

  const coverKeywords = ['翻唱', 'cover', '致敬', '钢琴版', '吉他版', '纯音乐版', 'piano', 'acoustic', 'instrumental', 'tribute']
  const nameLower = String(song?.name || '').toLowerCase()
  const hasCoverKeyword = coverKeywords.some(kw => nameLower.includes(kw))
  if (hasCoverKeyword && artistScore < 68) score -= 40

  return score
}

function buildNcmQueries(song) {
  const titles = buildTitleVariants(song)
  const artists = buildArtistVariants(song)
  const queries = []

  for (const title of titles.slice(0, 6)) {
    queries.push(title)
  }

  for (const title of titles.slice(0, 4)) {
    for (const artist of artists.slice(0, 3)) {
      queries.push(`${title} ${artist}`.trim())
      if (queries.length >= 12) return queries
    }
  }

  return queries
}

async function ncmSearch(songOrName, artist) {
  const requestedSong = makeSongSearchProfile(songOrName, artist)
  const base = process.env.NCM_API_BASE || 'http://localhost:3000'
  const cacheKey = `${normalizeSongKey(requestedSong.name)}::${normalizeArtistKey(requestedSong.artist)}`
  const cached = getCachedSearchIds(cacheKey)
  if (cached) {
    console.log(`[ncm] 命中搜索缓存 "${requestedSong.name} / ${requestedSong.artist}" -> ${cached.join(', ') || 'MISS'}`)
    return cached
  }

  const seenIds = new Set()
  const candidates = []

  for (const query of buildNcmQueries(requestedSong)) {
    const q = encodeURIComponent(query)
    const data = await ncmFetch(`${base}/search?keywords=${q}&limit=15`)
    const songs = data?.result?.songs || []
    for (const song of songs) {
      const id = String(song.id)
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const score = scoreNcmCandidate(song, requestedSong)
      if (score < 72) continue
      candidates.push({ id, score, song })
    }
    if (candidates.length >= 5) break
  }

  const coverKws = ['翻唱', 'cover', '钢琴版', '吉他版', '纯音乐', 'piano', 'acoustic', 'instrumental', 'tribute']
  candidates.forEach(c => {
    const n = String(c.song?.name || '').toLowerCase()
    if (coverKws.some(kw => n.includes(kw))) {
      c.score -= 30
    }
  })

  candidates.sort((a, b) => b.score - a.score)

  if (!candidates.length) {
    console.log(`[ncm] 搜索 "${requestedSong.name} / ${requestedSong.artist}" 无可靠结果，跳过`)
    setCachedSearchIds(cacheKey, [])
    return []
  }

  const ids = candidates.slice(0, 5).map(item => item.id)
  setCachedSearchIds(cacheKey, ids)
  return ids
}

async function checkArtistViaDetail(candidateId, requestedSong, base) {
  try {
    const data = await ncmFetch(`${base}/song/detail?ids=${candidateId}`)
    const song = data?.songs?.[0]
    if (!song) return true
    const actualArtists = (song.ar || []).map(a => a.name).filter(Boolean)
    const artistScore = artistMatchScore(buildArtistVariants(requestedSong), actualArtists)
    const titleScore = titleMatchScore(buildTitleVariants(requestedSong), song.name)
    if (titleScore < 72 || artistScore < 68) {
      console.log(`[ncm] 艺人不符 id=${candidateId}: 期望 [${buildArtistVariants(requestedSong).join(' | ')}] 实际 [${actualArtists}]`)
      return false
    }
    return true
  } catch { return true }
}

async function ncmGetUrl(songOrId, name, artist) {
  const requestedSong = makeSongSearchProfile(
    songOrId && typeof songOrId === 'object'
      ? songOrId
      : { id: songOrId, name, artist }
  )
  const base = process.env.NCM_API_BASE || 'http://localhost:3000'
  const tried = new Set()
  const candidateIds = []
  const remembered = getRememberedSongId(requestedSong.name, requestedSong.artist)

  if (isLikelyNcmSongId(remembered?.id)) candidateIds.push(String(remembered.id))
  if (isLikelyNcmSongId(requestedSong.id) && String(requestedSong.id) !== '0') candidateIds.push(String(requestedSong.id))

  for (const candidateId of candidateIds) {
    if (!candidateId || tried.has(candidateId)) continue
    tried.add(candidateId)

    const data = await ncmFetch(`${base}/song/url/v1?id=${candidateId}&level=standard`)
    const item = data?.data?.[0]
    if (item?.url && item.code === 200) {
      if (item.freeTrialInfo) {
        console.log(`[ncm] id=${candidateId} 为试听片段，跳过`)
        continue
      }
      if (!(await checkArtistViaDetail(candidateId, requestedSong, base))) continue
      rememberSongIdMapping(requestedSong.name, requestedSong.artist, candidateId, 'hit')
      if (candidateId !== String(requestedSong.id)) {
        console.log(`[ncm] 搜索命中 "${requestedSong.name} / ${requestedSong.artist}" -> ${candidateId}`)
      }
      return { url: item.url, id: candidateId }
    }
  }

  if (candidateIds.length > 0) {
    console.log(`[ncm] id ${candidateIds[0]} 无效，搜索 "${requestedSong.name} ${requestedSong.artist}"`)
  }
  const searchedIds = await ncmSearch(requestedSong)
  for (const candidateId of searchedIds) {
    if (!candidateId || tried.has(candidateId)) continue
    tried.add(candidateId)

    const data = await ncmFetch(`${base}/song/url/v1?id=${candidateId}&level=standard`)
    const item = data?.data?.[0]
    if (item?.url && item.code === 200) {
      if (item.freeTrialInfo) {
        console.log(`[ncm] id=${candidateId} 为试听片段，跳过`)
        continue
      }
      if (!(await checkArtistViaDetail(candidateId, requestedSong, base))) continue
      rememberSongIdMapping(requestedSong.name, requestedSong.artist, candidateId, 'hit')
      console.log(`[ncm] 搜索命中 "${requestedSong.name} / ${requestedSong.artist}" -> ${candidateId}`)
      return { url: item.url, id: candidateId }
    }
  }

  rememberSongIdMapping(requestedSong.name, requestedSong.artist, null, 'miss')
  return { url: null, id: null }
}

// 并行解析一批歌曲，返回有直链的条目
async function resolveQueue(songs) {
  const useSpotify = spotify.hasUserToken()
  const spotifyQueue = []
  const SPOTIFY_INTERVAL_MS = 200

  for (let index = 0; index < songs.length; index++) {
    const song = songs[index]
    try {
      if (useSpotify) {
        if (index > 0) await new Promise(r => setTimeout(r, SPOTIFY_INTERVAL_MS))
        let match = null
        try {
          match = await spotify.searchTrack(song)
        } catch (e) {
          console.error(`[spotify] 搜索失败 "${song.name} / ${song.artist}"，回退 NCM:`, e.message)
        }
        if (match?.uri) {
          const actualArtists = Array.isArray(match.artists) ? match.artists.filter(Boolean).join('; ') : song.artist
          console.log(`[spotify] 命中 "${song.name} / ${song.artist}" -> ${match.uri}`)
          spotifyQueue[index] = {
            song_info: {
              ...song,
              id: match.id || song.id || null,
              name: match.name || song.name,
              artist: actualArtists || song.artist,
            },
            requested_song_info: { ...song },
            spotify_uri: match.uri,
            spotify_track: match,
            play_url: null,
            source: 'spotify',
          }
          continue
        }
        console.log(`[spotify] 未命中 "${song.name} / ${song.artist}"，回退 NCM`)
      }
      const { url, id: realId } = await ncmGetUrl(song)
      if (!url) continue
      spotifyQueue[index] = {
        song_info: { ...song, id: realId || song.id },
        requested_song_info: { ...song },
        play_url: url,
        source: 'ncm',
      }
    } catch (e) {
      console.error(`[queue] 解析 "${song.name}" 失败:`, e.message)
    }
  }
  return spotifyQueue.filter(Boolean)
}

async function resolveDjSelection(input, options = {}) {
  const {
    currentQueue = queueManager.getSnapshot(),
    includeSpeech = true,
    emotionSignal = null,
    minQueueSize = DEFAULT_MIN_BATCH_SIZE,
    maxQueueSize = DEFAULT_MAX_BATCH_SIZE,
  } = options

  const intent = router.route(input)
  if (intent === 'system') {
    return { say: null, say_audio: null, queue: [], reason: '', segue: '', intent }
  }

  const ctx = await context.buildContext(input, { currentQueue, emotionSignal })
  const result = await claude.askClaude(ctx)

  let queue = []
  const recentPlays = state.getRecentPlays(120)
  const recentRecommended = getRecentRecommendedKeySet()
  const useSpotify = spotify.hasUserToken()

  if (result.play && result.play.length > 0) {
    queue = await resolveQueue(result.play)
    queue = filterQueueCandidates(queue, currentQueue, recentPlays, recentRecommended)

    const refillAttempts = useSpotify ? 5 : 3
    for (let attempt = 0; queue.length < minQueueSize && attempt < refillAttempts; attempt++) {
      const refillPrompt = useSpotify
        ? `继续补足队列，还需要 ${minQueueSize - queue.length} 首。只要 Spotify 可直接播放、歌名和艺人都严格匹配的歌，避开近期已播、当前队列里已有的歌，以及最近已经推荐过的歌。`
        : `继续补足队列，还需要 ${minQueueSize - queue.length} 首，避开近期已播、当前队列里已有的歌，以及最近已经推荐过的歌`
      const refillCtx = await context.buildContext(refillPrompt, {
        currentQueue: [...(currentQueue || []), ...queue],
      })
      const refillResult = await claude.askClaude(refillCtx)
      const refillQueue = await resolveQueue(refillResult.play || [])
      const mergedQueue = [...queue, ...refillQueue]
      queue = filterQueueCandidates(mergedQueue, currentQueue, recentPlays, recentRecommended)
    }

    queue = queue.slice(0, maxQueueSize)
    queue = markBatchEdges(queue)
  }

  const say_audio = includeSpeech && result.say
    ? await tts.synthesize(result.say).catch(e => {
        console.error('[tts]', e.message)
        return null
      })
    : null

  return {
    say: includeSpeech ? result.say : null,
    say_audio,
    queue,
    replace_pool: !!result.replace_pool,
    reason: result.reason,
    segue: result.segue,
    intent,
  }
}

async function buildDjResponseCore(input, options = {}) {
  const {
    persistMessages = true,
    broadcast = false,
    currentQueue = queueManager.getSnapshot(),
    appendQueue = false,
    includeSpeech = true,
    emotionSignal = null,
    skipIfOutdated = false,
    buildLabel = 'build',
  } = options
  const buildVersionAtStart = stationBuildVersion

  const payload = await resolveDjSelection(input, {
    currentQueue,
    includeSpeech,
    emotionSignal,
  })

  if (skipIfOutdated && stationBuildVersion !== buildVersionAtStart) {
    console.log(`[claudio] ${buildLabel} 结果已过期，跳过写入`)
    return {
      ...payload,
      skippedApply: true,
    }
  }

  stationBuildVersion += 1
  const nextQueue = appendQueue
    ? dedupeQueueItems([...(currentQueue || []), ...(payload.queue || [])])
    : [...(payload.queue || [])]
  queueManager.replace(nextQueue, appendQueue ? 'append-build' : 'replace-build')

  if (payload.queue.length > 0) {
    scheduler.incrementCount()
  }

  if (payload.queue.length > 0) {
    rememberRecentRecommendedQueue(payload.queue)
  }

  if (persistMessages) {
    state.addMessage('user', input)
    state.addMessage('assistant', JSON.stringify(payload))
  }

  if (broadcast) {
    broadcastPlaylistReady(payload, queueManager.getSnapshot())

    if (payload.queue.length > 0 && !currentNowPlaying) {
      scheduler.broadcast({ type: 'now-playing', ...payload.queue[0], queue: queueManager.getSnapshot() })
    }
  }

  if (includeSpeech && queueManager.size() > 0 && queueManager.size() < LOW_WATER_MARK) {
    replenishQueueSilently('post-build').catch(() => {})
  }

  return payload
}

async function buildDjResponse(input, options = {}) {
  const task = () => buildDjResponseCore(input, options)
  if (options.serialize === false) return task()
  return runSerializedBuildDjResponse(task)
}

async function replenishQueueSilently(trigger = 'auto') {
  try {
    await queueManager.ensureFilled(trigger)
  } catch (e) {
    console.error(`[queue] 静默补货失败(${trigger}):`, e.message)
  }
}

async function buildReadyPoolBatch(input, options = {}) {
  const result = await resolveDjSelection(input, {
    currentQueue: queueManager.getSnapshot(),
    includeSpeech: false,
    minQueueSize: READY_POOL_ROUND_SIZE,
    maxQueueSize: READY_POOL_ROUND_SIZE,
    ...options,
  })
  return result.queue || []
}

function makeReadyPoolPrompt(reason, needed) {
  if (reason === 'startup-prewarm' || reason === 'bootstrap') {
    return `按当前时间、天气和用户整体品味推荐 ${READY_POOL_ROUND_SIZE} 首可直接播放的歌，作为电台启动预热池。必须避开近期已播和当前池里已有的歌。`
  }
  return `继续补充播放池，推荐 ${READY_POOL_ROUND_SIZE} 首可直接播放的歌。当前还缺约 ${needed} 首，请避开当前池里已有的歌和最近 50 首播放记录。`
}

async function buildReadyPoolMultiRound(reason, options = {}) {
  const baseQueue = Array.isArray(options.baseQueue) ? options.baseQueue.slice() : queueManager.getSnapshot()
  const targetSize = options.targetSize || READY_POOL_TARGET_SIZE
  const maxRounds = options.maxRounds || READY_POOL_MAX_ROUNDS
  const parallelRounds = options.parallelRounds || READY_POOL_PARALLEL_ROUNDS
  const deadlineAt = options.maxDurationMs ? Date.now() + options.maxDurationMs : 0
  const recentPlays = state.getRecentPlays(50)
  const recentPlayQueueItems = recentPlays.map(play => ({
    song_info: {
      id: play.song_id || play.id || null,
      name: play.song_name || play.name || '',
      artist: play.artist || '',
    },
  }))
  const collected = []
  let roundsUsed = 0

  while (baseQueue.length + collected.length < targetSize && roundsUsed < maxRounds) {
    if (deadlineAt && Date.now() >= deadlineAt) break
    const remainingRounds = maxRounds - roundsUsed
    const deficit = targetSize - (baseQueue.length + collected.length)
    const waveCount = Math.min(
      parallelRounds,
      remainingRounds,
      Math.max(1, Math.ceil(deficit / READY_POOL_ROUND_SIZE))
    )
    const waveCurrentQueue = dedupeQueueItems([...baseQueue, ...collected, ...recentPlayQueueItems])
    const prompt = makeReadyPoolPrompt(reason, deficit)
    const waveTasks = Array.from({ length: waveCount }, (_, index) =>
      buildReadyPoolBatch(prompt, {
        currentQueue: waveCurrentQueue,
        buildLabel: `refill:${reason}:round-${roundsUsed + index + 1}`,
      }).catch(error => {
        console.error(`[queue] 预热轮次失败(${reason}#${roundsUsed + index + 1}):`, error.message)
        return []
      })
    )
    const waveResults = await Promise.all(waveTasks)
    roundsUsed += waveCount

    let insertedThisWave = 0
    for (const items of waveResults) {
      const deduped = dedupeQueueItems(items, [...baseQueue, ...collected])
      if (!deduped.length) continue
      collected.push(...deduped)
      insertedThisWave += deduped.length
      if (baseQueue.length + collected.length >= targetSize) break
    }

    if (insertedThisWave === 0) break
  }

  return collected.slice(0, Math.max(0, targetSize - baseQueue.length))
}

queueManager.setRefillHandler(async ({ reason, needed, currentQueue, force }) => {
  const targetSize = force
    ? READY_POOL_TARGET_SIZE
    : Math.max(READY_POOL_TARGET_SIZE, (currentQueue?.length || 0) + needed)
  return buildReadyPoolMultiRound(reason, {
    baseQueue: currentQueue,
    targetSize,
  })
})

async function bootstrapStation() {
  try {
    recentRecommendedKeys = []
    state.setPref(RECENT_RECOMMENDED_PREF, JSON.stringify([]))
    await context.fetchWeatherByCity()
    const prewarmQueue = await buildReadyPoolMultiRound('startup-prewarm', {
      baseQueue: [],
      targetSize: READY_POOL_TARGET_SIZE,
      maxDurationMs: STARTUP_PREWARM_TIMEOUT_MS,
    })
    suppressQueueBroadcasts = true
    queueManager.replace(prewarmQueue, 'startup-prewarm-ready')
    const result = await resolveDjSelection('根据当前时间为这一整池歌做一个开场介绍', {
      currentQueue: queueManager.getSnapshot(),
      includeSpeech: true,
    })
    suppressQueueBroadcasts = false
    broadcastPlaylistReady(result, queueManager.getSnapshot())
    console.log(`[claudio] 启动预热完成，readyPool=${queueManager.size()} 首`)
    if (queueManager.size() < READY_POOL_TARGET_SIZE) {
      delay(0).then(async () => {
        suppressQueueBroadcasts = true
        try {
          await replenishQueueSilently('startup-post-timeout')
        } finally {
          suppressQueueBroadcasts = false
        }
      })
    }

    // 记录初始天气状态
    const initWeather = await context.getWeather()
    lastWeatherMain = initWeather?.main || null
    console.log(`[claudio] 初始天气: ${lastWeatherMain}，开始天气监测`)

    // 启动天气轮询
    if (weatherPollTimer) clearInterval(weatherPollTimer)
    weatherPollTimer = setInterval(checkWeatherChange, WEATHER_POLL_INTERVAL)
  } catch (e) {
    suppressQueueBroadcasts = false
    console.error('[claudio] 开机自动选曲失败:', e.message)
  }
}

// ── Express 中间件 ────────────────────────────
app.use(express.json())

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'RodiO FM',
    short_name: 'RodiO',
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
    const emotionSignal = extractEmotionFromInput(input)
    const payload = await resolveDjSelection(input, {
      currentQueue: queueManager.getSnapshot(),
      includeSpeech: true,
      emotionSignal,
    })

    state.addMessage('user', input)
    state.addMessage('assistant', JSON.stringify(payload))

    if (payload.queue.length > 0) {
      if (payload.replace_pool) {
        queueManager.replace(payload.queue, 'chat-replace-pool')
      } else {
        queueManager.prepend(payload.queue, 'chat-prepend-pool')
      }
      rememberRecentRecommendedQueue(payload.queue)
      scheduler.incrementCount()
    }

    const queue = queueManager.getSnapshot()
    broadcastPlaylistReady(payload, queue)
    return res.json({ ...payload, queue })
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
          content: `你是一个私人 DJ，现在要在这首歌播放前说一句话。这句话是给一个人听的，不是写给大众的文案。

核心要求：
- 50字以内，宁可短，不要凑字数
- 说人话，不说"治愈""慰藉""温柔的力量"这类词
- 不说"这首歌"三个字
- 不编造歌手的故事或事实，不确定就不说
- 留白是本事，说到点到即止

切入方式（每次选一种，本次建议角度优先）：
B. 声音质感——听起来像什么物理感受？像雨打玻璃？像皮革？像空气变稠？用通感，不用歌词
C. 反直觉——这首和此刻看似不搭，说清楚为什么反而是对的
D. 一个画面或物件——一把椅子、一扇窗、一个手势，用细节锚定情绪
E. 隐秘的线——此刻和这首歌之间有什么别人不一定注意到的共振点

开头变化：
- 禁止重复已用过的开头方式
- 不要总以时间/天气开头
- 句式要变，不要都是"XX时候，XX……"结构`,
        },
        {
          role: 'user',
          content: `时间：${envSnapshot.timeStr}
天气：${envSnapshot.weather.description}，${envSnapshot.weather.temp}°C
当前时段：${themeName}
农历：${envSnapshot.lunar}
日出：${envSnapshot.weather.sunrise || '未知'} / 日落：${envSnapshot.weather.sunset || '未知'}
用户当下状态：${userInput === '无' ? '正常收听，无特别状态' : userInput}
正在播放：${name} — ${artist}
本次切入角度：${selectedAngle}
已用过的开头（必须不同）：${recentOpeningsText}`,
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
    queueManager.remove(item => queueKeyFromItem(item) === `${name}::${artist}`.toLowerCase(), 'dislike-remove')
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
    context.storeCoordinates(lat, lon)
    const weather = await context.fetchWeatherByCoords(lat, lon)
    return res.json({ ok: true, weather })
  } catch (e) {
    console.error('[/api/location]', e)
    return res.status(500).json({ error: e.message })
  }
})

app.post('/api/now-playing', (req, res) => {
  const { song_info, play_url, spotify_uri, spotify_track, source } = req.body || {}
  const info = song_info || null
  if (!info || !info.name || !info.artist) {
    return res.status(400).json({ error: 'song_info.name 和 song_info.artist 不能为空' })
  }

  currentNowPlaying = {
    id: info.id || null,
    name: info.name,
    artist: info.artist,
  }

  const payload = {
    song_info: currentNowPlaying,
    play_url: play_url || null,
    spotify_uri: spotify_uri || null,
    spotify_track: spotify_track || null,
    source: source || null,
  }

  scheduler.broadcast({ type: 'now-playing', ...payload })
  return res.json({ ok: true })
})

// GET /api/next — 弹出队列下一首（前端歌曲结束时调用）
app.get('/api/next', async (req, res) => {
  const isPeek = String(req.query?.peek || '') === '1' || String(req.query?.peek || '').toLowerCase() === 'true'

  if (isPeek) {
    if (queueManager.size() < LOW_WATER_MARK) {
      replenishQueueSilently('peek').catch(() => {})
    }
    const peekItem = queueManager.peek() || null
    if (peekItem) return res.json(peekItem)
    return res.json({ song_info: null, play_url: null, spotify_uri: null })
  }

  let item = queueManager.pop('api-next')
  if (!item) {
    shouldAutoplayAfterRefill = true
    replenishQueueSilently('empty-next').catch(() => {})
    return res.json({ song_info: null, play_url: null, spotify_uri: null, message: '稍等' })
  }

  shouldAutoplayAfterRefill = false
  if (item) {
    currentNowPlaying = item.song_info || null
    state.addPlay({
      id: item.song_info?.id,
      name: item.song_info?.name,
      artist: item.song_info?.artist,
    })
    scheduler.broadcast({ type: 'now-playing', ...item, queue: queueManager.getSnapshot() })
    if (queueManager.size() < LOW_WATER_MARK) {
      replenishQueueSilently('next').catch(() => {})
    }
    res.json(item)
  } else {
    res.json({ song_info: null, play_url: null })
  }
})

// GET /api/queue — 查看当前队列
app.get('/api/queue', (req, res) => {
  res.json({ queue: queueManager.getSnapshot() })
})

// GET /api/now
app.get('/api/now', async (req, res) => {
  const plays = state.getRecentPlays(1)
  const weather = await context.getWeather()
  const coords = context.getStoredCoordinates()
  const astronomy = coords
    ? await getAstronomyContext(coords.lat, coords.lon, Date.now()).catch(error => {
        console.error('[/api/now astronomy]', error)
        return null
      })
    : null
  const fallbackTrack = queueManager.peek()?.song_info || null
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
    astronomy,
    sunrise: weather?.sunrise || null,
    sunset: weather?.sunset || null,
    sunrise_ts: weather?.sunriseTs || null,
    sunset_ts: weather?.sunsetTs || null,
  })
})

app.get('/api/astronomy-debug', async (req, res) => {
  const defaultCoords = { lat: 31.2304, lon: 121.4737 }
  const queryLat = Number(req.query?.lat)
  const queryLon = Number(req.query?.lon)
  const storedCoords = context.getStoredCoordinates()
  const coords = Number.isFinite(queryLat) && Number.isFinite(queryLon)
    ? { lat: queryLat, lon: queryLon }
    : storedCoords || defaultCoords
  const coordinateSource = Number.isFinite(queryLat) && Number.isFinite(queryLon)
    ? 'user_provided'
    : storedCoords
      ? 'user_provided'
      : 'default_shanghai'

  try {
    const astronomy = await getAstronomyContext(coords.lat, coords.lon, Date.now())
    const weather = Number.isFinite(queryLat) && Number.isFinite(queryLon)
      ? null
      : await context.getWeather().catch(() => null)
    const hourOfDay = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()))
    const inferredEmotions = context.inferAmbientEmotion(astronomy, weather, hourOfDay)
    return res.json({
      ...astronomy,
      coordinateSource,
      culturalZone: astronomy.culturalZone,
      activeFestivalsToday: astronomy.activeFestivalsToday,
      inferredEmotions,
      canvasHintActive: astronomy.canvasHintActive,
      birthdayThisYear: astronomy.birthdayThisYear,
    })
  } catch (error) {
    console.error('[/api/astronomy-debug]', error)
    return res.status(500).json({ error: error.message })
  }
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

// ── Spotify OAuth ─────────────────────────────────────────────────
// GET /auth/spotify — 跳转到 Spotify 授权页
app.get('/auth/spotify', (req, res) => {
  const url = spotify.getAuthUrl('rodiO')
  res.redirect(url)
})

app.get('/auth/spotify/callback', (req, res) => res.redirect('/callback?' + new URLSearchParams(req.query)))

// GET /callback — Spotify 授权回调
app.get('/callback', async (req, res) => {
  const { code, error } = req.query
  if (error || !code) {
    return res.send(`<script>window.close()</script><p>授权失败：${error || '无 code'}</p>`)
  }
  try {
    await spotify.exchangeCode(code)
    console.log('[spotify] 用户授权成功，Spotify 播放已启用')
    res.send(`
      <html><body style="background:#080808;color:#C9A96E;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <p style="font-size:18px;margin-bottom:8px">✓ Spotify 已连接</p>
          <p style="font-size:13px;opacity:0.6">可以关闭此页面</p>
          <script>setTimeout(()=>window.close(),1500)</script>
        </div>
      </body></html>
    `)
  } catch (e) {
    console.error('[spotify] callback 失败:', e.message)
    res.send(`<p>授权失败：${e.message}</p>`)
  }
})

// GET /api/spotify/status — 前端查询授权状态和 token
app.get('/api/spotify/status', async (req, res) => {
  const connected = spotify.hasUserToken()
  const token = connected ? await spotify.getUserToken() : null
  res.json({
    connected,
    access_token: token,
    auth_url: connected ? null : '/auth/spotify',
  })
})

const PORT = process.env.PORT || 8080
server.listen(PORT, async () => {
  console.log(`[claudio] 服务启动 → http://localhost:${PORT}`)
  for (const url of getLanUrls(PORT)) {
    console.log(`[claudio] 局域网访问: ${url}`)
  }
  await spotify.initializeUserToken().catch(() => null)
  console.log(fs.existsSync(COOKIE_PATH)
    ? '[claudio] 已加载网易云 Cookie'
    : '[claudio] 提示：未登录网易云，运行 node scripts/ncm-login.js')
  scheduler.setResolveQueue(resolveQueue)
  bootstrapStation()
})
