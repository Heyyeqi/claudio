// ── Spotify 模块 ─────────────────────────────────────────────────
const state = require('./state')
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://web-production-a5193.up.railway.app/callback'
const SPOTIFY_TOKEN_PREF = 'spotify_user_token_v1'
const SPOTIFY_BAD_TITLE_KWS = [
  'live', 'remix', 'acoustic', 'instrumental', 'cover', 'tribute',
  'karaoke', 'piano', 'version', 'ver.', 'edit', 'mono', 'demo',
]

let clientCredToken = null      // 用于搜索（不需要用户授权）
let userAccessToken = null      // 用于播放（需要用户授权）
let userRefreshToken = null
let userTokenExpiresAt = 0

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function loadPersistedUserToken() {
  try {
    const raw = state.getPref(SPOTIFY_TOKEN_PREF)
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (parsed?.refresh_token) userRefreshToken = parsed.refresh_token
    if (parsed?.access_token) userAccessToken = parsed.access_token
    if (typeof parsed?.expires_at === 'number') userTokenExpiresAt = parsed.expires_at
  } catch {}
}

function persistUserToken() {
  try {
    state.setPref(SPOTIFY_TOKEN_PREF, JSON.stringify({
      access_token: userAccessToken,
      refresh_token: userRefreshToken,
      expires_at: userTokenExpiresAt,
      updated_at: Date.now(),
    }))
  } catch (e) {
    console.error('[spotify] 保存 token 失败:', e.message)
  }
}

loadPersistedUserToken()

function normalizeSpotifyText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'".,!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSpotifyTitle(text) {
  return normalizeSpotifyText(text)
    .replace(/\b(feat|ft|with|and)\b.*$/g, '')
    .replace(/\b(live|remix|acoustic|instrumental|cover|tribute|karaoke|piano|version|ver\.|edit|mono|demo)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  persistUserToken()
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
  persistUserToken()
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
async function searchTrack(name, artist) {
  const token = await getClientCredToken()
  const q = encodeURIComponent(`track:${name} artist:${artist}`)
  const res = await fetchJsonWithTimeout(
    `https://api.spotify.com/v1/search?q=${q}&type=track&limit=3&market=TW`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  const tracks = data?.tracks?.items || []
  if (!tracks.length) return null
  const expectedArtist = normalizeSpotifyText(artist)
  const expectedTitle = normalizeSpotifyTitle(name)
  const allowedTitles = expectedTitle ? [expectedTitle] : []

  const scored = tracks
    .map(track => {
      const title = normalizeSpotifyTitle(track.name)
      const artists = (track.artists || []).map(a => normalizeSpotifyText(a.name)).filter(Boolean)
      const hasBadTitle = SPOTIFY_BAD_TITLE_KWS.some(kw => normalizeSpotifyText(track.name).includes(kw))
      if (!title || hasBadTitle) return null

      const exactTitle = title === expectedTitle
      const titleMatch = exactTitle || (expectedTitle && (title.includes(expectedTitle) || expectedTitle.includes(title)))
      if (!titleMatch && allowedTitles.length) return null

      const artistExact = artists.includes(expectedArtist)
      const artistMatch = artistExact || artists.some(a => a.includes(expectedArtist) || expectedArtist.includes(a))
      if (!artistMatch) return null

      const score = (exactTitle ? 3 : 0) + (artistExact ? 2 : 0)
      return { track, score }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  const track = scored[0]?.track || null
  if (!track) return null
  return {
    uri: track.uri || null,
    id: track.id || null,
    name: track.name || name,
    artists: (track.artists || []).map(a => a.name).filter(Boolean),
    album: track.album?.name || null,
  }
}

// ── 批量搜索，返回 { name, artist, uri } 列表 ───────────────────
async function resolveSpotifyUris(songs) {
  const results = await Promise.all(
    songs.map(async song => {
      try {
        const match = await searchTrack(song.name, song.artist)
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
  refreshUserToken,
  resolveSpotifyUris,
  searchTrack,
  getClientCredToken,
}
