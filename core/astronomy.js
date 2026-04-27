const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const J1970 = 2440587.5
const J2000 = 2451545
const OBLIQUITY = 23.4397 * DEG
const SHANGHAI_TZ = 'Asia/Shanghai'

const SOLAR_TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
  '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
  '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
]

const CULTURAL_EVENTS = [
  { name: '春节', type: 'lunar_festival', lunar: [1, 1], emotionTags: ['喜悦', '团圆', '新生', '热闹'] },
  { name: '元宵节', type: 'lunar_festival', lunar: [1, 15], emotionTags: ['温馨', '浪漫', '团圆'] },
  { name: '花朝节', type: 'lunar_festival', lunar: [2, 15], emotionTags: ['浪漫', '花开', '生机', '少女感', '春日'], canvasHint: 'petals' },
  { name: '清明节', type: 'solar_term', term: '清明', emotionTags: ['思念', '感伤', '宁静', '缅怀'] },
  { name: '寒食节', type: 'solar_term_relative', offsetFromTerm: { term: '清明', days: -1 }, emotionTags: ['思念', '缅怀', '静默', '冷清'], canvasHint: 'grey_mist' },
  { name: '佛诞（汉传）', type: 'lunar_festival', lunar: [4, 8], emotionTags: ['慈悲', '宁静', '觉知', '放下', '空灵'], canvasHint: 'soft_light' },
  { name: '端午节', type: 'lunar_festival', lunar: [5, 5], emotionTags: ['传统', '豪迈', '家国'] },
  { name: '佛诞（南传）', type: 'lunar_festival', lunar: [6, 15], emotionTags: ['慈悲', '宁静', '觉知', '放下', '空灵'], canvasHint: 'soft_light' },
  { name: '七夕', type: 'lunar_festival', lunar: [7, 7], emotionTags: ['浪漫', '思念', '爱意'] },
  { name: '中元节', type: 'lunar_festival', lunar: [7, 15], emotionTags: ['思念', '缅怀', '神秘'] },
  { name: '中秋节', type: 'lunar_festival', lunar: [8, 15], emotionTags: ['团圆', '思乡', '皎洁', '宁静'] },
  { name: '重阳节', type: 'lunar_festival', lunar: [9, 9], emotionTags: ['敬老', '感恩', '登高', '秋意', '思乡'], canvasHint: 'autumn_leaves' },
  { name: '小年', type: 'lunar_festival', lunar: [12, 23], emotionTags: ['年味', '温暖', '期待', '归家', '烟火气'], canvasHint: 'warm_glow' },
  { name: '冬至', type: 'solar_term', term: '冬至', emotionTags: ['团圆', '温暖', '家'] },
  { name: '元旦', type: 'gregorian_festival', date: [1, 1], emotionTags: ['新生', '希望', '回顾'] },
  { name: '情人节', type: 'gregorian_festival', date: [2, 14], emotionTags: ['爱意', '浪漫', '甜蜜'] },
  { name: '劳动节', type: 'gregorian_festival', date: [5, 1], emotionTags: ['轻松', '假期', '自由'] },
  { name: '国庆节', type: 'gregorian_festival', date: [10, 1], emotionTags: ['家国', '壮阔', '热闹'] },
  { name: '平安夜', type: 'gregorian_festival', date: [12, 24], emotionTags: ['温馨', '期待', '浪漫', '静谧', '礼物'], canvasHint: 'snow_soft' },
  { name: '圣诞节', type: 'gregorian_festival', date: [12, 25], emotionTags: ['温馨', '欢乐', '礼物'] },
  { name: '跨年夜', type: 'gregorian_festival', date: [12, 31], emotionTags: ['回顾', '感慨', '期待', '倒数', '烟花', '华丽'], canvasHint: 'fireworks' },
  { name: '生日', type: 'personal', lunar: [2, 9], emotionTags: ['感恩', '回顾', '庆祝', '独特', '珍贵', '自我'], canvasHint: 'birthday_glow' },
  { name: '妈妈生日', type: 'personal', lunar: [2, 26], emotionTags: ['感恩', '温柔', '家', '爱', '牵挂'], canvasHint: 'warm_glow' },
  { name: '爸爸生日', type: 'personal', lunar: [10, 25], emotionTags: ['思念', '温度', '父爱', '记忆', '珍惜', '陪伴'], canvasHint: 'warm_memory', promptHint: '这一天是用户已故父亲的生日，推荐有温度、有父亲意象或家的感觉的音乐，不要过于悲伤，是带着爱的思念，像一个拥抱。' },
  { name: '毕业季', type: 'social_season', dateRange: [[6, 15], [7, 10]], emotionTags: ['离别', '感恩', '成长', '不舍', '期待', '青春'], canvasHint: 'golden_dust', climatePatterns: ['temperate_china'] },
  { name: '开学季', type: 'social_season', dateRange: [[8, 25], [9, 10]], emotionTags: ['新开始', '期待', '紧张', '新鲜感'], canvasHint: 'morning_crisp', climatePatterns: ['temperate_china'] },
  { name: '梅雨季', type: 'climate', dateRange: [[6, 10], [7, 10]], emotionTags: ['潮湿', '绵长', '慵懒', '沉郁'], climatePatterns: ['temperate_china'] },
  { name: '盛夏', type: 'climate', dateRange: [[7, 11], [8, 24]], emotionTags: ['慵懒', '热烈', '自由', '假期', '海浪感'], canvasHint: 'heat_shimmer', climatePatterns: ['temperate_china'] },
  { name: '秋老虎', type: 'climate', dateRange: [[8, 20], [9, 15]], emotionTags: ['燥热', '焦灼', '渴望清凉'], climatePatterns: ['temperate_china'] },
  { name: '春寒料峭', type: 'climate', dateRange: [[2, 1], [3, 20]], emotionTags: ['乍暖还寒', '期待', '清醒'], climatePatterns: ['temperate_china'] },
]

const SEASONAL_QUALITY_WINDOWS = [
  { start: [2, 4], end: [3, 20], label: '早春', temperatureFeeling: '清凉', lightQuality: '柔和', atmosphericMood: '清新' },
  { start: [3, 21], end: [5, 4], label: '春暖', temperatureFeeling: '温暖', lightQuality: '明亮', atmosphericMood: '生机' },
  { start: [5, 5], end: [6, 9], label: '梅雨前', temperatureFeeling: '温暖', lightQuality: '明亮', atmosphericMood: '期待' },
  { start: [6, 10], end: [7, 10], label: '梅雨', temperatureFeeling: '炎热', lightQuality: '昏黄', atmosphericMood: '潮湿' },
  { start: [7, 11], end: [8, 19], label: '盛夏', temperatureFeeling: '炎热', lightQuality: '明亮', atmosphericMood: '燥烈' },
  { start: [8, 20], end: [9, 15], label: '秋老虎', temperatureFeeling: '炎热', lightQuality: '明亮', atmosphericMood: '焦灼' },
  { start: [9, 16], end: [10, 7], label: '初秋', temperatureFeeling: '温暖', lightQuality: '明亮', atmosphericMood: '舒爽' },
  { start: [10, 8], end: [11, 6], label: '深秋', temperatureFeeling: '清凉', lightQuality: '柔和', atmosphericMood: '萧瑟' },
  { start: [11, 7], end: [12, 6], label: '初冬', temperatureFeeling: '寒冷', lightQuality: '清冽', atmosphericMood: '收敛' },
  { start: [12, 7], end: [1, 19], label: '隆冬', temperatureFeeling: '寒冷', lightQuality: '清冽', atmosphericMood: '沉静' },
  { start: [1, 20], end: [2, 3], label: '冬末', temperatureFeeling: '寒冷', lightQuality: '清冽', atmosphericMood: '等待' },
]

const TROPICAL_SEASONS = [
  {
    label: '热带旱季',
    monthRange: [11, 5],
    temperatureFeeling: '炎热干爽',
    lightQuality: '明亮通透',
    atmosphericMood: '慵懒度假',
    emotionTags: ['自由', '海风', '慵懒', '明媚'],
  },
  {
    label: '热带雨季',
    monthRange: [6, 10],
    temperatureFeeling: '闷热潮湿',
    lightQuality: '漫射柔光',
    atmosphericMood: '午后阵雨',
    emotionTags: ['潮湿', '生机', '绿意', '阵雨感'],
  },
]

const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const EARTHLY_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']
const LUNAR_MONTH_NAMES = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
const LUNAR_DAY_NAMES = [
  '', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

const LUNAR_YEAR_DATA = {
  2023: { start: '2023-01-22', months: [29, 30, 29, 29, 30, 30, 29, 30, 30, 29, 30, 29, 30], monthNumbers: [1, 2, -2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  2024: { start: '2024-02-10', months: [29, 30, 29, 29, 30, 29, 30, 30, 29, 30, 30, 29], monthNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  2025: { start: '2025-01-29', months: [30, 29, 30, 29, 29, 30, 29, 30, 29, 30, 30, 30, 29], monthNumbers: [1, 2, 3, 4, 5, 6, -6, 7, 8, 9, 10, 11, 12] },
  2026: { start: '2026-02-17', months: [30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 30, 29], monthNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  2027: { start: '2027-02-06', months: [30, 30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 29], monthNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  2028: { start: '2028-01-26', months: [30, 30, 30, 29, 30, 29, 29, 30, 29, 29, 30, 30, 29], monthNumbers: [1, 2, 3, 4, 5, -5, 6, 7, 8, 9, 10, 11, 12] },
  2029: { start: '2029-02-13', months: [30, 30, 29, 30, 29, 30, 29, 30, 29, 29, 30, 30], monthNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  2030: { start: '2030-02-03', months: [29, 30, 29, 30, 30, 29, 30, 29, 30, 29, 30, 29], monthNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
}

const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hour12: false,
})

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeAngle(angle) {
  return ((angle % 360) + 360) % 360
}

function normalizeRadians(rad) {
  const full = Math.PI * 2
  return ((rad % full) + full) % full
}

function formatYmdParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function toJulianDay(dateMs) {
  return dateMs / DAY_MS + J1970
}

function fromJulianDay(julianDay) {
  return (julianDay - J1970) * DAY_MS
}

function julianCenturies(julianDay) {
  return (julianDay - J2000) / 36525
}

function solarGeomMeanLongitude(julianDay) {
  const t = julianCenturies(julianDay)
  return normalizeAngle(280.46646 + t * (36000.76983 + 0.0003032 * t))
}

function solarGeomMeanAnomaly(julianDay) {
  const t = julianCenturies(julianDay)
  return 357.52911 + t * (35999.05029 - 0.0001537 * t)
}

function earthOrbitEccentricity(julianDay) {
  const t = julianCenturies(julianDay)
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
}

function solarEquationOfCenter(julianDay) {
  const t = julianCenturies(julianDay)
  const m = solarGeomMeanAnomaly(julianDay) * DEG
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  )
}

function solarTrueLongitude(julianDay) {
  return solarGeomMeanLongitude(julianDay) + solarEquationOfCenter(julianDay)
}

function meanObliquityOfEcliptic(julianDay) {
  const t = julianCenturies(julianDay)
  return 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
}

function apparentObliquity(julianDay) {
  const omega = (125.04 - 1934.136 * julianCenturies(julianDay)) * DEG
  return (meanObliquityOfEcliptic(julianDay) + 0.00256 * Math.cos(omega)) * DEG
}

function solarApparentLongitude(julianDay) {
  const omega = (125.04 - 1934.136 * julianCenturies(julianDay)) * DEG
  return normalizeAngle(solarTrueLongitude(julianDay) - 0.00569 - 0.00478 * Math.sin(omega))
}

function solarDeclination(julianDay) {
  const lambda = solarApparentLongitude(julianDay) * DEG
  const epsilon = apparentObliquity(julianDay)
  return Math.asin(Math.sin(epsilon) * Math.sin(lambda))
}

function equationOfTime(julianDay) {
  const epsilon = apparentObliquity(julianDay)
  const l0 = solarGeomMeanLongitude(julianDay) * DEG
  const e = earthOrbitEccentricity(julianDay)
  const m = solarGeomMeanAnomaly(julianDay) * DEG
  const y = Math.tan(epsilon / 2) ** 2

  const eq = y * Math.sin(2 * l0)
    - 2 * e * Math.sin(m)
    + 4 * e * y * Math.sin(m) * Math.cos(2 * l0)
    - 0.5 * y * y * Math.sin(4 * l0)
    - 1.25 * e * e * Math.sin(2 * m)

  return 4 * eq * RAD
}

function solarHourAngle(lat, lon, julianDay, targetAltitudeDeg) {
  const latRad = lat * DEG
  const dec = solarDeclination(julianDay)
  const alt = targetAltitudeDeg * DEG
  const numerator = Math.sin(alt) - Math.sin(latRad) * Math.sin(dec)
  const denominator = Math.cos(latRad) * Math.cos(dec)

  if (Math.abs(denominator) < 1e-9) return null

  const cosH = numerator / denominator
  if (cosH < -1 || cosH > 1) return null
  return Math.acos(cosH)
}

function sunAltitude(lat, lon, nowMs) {
  const jd = toJulianDay(nowMs)
  const dec = solarDeclination(jd)
  const eqTime = equationOfTime(jd)
  const latRad = lat * DEG
  const utc = new Date(nowMs)
  const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60 + utc.getUTCMilliseconds() / 60000
  const trueSolarMinutes = ((utcMinutes + eqTime + 4 * lon) % 1440 + 1440) % 1440
  const hourAngleDeg = trueSolarMinutes / 4 < 0 ? trueSolarMinutes / 4 + 180 : trueSolarMinutes / 4 - 180
  const hourAngle = hourAngleDeg * DEG
  const altitude = Math.asin(
    Math.sin(latRad) * Math.sin(dec) +
    Math.cos(latRad) * Math.cos(dec) * Math.cos(hourAngle)
  )
  return altitude * RAD
}

function sunAzimuth(lat, lon, nowMs) {
  const jd = toJulianDay(nowMs)
  const dec = solarDeclination(jd)
  const eqTime = equationOfTime(jd)
  const latRad = lat * DEG
  const utc = new Date(nowMs)
  const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60 + utc.getUTCMilliseconds() / 60000
  const trueSolarMinutes = ((utcMinutes + eqTime + 4 * lon) % 1440 + 1440) % 1440
  const hourAngleDeg = trueSolarMinutes / 4 < 0 ? trueSolarMinutes / 4 + 180 : trueSolarMinutes / 4 - 180
  const hourAngle = hourAngleDeg * DEG
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latRad) - Math.tan(dec) * Math.cos(latRad)
  ) * RAD + 180
  return normalizeAngle(azimuth)
}

function shanghaiParts(nowMs) {
  const parts = shanghaiFormatter.formatToParts(new Date(nowMs))
  const out = {}
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'hour' || part.type === 'minute' || part.type === 'second') {
      out[part.type] = Number(part.value)
    }
  }
  return out
}

function shanghaiDateKey(nowMs) {
  const parts = shanghaiParts(nowMs)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function utcMiddayForShanghaiDate(nowMs) {
  const parts = shanghaiParts(nowMs)
  return Date.UTC(parts.year, parts.month - 1, parts.day, 4, 0, 0)
}

function solarTransitJ(ds, m, l) {
  return J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l)
}

function solarMeanAnomalyDays(d) {
  return DEG * (357.5291 + 0.98560028 * d)
}

function eclipticLongitudeFromMeanAnomaly(m) {
  const c = DEG * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m))
  const perihelion = DEG * 102.9372
  return m + c + perihelion + Math.PI
}

function declinationFromEcliptic(l, b = 0) {
  return Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l))
}

function julianCycle(d, lw) {
  return Math.round(d - 0.0009 - lw / (2 * Math.PI))
}

function approxTransit(ht, lw, n) {
  return 0.0009 + (ht + lw) / (2 * Math.PI) + n
}

function getSetJ(targetAlt, lw, phi, dec, n, m, l) {
  const w = Math.acos(
    (Math.sin(targetAlt) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec))
  )
  const a = approxTransit(w, lw, n)
  return solarTransitJ(a, m, l)
}

function computeSolarEvent(lat, lon, dateMs, altitudeDeg) {
  const lw = -lon * DEG
  const phi = lat * DEG
  const d = toJulianDay(dateMs) - J2000
  const n = julianCycle(d, lw)
  const ds = approxTransit(0, lw, n)
  const m = solarMeanAnomalyDays(ds)
  const l = eclipticLongitudeFromMeanAnomaly(m)
  const dec = declinationFromEcliptic(l)
  const jNoon = solarTransitJ(ds, m, l)
  const h = altitudeDeg * DEG
  const cosArg = (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))

  if (cosArg < -1 || cosArg > 1) {
    return { rise: null, set: null, noon: fromJulianDay(jNoon) }
  }

  const jSet = getSetJ(h, lw, phi, dec, n, m, l)
  const jRise = jNoon - (jSet - jNoon)
  return {
    rise: fromJulianDay(jRise),
    set: fromJulianDay(jSet),
    noon: fromJulianDay(jNoon),
  }
}

function solarEvents(lat, lon, dateMs) {
  const standard = computeSolarEvent(lat, lon, dateMs, -0.833)
  return {
    rise: standard.rise ? Math.round(standard.rise) : null,
    set: standard.set ? Math.round(standard.set) : null,
    noon: standard.noon ? Math.round(standard.noon) : null,
    astronomical: computeSolarEvent(lat, lon, dateMs, -18),
    nautical: computeSolarEvent(lat, lon, dateMs, -12),
    civil: computeSolarEvent(lat, lon, dateMs, -6),
    geometric: computeSolarEvent(lat, lon, dateMs, 0),
  }
}

function phaseFromSolarEvents(nowMs, events, altitudeDeg) {
  const rise = events.rise
  const set = events.set
  const astroRise = events.astronomical.rise
  const astroSet = events.astronomical.set
  const nauticalRise = events.nautical.rise
  const nauticalSet = events.nautical.set
  const civilRise = events.civil.rise
  const civilSet = events.civil.set
  const noon = events.noon

  if (!rise || !set || !astroRise || !astroSet || !nauticalRise || !nauticalSet || !civilRise || !civilSet) {
    return altitudeDeg > 0 ? 'afternoon' : 'night'
  }

  if (nowMs < astroRise || nowMs >= astroSet) return 'night'
  if (nowMs < nauticalRise) return 'astronomical_dawn'
  if (nowMs < civilRise) return 'nautical_dawn'
  if (nowMs < rise) return 'civil_dawn'
  if (nowMs < rise + 30 * MINUTE_MS) return 'sunrise'
  if (nowMs < noon - 45 * MINUTE_MS) return 'morning'
  if (Math.abs(nowMs - noon) <= 45 * MINUTE_MS) return 'noon'
  if (nowMs < set) return 'afternoon'
  if (nowMs < civilSet) return 'civil_dusk'
  if (nowMs < nauticalSet) return 'nautical_dusk'
  if (nowMs < astroSet) return 'astronomical_dusk'
  return 'night'
}

function lunarPhase(nowMs) {
  const synodicMonth = 29.53059
  const referenceJd = 2451549.25972
  const days = toJulianDay(nowMs) - referenceJd
  const phaseDays = ((days % synodicMonth) + synodicMonth) % synodicMonth
  return phaseDays / synodicMonth
}

function lunarPhaseName(phase) {
  if (phase < 0.0625 || phase >= 0.9375) return 'new'
  if (phase < 0.1875) return 'waxing_crescent'
  if (phase < 0.3125) return 'first_quarter'
  if (phase < 0.4375) return 'waxing_gibbous'
  if (phase < 0.5625) return 'full'
  if (phase < 0.6875) return 'waning_gibbous'
  if (phase < 0.8125) return 'last_quarter'
  return 'waning_crescent'
}

function lunarIllumination(phase) {
  return (1 - Math.cos(phase * Math.PI * 2)) / 2
}

function siderealTime(jd, lonDeg) {
  const t = (jd - J2000) / 36525
  const theta = 280.46061837 + 360.98564736629 * (jd - J2000) + 0.000387933 * t * t - (t * t * t) / 38710000 + lonDeg
  return normalizeAngle(theta) * DEG
}

function lunarEquatorialPosition(nowMs) {
  const d = toJulianDay(nowMs) - 2451543.5
  const n = normalizeAngle(125.1228 - 0.0529538083 * d) * DEG
  const i = 5.1454 * DEG
  const w = normalizeAngle(318.0634 + 0.1643573223 * d) * DEG
  const a = 60.2666
  const e = 0.0549
  const m = normalizeAngle(115.3654 + 13.0649929509 * d) * DEG
  const eAnomaly = m + e * Math.sin(m) * (1 + e * Math.cos(m))
  const xv = a * (Math.cos(eAnomaly) - e)
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(eAnomaly))
  const v = Math.atan2(yv, xv)
  const r = Math.sqrt(xv * xv + yv * yv)

  const xh = r * (Math.cos(n) * Math.cos(v + w) - Math.sin(n) * Math.sin(v + w) * Math.cos(i))
  const yh = r * (Math.sin(n) * Math.cos(v + w) + Math.cos(n) * Math.sin(v + w) * Math.cos(i))
  const zh = r * Math.sin(v + w) * Math.sin(i)

  const lon = Math.atan2(yh, xh)
  const lat = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh))
  const epsilon = apparentObliquity(toJulianDay(nowMs))
  const ra = Math.atan2(
    Math.sin(lon) * Math.cos(epsilon) - Math.tan(lat) * Math.sin(epsilon),
    Math.cos(lon)
  )
  const dec = Math.asin(
    Math.sin(lat) * Math.cos(epsilon) + Math.cos(lat) * Math.sin(epsilon) * Math.sin(lon)
  )

  return {
    ra: normalizeRadians(ra),
    dec,
  }
}

function lunarAltitude(lat, lon, nowMs) {
  const eq = lunarEquatorialPosition(nowMs)
  const phi = lat * DEG
  const lst = siderealTime(toJulianDay(nowMs), lon)
  const hourAngle = normalizeRadians(lst - eq.ra + Math.PI) - Math.PI
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(eq.dec) +
    Math.cos(phi) * Math.cos(eq.dec) * Math.cos(hourAngle)
  )
  return altitude * RAD
}

function lunarRiseSet(lat, lon, dateMs) {
  const midnight = utcMiddayForShanghaiDate(dateMs) - 12 * 60 * 60 * 1000
  const samples = []
  for (let minute = 0; minute <= 24 * 60; minute += 10) {
    const ts = midnight + minute * MINUTE_MS
    samples.push({ ts, altitude: lunarAltitude(lat, lon, ts) })
  }

  let rise = null
  let set = null

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const curr = samples[i]
    if (prev.altitude <= 0 && curr.altitude > 0 && rise === null) {
      const ratio = prev.altitude === curr.altitude ? 0 : (0 - prev.altitude) / (curr.altitude - prev.altitude)
      rise = Math.round(prev.ts + ratio * (curr.ts - prev.ts))
    }
    if (prev.altitude >= 0 && curr.altitude < 0 && set === null) {
      const ratio = prev.altitude === curr.altitude ? 0 : (0 - prev.altitude) / (curr.altitude - prev.altitude)
      set = Math.round(prev.ts + ratio * (curr.ts - prev.ts))
    }
  }

  return { rise, set }
}

function parseYmd(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number)
  return { year, month, day }
}

function localDateDiff(start, end) {
  const startUtc = Date.UTC(start.year, start.month - 1, start.day)
  const endUtc = Date.UTC(end.year, end.month - 1, end.day)
  return Math.round((endUtc - startUtc) / DAY_MS)
}

function toGanzhiYear(year) {
  const offset = year - 1984
  return `${HEAVENLY_STEMS[((offset % 10) + 10) % 10]}${EARTHLY_BRANCHES[((offset % 12) + 12) % 12]}`
}

function detectCulturalZone(lat, lon) {
  const isEastAsia = lat >= 15 && lat <= 55 && lon >= 95 && lon <= 145
  const isTropical = Math.abs(lat) < 23.5

  let climatePattern = 'temperate_china'
  if (isTropical) climatePattern = 'tropical'
  else if (lat > 30 && lon > 125) climatePattern = 'temperate_japan_korea'

  return {
    useChineseLunarCalendar: isEastAsia,
    useSolarTerms: isEastAsia,
    climatePattern,
    isTropical,
  }
}

function findGregorianDateForLunar(lunarYear, month, day, isLeapMonth = false) {
  const data = LUNAR_YEAR_DATA[lunarYear]
  if (!data) return null

  let offset = 0
  let found = false
  for (let index = 0; index < data.monthNumbers.length; index++) {
    const monthNumber = data.monthNumbers[index]
    if (Math.abs(monthNumber) === month && (monthNumber < 0) === Boolean(isLeapMonth)) {
      offset += day - 1
      found = true
      break
    }
    offset += data.months[index]
  }

  if (!found) return null

  const start = parseYmd(data.start)
  const startUtc = Date.UTC(start.year, start.month - 1, start.day)
  const target = new Date(startUtc + offset * DAY_MS)
  return formatYmdParts(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate())
}

function lunarCalendarForDate(nowMs) {
  const parts = shanghaiParts(nowMs)
  const date = { year: parts.year, month: parts.month, day: parts.day }
  const years = Object.keys(LUNAR_YEAR_DATA).map(Number).sort((a, b) => a - b)
  let matchedYear = null

  for (let index = years.length - 1; index >= 0; index--) {
    const year = years[index]
    const start = parseYmd(LUNAR_YEAR_DATA[year].start)
    if (localDateDiff(start, date) >= 0) {
      matchedYear = year
      break
    }
  }

  if (!matchedYear) {
    matchedYear = years[0]
  }

  const data = LUNAR_YEAR_DATA[matchedYear]
  const start = parseYmd(data.start)
  let remaining = localDateDiff(start, date)
  let monthIndex = 0

  while (monthIndex < data.months.length && remaining >= data.months[monthIndex]) {
    remaining -= data.months[monthIndex]
    monthIndex += 1
  }

  const rawMonth = data.monthNumbers[Math.min(monthIndex, data.monthNumbers.length - 1)]
  const month = Math.abs(rawMonth)
  const day = remaining + 1

  return {
    year: matchedYear,
    month,
    day,
    yearName: toGanzhiYear(matchedYear),
    monthName: LUNAR_MONTH_NAMES[month - 1],
    dayName: LUNAR_DAY_NAMES[day],
    zodiac: ZODIAC[(matchedYear - 4) % 12],
    isLeapMonth: rawMonth < 0,
  }
}

function solarLongitude(nowMs) {
  return solarApparentLongitude(toJulianDay(nowMs))
}

function angleDifference(current, target) {
  let diff = normalizeAngle(current - target)
  if (diff > 180) diff -= 360
  return diff
}

function solarTermDate(year, termIndex) {
  const targetLongitude = normalizeAngle(285 + termIndex * 15)
  const approxMonth = Math.floor(termIndex / 2)
  const approxDay = termIndex % 2 === 0 ? 5 : 20
  let start = Date.UTC(year, approxMonth, approxDay - 4, 0, 0, 0)
  let end = Date.UTC(year, approxMonth, approxDay + 4, 23, 59, 59)
  let prev = angleDifference(solarLongitude(start), targetLongitude)

  for (let ts = start + 6 * 60 * 60 * 1000; ts <= end; ts += 6 * 60 * 60 * 1000) {
    const current = angleDifference(solarLongitude(ts), targetLongitude)
    if (prev === 0 || current === 0 || prev * current <= 0) {
      start = ts - 6 * 60 * 60 * 1000
      end = ts
      for (let i = 0; i < 32; i++) {
        const mid = (start + end) / 2
        const diff = angleDifference(solarLongitude(mid), targetLongitude)
        const startDiff = angleDifference(solarLongitude(start), targetLongitude)
        if (startDiff === 0 || startDiff * diff <= 0) {
          end = mid
        } else {
          start = mid
        }
      }
      return Math.round((start + end) / 2)
    }
    prev = current
  }

  return Date.UTC(year, approxMonth, approxDay, 12, 0, 0)
}

function solarTermContext(nowMs) {
  const parts = shanghaiParts(nowMs)
  const candidates = []

  for (let year = parts.year - 1; year <= parts.year + 1; year++) {
    for (let index = 0; index < SOLAR_TERM_NAMES.length; index++) {
      candidates.push({
        name: SOLAR_TERM_NAMES[index],
        ts: solarTermDate(year, index),
      })
    }
  }

  candidates.sort((a, b) => a.ts - b.ts)
  const todayKey = shanghaiDateKey(nowMs)
  const current = candidates.find(candidate => shanghaiDateKey(candidate.ts) === todayKey) || null
  const lastByTs = candidates.filter(candidate => candidate.ts <= nowMs).pop() || candidates[0]
  const last = current || lastByTs
  const next = candidates.find(candidate => shanghaiDateKey(candidate.ts) > todayKey) || candidates[candidates.length - 1]

  const seasonIndex = SOLAR_TERM_NAMES.indexOf(last.name)
  const season = seasonIndex >= 2 && seasonIndex <= 7
    ? 'spring'
    : seasonIndex >= 8 && seasonIndex <= 13
      ? 'summer'
      : seasonIndex >= 14 && seasonIndex <= 19
        ? 'autumn'
        : 'winter'

  const seasonStarts = { spring: '立春', summer: '立夏', autumn: '立秋', winter: '立冬' }
  const seasonEnds = { spring: '立夏', summer: '立秋', autumn: '立冬', winter: '立春' }
  const seasonStartCandidates = candidates.filter(item => item.name === seasonStarts[season] && item.ts <= nowMs)
  const seasonStart = seasonStartCandidates[seasonStartCandidates.length - 1]?.ts || last.ts
  const seasonEnd = candidates.find(item => item.name === seasonEnds[season] && item.ts > seasonStart)?.ts || next.ts
  const totalSeasonMs = Math.max(seasonEnd - seasonStart, DAY_MS)
  const seasonProgress = clamp((nowMs - seasonStart) / totalSeasonMs, 0, 1)

  return {
    current: current ? current.name : null,
    next: next.name,
    nextTs: next.ts,
    daysSinceLast: current ? 0 : Math.floor((nowMs - last.ts) / DAY_MS),
    daysUntilNext: Math.max(0, Math.ceil((next.ts - nowMs) / DAY_MS)),
    season,
    seasonProgress,
  }
}

function inMonthDayRange(month, day, start, end) {
  const value = month * 100 + day
  const startValue = start[0] * 100 + start[1]
  const endValue = end[0] * 100 + end[1]
  if (startValue <= endValue) return value >= startValue && value <= endValue
  return value >= startValue || value <= endValue
}

function isMonthWithinWrappedRange(month, start, end) {
  if (start <= end) return month >= start && month <= end
  return month >= start || month <= end
}

function resolveSeasonalQuality(month, day, zone) {
  if (zone.climatePattern === 'tropical') {
    const season = TROPICAL_SEASONS.find(item => isMonthWithinWrappedRange(month, item.monthRange[0], item.monthRange[1]))
      || TROPICAL_SEASONS[0]
    return {
      label: season.label,
      temperatureFeeling: season.temperatureFeeling,
      lightQuality: season.lightQuality,
      atmosphericMood: season.atmosphericMood,
    }
  }

  const window = SEASONAL_QUALITY_WINDOWS.find(item => inMonthDayRange(month, day, item.start, item.end))
    || SEASONAL_QUALITY_WINDOWS[SEASONAL_QUALITY_WINDOWS.length - 1]

  return {
    label: window.label,
    temperatureFeeling: window.temperatureFeeling,
    lightQuality: window.lightQuality,
    atmosphericMood: window.atmosphericMood,
  }
}

function shouldIncludeCulturalEvent(event, zone) {
  if (event.type === 'personal') return true
  if (event.type === 'gregorian_festival') return true
  if (event.type === 'lunar_festival') return zone.useChineseLunarCalendar
  if (event.type === 'solar_term' || event.type === 'solar_term_relative') return zone.useSolarTerms
  if (event.type === 'social_season' || event.type === 'climate') {
    const climatePatterns = event.climatePatterns || ['temperate_china']
    return climatePatterns.includes(zone.climatePattern)
  }
  return false
}

function resolveFestivalForToday(event, nowMs, lunarCalendar, solarTerm, zone) {
  if (!shouldIncludeCulturalEvent(event, zone)) return null
  const parts = shanghaiParts(nowMs)
  const today = formatYmdParts(parts.year, parts.month, parts.day)
  let matches = false
  let resolvedGregorianDate = today

  if (event.lunar) {
    matches = lunarCalendar.month === event.lunar[0] && lunarCalendar.day === event.lunar[1] && !lunarCalendar.isLeapMonth
    resolvedGregorianDate = findGregorianDateForLunar(lunarCalendar.year, event.lunar[0], event.lunar[1], false) || today
  } else if (event.term) {
    matches = solarTerm.current === event.term
  } else if (event.offsetFromTerm) {
    const termIndex = SOLAR_TERM_NAMES.indexOf(event.offsetFromTerm.term)
    if (termIndex !== -1) {
      const termTs = solarTermDate(parts.year, termIndex)
      const targetTs = termTs + event.offsetFromTerm.days * DAY_MS
      resolvedGregorianDate = shanghaiDateKey(targetTs)
      matches = resolvedGregorianDate === today
    }
  } else if (event.date) {
    matches = parts.month === event.date[0] && parts.day === event.date[1]
  } else if (event.dateRange) {
    matches = inMonthDayRange(parts.month, parts.day, event.dateRange[0], event.dateRange[1])
  }

  if (!matches) return null

  return {
    name: event.name,
    type: event.type,
    emotionTags: event.emotionTags,
    canvasHint: event.canvasHint || null,
    promptHint: event.promptHint || null,
    resolvedGregorianDate,
  }
}

function culturalContext(nowMs, lunarCalendar, solarTerm, zone) {
  const festivals = CULTURAL_EVENTS
    .map(event => resolveFestivalForToday(event, nowMs, lunarCalendar, solarTerm, zone))
    .filter(Boolean)

  return {
    festivals,
    primaryMood: festivals[0]?.emotionTags?.[0] || null,
  }
}

function starsContext(nowMs, solarAltitudeDeg, lunarIlluminationValue, lat) {
  const darknessFactor = solarAltitudeDeg >= -6
    ? 0
    : solarAltitudeDeg <= -18
      ? 1
      : (-6 - solarAltitudeDeg) / 12
  const moonPenalty = 1 - lunarIlluminationValue * 0.65
  const visibility = clamp(darknessFactor * moonPenalty, 0, 1)
  const month = shanghaiParts(nowMs).month
  const milkyWaySeason = month >= 3 && month <= 10 && lat >= 0
  const seasonProgress = clamp((month - 3) / 7, 0, 1)

  return {
    visibility,
    milkyWayVisible: visibility > 0.6 && milkyWaySeason,
    milkyWayAzimuth: normalizeAngle(140 + seasonProgress * 80),
  }
}

async function getAstronomyContext(lat, lon, nowMs = Date.now()) {
  const zone = detectCulturalZone(lat, lon)
  const parts = shanghaiParts(nowMs)
  const midday = utcMiddayForShanghaiDate(nowMs)
  const solarAltitudeDeg = sunAltitude(lat, lon, nowMs)
  const solarAzimuthDeg = sunAzimuth(lat, lon, nowMs)
  const solarData = solarEvents(lat, lon, midday)
  const solarPhase = phaseFromSolarEvents(nowMs, solarData, solarAltitudeDeg)
  const daylightMinutes = solarData.rise && solarData.set
    ? Math.round((solarData.set - solarData.rise) / MINUTE_MS)
    : 0

  const moonPhase = lunarPhase(nowMs)
  const moonAltitude = lunarAltitude(lat, lon, nowMs)
  const moonRiseSet = lunarRiseSet(lat, lon, nowMs)
  const moonIllumination = lunarIllumination(moonPhase)
  const lunarCalendar = lunarCalendarForDate(nowMs)
  const solarTerm = solarTermContext(nowMs)
  const cultural = culturalContext(nowMs, lunarCalendar, solarTerm, zone)
  const seasonalQuality = resolveSeasonalQuality(parts.month, parts.day, zone)
  const stars = starsContext(nowMs, solarAltitudeDeg, moonIllumination, lat)
  const birthdayThisYear = {
    user: {
      lunarDate: '二月初九',
      gregorianDate: findGregorianDateForLunar(parts.year, 2, 9, false),
    },
    mother: {
      lunarDate: '二月廿六',
      gregorianDate: findGregorianDateForLunar(parts.year, 2, 26, false),
    },
  }

  return {
    solar: {
      altitude: Number(solarAltitudeDeg.toFixed(3)),
      azimuth: Number(solarAzimuthDeg.toFixed(3)),
      phase: solarPhase,
      riseTs: solarData.rise,
      setTs: solarData.set,
      noonTs: solarData.noon,
      daylightMinutes,
      isShortDay: daylightMinutes < 600,
    },
    lunar: {
      phase: Number(moonPhase.toFixed(4)),
      phaseName: lunarPhaseName(moonPhase),
      illumination: Number(moonIllumination.toFixed(4)),
      altitude: Number(moonAltitude.toFixed(3)),
      isVisible: moonAltitude > 0 && solarPhase === 'night',
      riseTs: moonRiseSet.rise,
      setTs: moonRiseSet.set,
    },
    stars: {
      visibility: Number(stars.visibility.toFixed(4)),
      milkyWayVisible: stars.milkyWayVisible,
      milkyWayAzimuth: Number(stars.milkyWayAzimuth.toFixed(3)),
    },
    lunarCalendar,
    solarTerm,
    cultural,
    seasonalQuality,
    culturalZone: zone,
    activeFestivalsToday: cultural.festivals,
    canvasHintActive: cultural.festivals.find(item => item.canvasHint)?.canvasHint || null,
    birthdayThisYear,
  }
}

module.exports = {
  getAstronomyContext,
  detectCulturalZone,
  findGregorianDateForLunar,
}
