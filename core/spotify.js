// ── Spotify 模块 ─────────────────────────────────────────────────
const state = require('./state')
const {
  artistMatchScore,
  buildArtistVariants,
  buildTitleVariants,
  makeSongSearchProfile,
  normalizeBaseText,
  normalizeCompareText,
  normalizeSongKey,
  stripTitleNoise,
  titleMatchScore,
} = require('./search-utils')
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://web-production-a5193.up.railway.app/auth/spotify/callback'
const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2'
const SPOTIFY_TOKEN_PREF = 'spotify_user_token_v1'
const SPOTIFY_BAD_TITLE_KWS = [
  'live', 'remix', 'acoustic', 'instrumental', 'cover', 'tribute',
  'karaoke', 'piano', 'version', 'ver.', 'edit', 'mono', 'demo',
]

let clientCredToken = null      // 用于搜索（不需要用户授权）
let userAccessToken = null      // 用于播放（需要用户授权）
let userRefreshToken = null
let userTokenExpiresAt = 0
let tokenInitPromise = null

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function applyPersistedUserToken(parsed) {
  if (!parsed || typeof parsed !== 'object') return false
  if (parsed?.refresh_token) userRefreshToken = parsed.refresh_token
  if (parsed?.access_token) userAccessToken = parsed.access_token
  if (typeof parsed?.expires_at === 'number') userTokenExpiresAt = parsed.expires_at
  return !!(userAccessToken || userRefreshToken)
}

function getRailwayTokenContext() {
  return {
    apiToken: process.env.RAILWAY_API_TOKEN || '',
    projectId: process.env.RAILWAY_PROJECT_ID || '',
    serviceId: process.env.RAILWAY_SERVICE_ID || '',
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID || '',
  }
}

function loadPersistedUserToken() {
  try {
    const envToken = {
      access_token: process.env.SPOTIFY_ACCESS_TOKEN || null,
      refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || null,
      expires_at: Number(process.env.SPOTIFY_TOKEN_EXPIRES_AT || 0) || 0,
    }
    if (applyPersistedUserToken(envToken)) return

    const raw = state.getPref(SPOTIFY_TOKEN_PREF)
    if (raw && applyPersistedUserToken(JSON.parse(raw))) return
  } catch {}
}

async function railwayGraphqlRequest(query, variables) {
  const { apiToken } = getRailwayTokenContext()
  if (!apiToken) throw new Error('缺少 RAILWAY_API_TOKEN')
  const res = await fetchJsonWithTimeout(RAILWAY_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ query, variables }),
  }, 10000)
  const data = await res.json()
  if (!res.ok || data?.errors?.length) {
    const message = data?.errors?.map(item => item.message).filter(Boolean).join('; ')
      || `Railway API 请求失败(${res.status})`
    throw new Error(message)
  }
  return data?.data || null
}

async function persistUserToken() {
  const payload = {
    access_token: userAccessToken || '',
    refresh_token: userRefreshToken || '',
    expires_at: String(userTokenExpiresAt || 0),
    updated_at: Date.now(),
  }

  try {
    state.setPref(SPOTIFY_TOKEN_PREF, JSON.stringify(payload))
  } catch (e) {
    console.error('[spotify] 保存 token 失败:', e.message)
  }

  const { projectId, serviceId, environmentId, apiToken } = getRailwayTokenContext()
  console.log('[spotify] Railway API 上下文:', {
    hasRailwayApiToken: !!process.env.RAILWAY_API_TOKEN,
    hasRailwayProjectId: !!process.env.RAILWAY_PROJECT_ID,
    hasRailwayServiceId: !!process.env.RAILWAY_SERVICE_ID,
    hasRailwayEnvironmentId: !!process.env.RAILWAY_ENVIRONMENT_ID,
  })
  if (!apiToken || !projectId || !serviceId || !environmentId) {
    console.warn('[spotify] 未配置完整 Railway API 上下文，跳过环境变量持久化')
    return false
  }

  await railwayGraphqlRequest(
    `mutation VariableCollectionUpsert(
      $projectId: String!,
      $environmentId: String!,
      $serviceId: String!,
      $variables: EnvironmentVariables!
    ) {
      variableCollectionUpsert(
        input: {
          projectId: $projectId,
          environmentId: $environmentId,
          serviceId: $serviceId,
          variables: $variables,
          replace: false,
          skipDeploys: true
        }
      )
    }`,
    {
      projectId,
      environmentId,
      serviceId,
      variables: {
        SPOTIFY_ACCESS_TOKEN: payload.access_token,
        SPOTIFY_REFRESH_TOKEN: payload.refresh_token,
        SPOTIFY_TOKEN_EXPIRES_AT: payload.expires_at,
      },
    }
  )

  process.env.SPOTIFY_ACCESS_TOKEN = payload.access_token
  process.env.SPOTIFY_REFRESH_TOKEN = payload.refresh_token
  process.env.SPOTIFY_TOKEN_EXPIRES_AT = payload.expires_at
  return true
}

loadPersistedUserToken()

async function initializeUserToken() {
  if (tokenInitPromise) return tokenInitPromise
  tokenInitPromise = (async () => {
    loadPersistedUserToken()
    if (!userRefreshToken && !userAccessToken) return null
    if (userAccessToken && userTokenExpiresAt > Date.now() + 30000) {
      console.log('[spotify] 已从环境变量恢复 access token')
      return userAccessToken
    }
    if (userRefreshToken) {
      try {
        const refreshed = await refreshUserToken()
        console.log('[spotify] 已使用 refresh token 恢复 access token')
        return refreshed
      } catch (e) {
        console.error('[spotify] 启动时刷新 token 失败:', e.message)
        return null
      }
    }
    return null
  })()
  return tokenInitPromise
}

function normalizeSpotifyText(text) {
  return normalizeCompareText(text, { preserveSpaces: true })
}

function normalizeSpotifyTitle(text) {
  return normalizeSongKey(stripTitleNoise(text))
}

function buildStructuredQueries(song) {
  const titles = buildTitleVariants(song)
  const artists = buildArtistVariants(song)
  const queries = []

  for (const title of titles.slice(0, 4)) {
    for (const artist of artists.slice(0, 4)) {
      queries.push(`track:"${title}" artist:"${artist}"`)
      if (queries.length >= 8) return queries
    }
  }

  return queries
}

function buildLooseTitleQueries(song) {
  return buildTitleVariants(song).slice(0, 6)
}

async function runSpotifySearch(query, retries = 2) {
  const token = await getClientCredToken()
  const q = encodeURIComponent(query)
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchJsonWithTimeout(
      `https://api.spotify.com/v1/search?q=${q}&type=track&limit=5&market=TW`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '1', 10)
      if (retryAfter > 60) {
        console.warn(`[spotify] 429 限流，retry-after=${retryAfter}s 超出上限，直接跳过`)
        return []
      }
      const wait = retryAfter * 1000
      console.warn(`[spotify] 429 限流，等待 ${wait}ms 后重试 (${attempt + 1}/${retries})`)
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      return []
    }
    const data = await res.json()
    return data?.tracks?.items || []
  }
  return []
}

function scoreSpotifyTrack(track, song, options = {}) {
  const titleScore = titleMatchScore(buildTitleVariants(song), track?.name)
  if (titleScore < 72) return null

  const hasBadTitle = SPOTIFY_BAD_TITLE_KWS.some(kw => normalizeSpotifyText(track?.name).includes(kw))
  if (hasBadTitle && titleScore < 100) return null

  const artists = (track?.artists || []).map(a => normalizeBaseText(a.name)).filter(Boolean)
  const artistScore = artistMatchScore(buildArtistVariants(song), artists)
  if (artistScore === 0 && !(options.allowExactTitleWithoutArtist && titleScore === 100)) {
    return null
  }

  return {
    track,
    score: titleScore * 2 + artistScore - (hasBadTitle ? 24 : 0),
  }
}

// ── Client Credentials Token（搜索用）───────────────────────────
async function getClientCredToken() {
  if (clientCredToken && clientCredToken.expiresAt > Date.now() + 30000) {
    return clientCredToken.access_token
  }
  const res = await fetchJsonWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Spotify client credentials failed: ' + JSON.stringify(data))
  clientCredToken = {
    access_token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  }
  return clientCredToken.access_token
}

// ── Authorization URL（引导用户授权）────────────────────────────
function getAuthUrl(state = '') {
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
  ].join(' ')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: scopes,
    redirect_uri: REDIRECT_URI,
    state,
  })
  return `https://accounts.spotify.com/authorize?${params}`
}

// ── 用 code 换 token ─────────────────────────────────────────────
async function exchangeCode(code) {
  const res = await fetchJsonWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Spotify exchange failed: ' + JSON.stringify(data))
  userAccessToken = data.access_token
  userRefreshToken = data.refresh_token
  userTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000
  await persistUserToken()
  return data
}

// ── 刷新 User Token ──────────────────────────────────────────────
async function refreshUserToken() {
  if (!userRefreshToken) throw new Error('No refresh token')
  const res = await fetchJsonWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: userRefreshToken,
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('Spotify refresh failed: ' + JSON.stringify(data))
  userAccessToken = data.access_token
  userTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000
  if (data.refresh_token) userRefreshToken = data.refresh_token
  await persistUserToken()
  return userAccessToken
}

// ── 获取有效的 User Token ────────────────────────────────────────
async function getUserToken() {
  if (!userAccessToken && !userRefreshToken) return null
  if (Date.now() > userTokenExpiresAt) {
    try { await refreshUserToken() } catch { return null }
  }
  if (!userAccessToken && userRefreshToken) {
    try { return await refreshUserToken() } catch { return null }
  }
  return userAccessToken
}

function hasUserToken() {
  return !!userAccessToken || !!userRefreshToken
}

// ── 搜索曲目，返回 Spotify Track ID ─────────────────────────────
async function searchTrack(songOrName, artist) {
  const song = makeSongSearchProfile(songOrName, artist)

  for (const query of buildStructuredQueries(song)) {
    const tracks = await runSpotifySearch(query)
    if (!tracks.length) continue

    const best = tracks
      .map(track => scoreSpotifyTrack(track, song, { allowExactTitleWithoutArtist: true }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]

    if (best?.track) {
      return {
        uri: best.track.uri || null,
        id: best.track.id || null,
        name: best.track.name || song.name,
        artists: (best.track.artists || []).map(a => a.name).filter(Boolean),
        album: best.track.album?.name || null,
      }
    }
  }

  for (const query of buildLooseTitleQueries(song)) {
    const tracks = await runSpotifySearch(query)
    if (!tracks.length) continue

    const best = tracks
      .map(track => scoreSpotifyTrack(track, song, { allowExactTitleWithoutArtist: true }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0]

    if (best?.track) {
      return {
        uri: best.track.uri || null,
        id: best.track.id || null,
        name: best.track.name || song.name,
        artists: (best.track.artists || []).map(a => a.name).filter(Boolean),
        album: best.track.album?.name || null,
      }
    }
  }

  return null
}

// ── 批量搜索，返回 { name, artist, uri } 列表 ───────────────────
async function resolveSpotifyUris(songs) {
  const results = await Promise.all(
    songs.map(async song => {
      try {
        const match = await searchTrack(song)
        if (!match?.uri) return null
        return {
          song_info: {
            ...song,
            id: match.id || song.id || null,
            name: match.name || song.name,
            artist: match.artists?.length ? match.artists.join('; ') : song.artist,
          },
          spotify_uri: match.uri,
          spotify_track: match,
        }
      } catch (e) {
        console.error(`[spotify] 搜索失败 "${song.name}":`, e.message)
        return null
      }
    })
  )
  return results.filter(Boolean)
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getUserToken,
  hasUserToken,
  initializeUserToken,
  refreshUserToken,
  resolveSpotifyUris,
  searchTrack,
  getClientCredToken,
}
