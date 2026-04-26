const fs = require('fs')
const path = require('path')
const { Lunar } = require('lunar-javascript')
const state = require('./state')
const { samplePool } = require('./songpool')

const ROOT = path.join(__dirname, '..')
let currentWeather = null
const RECENT_RECOMMENDED_PREF = 'recent_recommended_keys_v1'
const MAX_RECENT_RECOMMENDED_KEYS = 160

function readFile(relPath) {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  } catch {
    return ''
  }
}

function getLunarLabel(date = new Date()) {
  const lunar = Lunar.fromDate(date)
  const month = lunar.getMonthInChinese()
  const day = lunar.getDayInChinese()
  const parts = [`农历${month}月${day}`]
  const festival = lunar.getFestivals()[0] || lunar.getOtherFestivals()[0]
  const jieQi = lunar.getJieQi()

  if (jieQi) parts.push(jieQi)
  if (festival) parts.push(festival)

  return parts.join('，')
}

function formatClock(timestampSeconds) {
  if (!timestampSeconds) return null
  return new Date(timestampSeconds * 1000).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function normalizeCityName(name, fallbackLabel) {
  const value = String(name || fallbackLabel || '').trim()
  if (!value) return '当前位置'
  return value
}

function makeWeatherState({
  main = 'Clear',
  description = '未知',
  temp = '?',
  city = '',
  locationName = '',
  sunrise = null,
  sunset = null,
  sunriseTs = null,
  sunsetTs = null,
  cloudiness = null,
}) {
  const displayCity = normalizeCityName(city || locationName, '当前位置')
  const displayLocation = normalizeCityName(locationName || city, displayCity)
  return {
    main,
    description,
    temp,
    city: displayCity,
    locationName: displayLocation,
    sunrise,
    sunset,
    sunriseTs,
    sunsetTs,
    cloudiness,
    text: `${displayCity}，${description}，${temp}°C`,
  }
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

function formatWeather(data, fallbackLabel, cityLabel = null) {
  const main = data?.weather?.[0]?.main || 'Clear'
  const desc = data?.weather?.[0]?.description || '未知'
  const temp = data?.main?.temp ?? '?'
  const locationName = data?.name || fallbackLabel
  const sunriseTs = data?.sys?.sunrise || null
  const sunsetTs = data?.sys?.sunset || null
  const sunrise = formatClock(data?.sys?.sunrise)
  const sunset = formatClock(data?.sys?.sunset)
  return makeWeatherState({
    main,
    description: desc,
    temp,
    city: cityLabel || locationName,
    locationName,
    sunrise,
    sunset,
    sunriseTs,
    sunsetTs,
    cloudiness: typeof data?.clouds?.all === 'number' ? data.clouds.all : null,
  })
}

async function fetchCityLabelByCoords(lat, lon, fallbackLabel) {
  const key = process.env.WEATHER_API_KEY
  if (!key || key === 'xxxxxxxx') return normalizeCityName(fallbackLabel, '当前位置')

  try {
    const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${key}`
    const res = await fetch(url)
    const data = await res.json()
    const place = Array.isArray(data) ? data[0] : null
    if (!place) return normalizeCityName(fallbackLabel, '当前位置')

    // For CN locations, state usually maps better to the city/municipality level
    // than the district-like `name` field returned by the weather endpoint.
    if (place.country === 'CN' && place.state) {
      return normalizeCityName(place.local_names?.zh || place.state, fallbackLabel)
    }

    return normalizeCityName(
      place.local_names?.zh ||
      place.name ||
      place.state ||
      fallbackLabel,
      '当前位置'
    )
  } catch {
    return normalizeCityName(fallbackLabel, '当前位置')
  }
}

async function fetchWeatherByCoords(lat, lon) {
  const key = process.env.WEATHER_API_KEY
  if (!key || key === 'xxxxxxxx') {
    currentWeather = makeWeatherState({
      description: '天气未知',
      temp: '?',
      city: '当前位置',
      locationName: '当前位置',
    })
    return currentWeather
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=metric&lang=zh_cn`
    const [res, cityLabel] = await Promise.all([
      fetch(url),
      fetchCityLabelByCoords(lat, lon, '当前位置'),
    ])
    const data = await res.json()
    currentWeather = formatWeather(data, '当前位置', cityLabel)
    return currentWeather
  } catch {
    currentWeather = makeWeatherState({
      description: '天气获取失败',
      temp: '?',
      city: '当前位置',
      locationName: '当前位置',
    })
    return currentWeather
  }
}

async function fetchWeatherByCity() {
  const key = process.env.WEATHER_API_KEY
  const city = process.env.WEATHER_CITY || 'Shanghai'
  if (!key || key === 'xxxxxxxx') {
    currentWeather = makeWeatherState({
      description: '天气未知',
      temp: '?',
      city,
      locationName: city,
    })
    return currentWeather
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric&lang=zh_cn`
    const res = await fetch(url)
    const data = await res.json()
    currentWeather = formatWeather(data, city)
    return currentWeather
  } catch {
    currentWeather = makeWeatherState({
      description: '天气获取失败',
      temp: '?',
      city,
      locationName: city,
    })
    return currentWeather
  }
}

async function getWeather() {
  if (currentWeather) return currentWeather
  return fetchWeatherByCity()
}

async function getEnvironmentSnapshot() {
  const now = new Date()
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const weather = await getWeather()
  const lunar = getLunarLabel(now)
  const sunriseText = weather.sunrise || '未知'
  const sunsetText = weather.sunset || '未知'

  return {
    timeStr,
    weather,
    lunar,
    envText: `当前时间：${timeStr}\n天气：${weather.text}\n农历：${lunar}\n日出：${sunriseText}\n日落：${sunsetText}`,
  }
}

async function buildContext(userInput, options = {}) {
  const currentQueue = Array.isArray(options.currentQueue) ? options.currentQueue : []
  const recentRecommendedKeys = new Set(loadRecentRecommendedKeys())

  // ① DJ 人格
  const persona = readFile('prompts/dj-persona.md')

  // ② 用户品味 + 规律
  const taste = readFile('user/taste.md')
  const routines = readFile('user/routines.md')
  const moodRules = readFile('prompts/mood-rules.md')

  // ③ 环境注入
  const envSnapshot = await getEnvironmentSnapshot()
  const env = envSnapshot.envText

  // ④ 已检索记忆（去重后取最近 50 首）
  const recentMsgs = state.getRecentMessages(10)
  const rawPlays = state.getRecentPlays(120)
  // 按 song_id 去重，保留最新一次
  const seenKeys = new Set()
  const dedupedPlays = rawPlays.filter(p => {
    const key = `${p.song_name}::${p.artist}`
    if (seenKeys.has(key)) return false
    seenKeys.add(key)
    return true
  }).slice(0, 50)

  const playsStr = dedupedPlays.length
    ? dedupedPlays.map(p => `${p.song_name} / ${p.artist}`).join('、')
    : '无'

  const likedSongs = state.getFeedbackByType('like', 20)
  const dislikedSongs = state.getFeedbackByType('dislike', 100)
  const likedArtists = [...new Set(likedSongs.map(song => song.artist).filter(Boolean))]
  const likedStr = likedSongs.length
    ? likedSongs.map(song => `${song.song_name} / ${song.artist}`).join('、')
    : '无'
  const likedArtistStr = likedArtists.length ? likedArtists.join('、') : '无'
  const dislikedStr = dislikedSongs.length
    ? dislikedSongs.map(song => `${song.song_name} / ${song.artist}`).join('、')
    : '无'

  const queueSongs = currentQueue
    .map(item => item?.song_info
      ? `${item.song_info.name} / ${item.song_info.artist}`
      : null)
    .filter(Boolean)
  const queueStr = queueSongs.length ? queueSongs.join('、') : '无'

  // ⑤ 从用户真实曲库中采样候选歌曲（排除近期已播）
  const excludeKeys = new Set([
    ...dedupedPlays.map(p => `${p.song_name}::${p.artist}`.toLowerCase()),
    ...dislikedSongs.map(p => `${p.song_name}::${p.artist}`.toLowerCase()),
    ...recentRecommendedKeys,
    ...currentQueue
      .map(item => item?.song_info
        ? `${item.song_info.name}::${item.song_info.artist}`.toLowerCase()
        : null)
      .filter(Boolean),
  ])
  const poolSample = samplePool(120, excludeKeys, {
    preferredArtists: likedArtists,
  })
  const poolStr = poolSample.map(s => `${s.name} / ${s.artist}`).join('\n')

  const system = [
    persona,
    '---',
    '## 用户品味',
    taste,
    '## 日常规律',
    routines,
    '## 选曲规则',
    moodRules,
    '---',
    '## 当前环境',
    env,
    '---',
    `## 用户明确喜欢的歌\n${likedStr}`,
    `## 用户最近偏爱的艺人\n${likedArtistStr}`,
    '---',
    `## 用户明确不喜欢的歌（禁止推荐）\n${dislikedStr}`,
    '---',
    `## 近期已播放（禁止重复推荐这些歌）\n${playsStr}`,
    '---',
    `## 当前队列中已有的歌（禁止重复推荐这些歌）\n${queueStr}`,
    `## 最近已经推荐过但仍在冷却期内的歌（也请避免重复）\n${recentRecommendedKeys.size ? [...recentRecommendedKeys].join('、') : '无'}`,
    '---',
    '## 可选曲库（必须从此列表中选曲，不要编造列表外的歌曲）',
    poolStr,
    '---',
    '你必须且只能输出一个合法 JSON 对象，不含任何 markdown 包裹，格式如下：',
    '{"say":"播报文案，一次介绍这批歌的整体氛围（将被转为语音，100字以内）","play":[{"id":"0","name":"歌名（必须来自可选曲库）","artist":"艺人全名（必须来自可选曲库）"}],"reason":"内部选曲逻辑说明（不播报）","segue":"播完最后一首后衔接下一批的话"}',
    '【选曲规则】① play 数组包含 8-12 首 ② 所有歌曲必须来自上方"可选曲库"，歌名和艺人名保持原样 ③ 禁止推荐"用户明确不喜欢的歌"、"近期已播放"或"当前队列中已有的歌"里的任何一首 ④ 如果用户点过喜欢，优先延续这些歌或这些艺人的气质、编曲、情绪线索，但不要机械重复同一首 ⑤ 根据当前时间和用户品味从曲库中挑选最契合的几首 ⑥ 如果用户只是闲聊不涉及音乐，play 数组可为空',
  ].join('\n')

  const messages = [
    ...recentMsgs,
    { role: 'user', content: userInput },
  ]

  return { system, messages }
}

module.exports = {
  buildContext,
  fetchWeatherByCoords,
  fetchWeatherByCity,
  getEnvironmentSnapshot,
  getWeather,
}
