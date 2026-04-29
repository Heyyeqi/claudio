const fs = require('fs')
const path = require('path')
const { Lunar } = require('lunar-javascript')
const state = require('./state')
const { samplePool } = require('./songpool')
const { getAstronomyContext } = require('./astronomy')

const ROOT = path.join(__dirname, '..')
let currentWeather = null
const RECENT_RECOMMENDED_PREF = 'recent_recommended_keys_v1'
const MAX_RECENT_RECOMMENDED_KEYS = 160
const STORED_COORDS_PREF = 'user_coords_v1'
const SOLAR_PHASE_LABELS = {
  night: '深夜',
  astronomical_dawn: '天文晨光',
  nautical_dawn: '航海晨光',
  civil_dawn: '民用晨光',
  sunrise: '日出',
  morning: '上午',
  noon: '正午',
  afternoon: '下午',
  civil_dusk: '民用昏影',
  nautical_dusk: '航海昏影',
  astronomical_dusk: '天文昏影',
}
const shanghaiHourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  hour12: false,
})

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    return res
  } finally {
    clearTimeout(timer)
  }
}

function readFile(relPath) {
  try {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  } catch {
    return ''
  }
}

function getStoredCoordinates() {
  try {
    const raw = state.getPref(STORED_COORDS_PREF)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lon !== 'number') return null
    return { lat: parsed.lat, lon: parsed.lon, savedAt: parsed.savedAt || null }
  } catch {
    return null
  }
}

function storeCoordinates(lat, lon) {
  state.setPref(STORED_COORDS_PREF, JSON.stringify({
    lat,
    lon,
    savedAt: new Date().toISOString(),
  }))
}

function getShanghaiHour(date = new Date()) {
  return Number(shanghaiHourFormatter.format(date))
}

function inferAmbientEmotion(astronomy, weather, hourOfDay) {
  if (!astronomy) return []

  const signals = []

  if (hourOfDay >= 0 && hourOfDay < 4) signals.push('深夜孤独感')
  if (hourOfDay >= 4 && hourOfDay < 6) signals.push('黎明前的静默')

  if (astronomy.lunar.phaseName === 'full' && astronomy.lunar.isVisible) {
    signals.push('满月情绪放大')
  }
  if (astronomy.lunar.phaseName === 'new') {
    signals.push('新月内省')
  }

  if (weather?.main === 'Rain' && hourOfDay >= 20) {
    signals.push('夜雨绵长')
  }
  if (weather?.main === 'Clear' && astronomy.solar.altitude < -6) {
    signals.push('晴夜清醒')
  }

  if (astronomy.cultural.primaryMood) {
    signals.push(astronomy.cultural.primaryMood)
  }

  if (astronomy.solarTerm.daysUntilNext <= 2) {
    signals.push(`${astronomy.solarTerm.next}将至`)
  }

  return [...new Set(signals)]
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

function makeLocationParts(cityLine, areaLine, fallbackLabel = '当前位置') {
  const city = normalizeCityName(cityLine, fallbackLabel)
  const area = normalizeCityName(areaLine, '')
  return {
    cityLine: city,
    areaLine: area && area !== city ? area : '',
  }
}

function makeEmptyLocationParts() {
  return { cityLine: '', areaLine: '' }
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
  cityLine = '',
  areaLine = '',
}) {
  const displayCity = normalizeCityName(city || locationName, '当前位置')
  const displayLocation = normalizeCityName(locationName || city, displayCity)
  const locationParts = cityLine || areaLine
    ? makeLocationParts(cityLine || displayCity, areaLine || displayLocation, displayCity)
    : makeEmptyLocationParts()
  return {
    main,
    description,
    temp,
    city: displayCity,
    locationName: displayLocation,
    cityLine: locationParts.cityLine,
    areaLine: locationParts.areaLine,
    sunrise,
    sunset,
    sunriseTs,
    sunsetTs,
    cloudiness,
    text: `${locationParts.cityLine}${locationParts.areaLine ? ' ' + locationParts.areaLine : ''}，${description}，${temp}°C`,
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
  const parts = typeof cityLabel === 'object' && cityLabel
    ? cityLabel
    : makeLocationParts(cityLabel || locationName, '', locationName)
  return makeWeatherState({
    main,
    description: desc,
    temp,
    city: parts.cityLine || locationName,
    locationName,
    sunrise,
    sunset,
    sunriseTs,
    sunsetTs,
    cloudiness: typeof data?.clouds?.all === 'number' ? data.clouds.all : null,
    cityLine: parts.cityLine,
    areaLine: parts.areaLine,
  })
}

async function fetchCityLabelByCoords(lat, lon, fallbackLabel) {
  try {
    // 用 Nominatim（OpenStreetMap）反地理编码，精度到区县级，免费无需 Key
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=zh,en&zoom=12`
    const res = await fetchJsonWithTimeout(url, {
      headers: { 'User-Agent': 'RodiO/1.0 (personal music app)' }
    })
    const data = await res.json()
    const addr = data?.address
    if (!addr) return makeEmptyLocationParts()

    const country = addr.country_code?.toUpperCase()

    // 中国：城市 + 区县
    if (country === 'CN') {
      const city = addr.city || addr.municipality || addr.state_district || addr.county || addr.state || ''
      const district = addr.city_district || addr.district || addr.suburb || ''
      return city || district ? makeLocationParts(city || district, district, '当前位置') : makeEmptyLocationParts()
    }

    // 日本：都市 + 区
    if (country === 'JP') {
      const city = addr.city || addr.town || addr.county || ''
      const ward = addr.city_district || addr.suburb || ''
      return city || ward ? makeLocationParts(city || ward, ward, '当前位置') : makeEmptyLocationParts()
    }

    // 美国：城市, 州缩写
    if (country === 'US') {
      const city = addr.city || addr.town || addr.village || addr.county || ''
      const stateAbbr = addr.ISO3166_2_lvl4?.replace('US-', '') || addr.state || ''
      return city || stateAbbr ? makeLocationParts(city || stateAbbr, stateAbbr, '当前位置') : makeEmptyLocationParts()
    }

    // 英国：城市 + 区
    if (country === 'GB') {
      const city = addr.city || addr.town || addr.county || ''
      const district = addr.city_district || addr.suburb || ''
      return city || district ? makeLocationParts(city || district, district, '当前位置') : makeEmptyLocationParts()
    }

    // 其他国家：城市（+ 区，如果有）
    const city = addr.city || addr.town || addr.municipality || addr.county || addr.state || ''
    const district = addr.city_district || addr.district || addr.suburb || ''
    return city || district ? makeLocationParts(city || district, district, '当前位置') : makeEmptyLocationParts()

  } catch {
    // Nominatim 失败时 fallback 到 OpenWeatherMap geo
    try {
      const key = process.env.WEATHER_API_KEY
      if (!key || key === 'xxxxxxxx') return makeEmptyLocationParts()
      const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${key}`
      const res = await fetchJsonWithTimeout(url)
      const geoData = await res.json()
      const place = Array.isArray(geoData) ? geoData[0] : null
      if (!place) return makeEmptyLocationParts()
      return makeLocationParts(
        place.local_names?.zh || place.name || place.state || fallbackLabel,
        place.state || '',
        '当前位置'
      )
    } catch {
      return makeEmptyLocationParts()
    }
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
      cityLine: '',
      areaLine: '',
    })
    return currentWeather
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${key}&units=metric&lang=zh_cn`
    const [res, cityLabel] = await Promise.all([
      fetchJsonWithTimeout(url),
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
      cityLine: '',
      areaLine: '',
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
      cityLine: '',
      areaLine: '',
    })
    return currentWeather
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric&lang=zh_cn`
    const res = await fetchJsonWithTimeout(url)
    const data = await res.json()
    currentWeather = formatWeather(data, city)
    return currentWeather
  } catch {
    currentWeather = makeWeatherState({
      description: '天气获取失败',
      temp: '?',
      city,
      locationName: city,
      cityLine: '',
      areaLine: '',
    })
    return currentWeather
  }
}

async function getWeather() {
  if (currentWeather) return currentWeather
  const coords = getStoredCoordinates()
  if (coords) return fetchWeatherByCoords(coords.lat, coords.lon)
  return fetchWeatherByCity()
}

async function getEnvironmentSnapshot() {
  const now = new Date()
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const weather = await getWeather()
  const lunar = getLunarLabel(now)
  const sunriseText = weather.sunrise || '未知'
  const sunsetText = weather.sunset || '未知'
  const coords = getStoredCoordinates()
  const astronomy = coords
    ? await getAstronomyContext(coords.lat, coords.lon, now.getTime()).catch(() => null)
    : null
  const inferredEmotions = inferAmbientEmotion(astronomy, weather, getShanghaiHour(now))
  const astronomyText = astronomy
    ? [
        '【天文与文化背景】',
        `${SOLAR_PHASE_LABELS[astronomy.solar.phase] || astronomy.solar.phase} · 太阳高度角 ${astronomy.solar.altitude.toFixed(1)}°`,
        `月相：${astronomy.lunar.phaseName} · 照度 ${Math.round(astronomy.lunar.illumination * 100)}%`,
        astronomy.lunar.isVisible ? '月亮可见' : '月亮未出',
        `农历：${astronomy.lunarCalendar.yearName}年 ${astronomy.lunarCalendar.monthName}${astronomy.lunarCalendar.dayName}`,
        `节气：${astronomy.solarTerm.current ? `今日${astronomy.solarTerm.current}` : `距${astronomy.solarTerm.next}还有${astronomy.solarTerm.daysUntilNext}天`}`,
        `季节质感：${astronomy.seasonalQuality.label} · ${astronomy.seasonalQuality.atmosphericMood}`,
        astronomy.cultural.festivals.length > 0
          ? `文化节点：${astronomy.cultural.festivals.map(f => f.name).join('、')} · 情绪底色：${astronomy.cultural.primaryMood}`
          : '',
        astronomy.cultural.festivals.some(f => f.promptHint)
          ? `文化提示：${astronomy.cultural.festivals.filter(f => f.promptHint).map(f => f.promptHint).join(' ')}` 
          : '',
        `星空能见度：${Math.round(astronomy.stars.visibility * 100)}%`,
      ].filter(Boolean).join('\n')
    : ''

  return {
    timeStr,
    weather,
    lunar,
    astronomy,
    inferredEmotions,
    envText: `当前时间：${timeStr}\n天气：${weather.text}\n农历：${lunar}\n日出：${sunriseText}\n日落：${sunsetText}${astronomyText ? `\n${astronomyText}` : ''}`,
  }
}

async function buildContext(userInput, options = {}) {
  const currentQueue = Array.isArray(options.currentQueue) ? options.currentQueue : []
  const emotionSignal = options.emotionSignal || null
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
  const inferredEmotionsText = envSnapshot.inferredEmotions?.length
    ? `【此刻情绪推断】\n${envSnapshot.inferredEmotions.join(' · ')}\n请将以上情绪信号融入选曲判断，不必每个都体现，但整体基调应与这些信号和谐。`
    : ''
  const userEmotionText = emotionSignal
    ? `【用户当下情绪信号】\n用户描述：「${userInput}」\n识别情绪：${emotionSignal.mood}\n选曲建议方向：${emotionSignal.suggestion}\n此信号优先级高于时段和天气，请以此为核心选曲。`
    : ''

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
    inferredEmotionsText,
    userEmotionText,
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
    '{"say":"播报文案，一次介绍这批歌的整体氛围（将被转为语音，100字以内）","play":[{"id":"0","name":"歌名（必须来自可选曲库）","artist":"艺人全名（必须来自可选曲库）"}],"replace_pool":false,"reason":"内部选曲逻辑说明（不播报）","segue":"播完最后一首后衔接下一批的话"}',
    '【选曲规则】① play 数组默认输出 8-12 首；如果当前请求明确要求 15 首，则必须输出 15 首 ② 所有歌曲必须来自上方"可选曲库"，歌名和艺人名保持原样，不得修改 ③ 禁止推荐"用户明确不喜欢的歌"、"近期已播放"或"当前队列中已有的歌"里的任何一首 ④ 如果用户点过喜欢，优先延续这些歌或这些艺人的气质、编曲、情绪线索，但不要机械重复同一首 ⑤ 根据当前时间和用户品味从曲库中挑选最契合的几首 ⑥ 如果用户只是闲聊不涉及音乐，play 数组可为空 ⑦ artist 字段必须填写原唱艺人全名，禁止填写翻唱歌手、配乐版、钢琴版、纯音乐版等非原唱版本的艺人名 ⑧ replace_pool 是布尔值：只有当用户明确要求完全换一种风格、情绪或方向，导致当前池子整体都不该继续时，才返回 true；普通的补充、微调、延续、陪聊后一两句点歌都返回 false',
    '请根据以上天文与文化背景，结合时段和天气，选择在此刻听来最自然、最贴切的音乐。不要只考虑时段标签，要考虑今天这一天的具体质感。清明前后选曲应有感伤或宁静；梅雨季选曲应有绵长或慵懒；满月深夜选曲可以更空灵；节气当天可以选有仪式感的音乐。',
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
  getStoredCoordinates,
  storeCoordinates,
  inferAmbientEmotion,
}
