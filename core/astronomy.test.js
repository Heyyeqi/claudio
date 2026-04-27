const test = require('node:test')
const assert = require('node:assert/strict')

const { getAstronomyContext } = require('./astronomy')

const SHANGHAI = { lat: 31.2304, lon: 121.4737 }

test('solar altitude at summer solar noon is above the horizon in Shanghai', async () => {
  const ctx = await getAstronomyContext(
    SHANGHAI.lat,
    SHANGHAI.lon,
    new Date('2026-06-21T12:00:00+08:00').getTime()
  )

  assert.ok(ctx.solar.altitude > 0)
})

test('lunar phase around the 2026-04-17 Shanghai new moon is near 0', async () => {
  const ctx = await getAstronomyContext(
    SHANGHAI.lat,
    SHANGHAI.lon,
    new Date('2026-04-17T12:00:00+08:00').getTime()
  )

  assert.ok(ctx.lunar.phase < 0.05 || ctx.lunar.phase > 0.95)
  assert.equal(ctx.lunar.phaseName, 'new')
})

test('2026-04-20 falls on 谷雨', async () => {
  const ctx = await getAstronomyContext(
    SHANGHAI.lat,
    SHANGHAI.lon,
    new Date('2026-04-20T12:00:00+08:00').getTime()
  )

  assert.equal(ctx.solarTerm.current, '谷雨')
})

test('2026-04-27 maps to lunar month 3 day 11 in Shanghai', async () => {
  const ctx = await getAstronomyContext(
    SHANGHAI.lat,
    SHANGHAI.lon,
    new Date('2026-04-27T12:00:00+08:00').getTime()
  )

  assert.equal(ctx.lunarCalendar.month, 3)
  assert.equal(ctx.lunarCalendar.day, 11)
  assert.equal(ctx.lunarCalendar.dayName, '十一')
})

test('lunar 8/15 includes 中秋节 in cultural festivals', async () => {
  const ctx = await getAstronomyContext(
    SHANGHAI.lat,
    SHANGHAI.lon,
    new Date('2026-09-25T21:00:00+08:00').getTime()
  )

  assert.ok(ctx.cultural.festivals.some(festival => festival.name === '中秋节'))
  assert.equal(ctx.cultural.primaryMood, '团圆')
})
