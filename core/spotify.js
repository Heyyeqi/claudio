// ── Spotify 模块 ─────────────────────────────────────────────────
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://web-production-a5193.up.railway.app/callback'

let clientCredToken = null      // 用于搜索（不需要用户授权）
let userAccessToken = null      // 用于播放（需要用户授权）
let userRefreshToken = null
let userTokenExpiresAt = 0

// ── Client Credentials Token（搜索用）───────────────────────────
async function getClientCredToken() {
  if (clientCredToken && clientCredToken.expiresAt > Date.now() + 30000) {
    return clientCredToken.access_token
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  return data
}

// ── 刷新 User Token ──────────────────────────────────────────────
async function refreshUserToken() {
  if (!userRefreshToken) throw new Error('No refresh token')
  const res = await fetch('https://accounts.spotify.com/api/token', {
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
  return userAccessToken
}

// ── 获取有效的 User Token ────────────────────────────────────────
async function getUserToken() {
  if (!userAccessToken) return null
  if (Date.now() > userTokenExpiresAt) {
    try { await refreshUserToken() } catch { return null }
  }
  return userAccessToken
}

function hasUserToken() {
  return !!userAccessToken
}

// ── 搜索曲目，返回 Spotify Track ID ─────────────────────────────
async function searchTrack(name, artist) {
  const token = await getClientCredToken()
  const q = encodeURIComponent(`track:${name} artist:${artist}`)
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${q}&type=track&limit=3&market=TW`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  const tracks = data?.tracks?.items || []
  if (!tracks.length) return null
  // 优先完整匹配歌手名
  const artistLower = artist.toLowerCase()
  const match = tracks.find(t =>
    t.artists.some(a => a.name.toLowerCase().includes(artistLower) || artistLower.includes(a.name.toLowerCase()))
  )
  return (match || tracks[0])?.uri || null  // spotify:track:xxx
}

// ── 批量搜索，返回 { name, artist, uri } 列表 ───────────────────
async function resolveSpotifyUris(songs) {
  const results = await Promise.all(
    songs.map(async song => {
      try {
        const uri = await searchTrack(song.name, song.artist)
        if (!uri) return null
        return { song_info: song, spotify_uri: uri }
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
