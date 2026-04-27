/**
 * songpool.js — 从用户真实收藏中构建可供选曲的曲库
 *
 * 数据来源：
 *   user/ncm-playlist.txt      网易云歌单（格式：歌名 - 艺人名）
 *   user/xiami-liked-songs.csv 虾米收藏歌曲（列：歌曲名,专辑名,艺人名,...）
 *   user/xiami-playlists.csv   虾米创建歌单（列：歌单名,简介,歌曲名,艺人名,...）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// ── 解析器 ────────────────────────────────────

function parseNcmTxt(filePath) {
  const songs = []
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // 格式: 歌名 - 艺人名 / 歌名 – 艺人名 / 歌名 — 艺人名
      const sep = trimmed.match(/ [-–—] /)
      const idx = sep ? sep.index : -1
      if (idx === -1) continue
      const name = trimmed.slice(0, idx).trim()
      const artist = trimmed.slice(idx + sep[0].length).trim()
      if (name && artist) songs.push({ name, artist })
    }
  } catch { /* 文件不存在时静默 */ }
  return songs
}

function parseXiamiLikedSongs(filePath) {
  const songs = []
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const parts = line.split(',')
      if (parts.length < 3) continue
      const name = parts[0].trim().replace(/^"|"$/g, '')
      const rawArtist = parts[2].trim().replace(/^"|"$/g, '')
      const artist = rawArtist.split(';')[0].trim()
      if (name && artist) songs.push({ name, artist })
    }
  } catch { }
  return songs
}

function parseXiamiPlaylists(filePath) {
  const songs = []
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const parts = line.split(',')
      if (parts.length < 4) continue
      const name = parts[2].trim().replace(/^"|"$/g, '')
      const rawArtist = parts[3].trim().replace(/^"|"$/g, '')
      const artist = rawArtist.split(/[;/／]|\s\/\s/)[0].trim()
      if (name && artist) songs.push({ name, artist })
    }
  } catch { }
  return songs
}

function parseSpotifyPlaylists(dirPath) {
  const songs = []
  try {
    if (!fs.existsSync(dirPath)) return songs
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.csv'))
    for (const file of files) {
      const lines = fs.readFileSync(path.join(dirPath, file), 'utf8').split(/\r?\n/)
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        const parts = line.match(/(".*?"|[^,]+)(?=,|$)/g)
        if (!parts || parts.length < 4) continue
        const name = parts[1].replace(/^"|"$/g, '').trim()
        const rawArtist = parts[3].replace(/^"|"$/g, '').trim()
        const artist = rawArtist.split(';')[0].trim()
        if (name && artist) songs.push({ name, artist })
      }
    }
  } catch (e) {
    console.error('[songpool] Spotify 解析错误:', e.message)
  }
  return songs
}

// ── 加载 & 去重 ───────────────────────────────

let _pool = null

function loadPool() {
  if (_pool) return _pool

  const ncm = parseNcmTxt(path.join(ROOT, 'user/ncm-playlist.txt'))
  const liked = parseXiamiLikedSongs(path.join(ROOT, 'user/收藏的歌曲.csv'))
  const playlists = parseXiamiPlaylists(path.join(ROOT, 'user/创建的歌单.csv'))
  const spotify = parseSpotifyPlaylists(path.join(ROOT, 'user/spotify'))

  const all = [...ncm, ...liked, ...playlists, ...spotify]

  // 按 name::artist 去重
  const seen = new Set()
  _pool = all.filter(s => {
    const key = `${s.name}::${s.artist}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  console.log(`[songpool] 加载完成：${_pool.length} 首（NCM:${ncm.length} 虾米收藏:${liked.length} 虾米歌单:${playlists.length} Spotify:${spotify.length}）`)
  return _pool
}

// ── 取样：排除近期播放，随机采样 N 首 ──────────

function samplePool(n = 120, excludeKeys = new Set(), options = {}) {
  const preferredArtists = new Set((options.preferredArtists || []).map(artist => String(artist).trim().toLowerCase()).filter(Boolean))
  const pool = loadPool()
  const candidates = pool.filter(s => {
    const key = `${s.name}::${s.artist}`.toLowerCase()
    return !excludeKeys.has(key)
  })

  // Fisher-Yates 随机采样
  const result = []
  const preferred = []
  const regular = []
  candidates.forEach(song => {
    const artistKey = String(song.artist || '').trim().toLowerCase()
    if (preferredArtists.has(artistKey)) preferred.push(song)
    else regular.push(song)
  })
  const arr = [...preferred, ...regular]
  const artistCounts = new Map()
  const count = Math.min(n, arr.length)
  const preferredQuota = preferred.length > 0 ? Math.min(Math.ceil(count * 0.25), preferred.length) : 0
  let preferredPicked = 0
  for (let i = 0; i < arr.length && result.length < count; i++) {
    const j = i + Math.floor(Math.random() * (arr.length - i))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    const song = arr[i]
    const artistKey = String(song.artist || '').trim().toLowerCase()
    const currentCount = artistCounts.get(artistKey) || 0
    if (currentCount >= 2) continue
    const isPreferred = preferredArtists.has(artistKey)
    if (!isPreferred && preferredPicked < preferredQuota && preferred.length >= preferredQuota) continue
    artistCounts.set(artistKey, currentCount + 1)
    if (isPreferred) preferredPicked += 1
    result.push(song)
  }
  return result
}

module.exports = { loadPool, samplePool }
