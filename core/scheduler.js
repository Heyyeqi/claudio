const cron = require('node-cron')
const context = require('./context')
const claude = require('./claude')

let wsClients = []
let todayCount = 0
let resolveQueueFn = null

function setWsClients(clients) {
  wsClients = clients
}

function setResolveQueue(fn) {
  resolveQueueFn = fn
}

function broadcast(data) {
  const msg = JSON.stringify(data)
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg)
  })
}

function getTodayCount() { return todayCount }
function incrementCount() { todayCount++ }

// 07:00 晨间播报
cron.schedule('0 7 * * *', async () => {
  try {
    const ctx = await context.buildContext('早安，今天适合听什么？')
    const result = await claude.askClaude(ctx)
    broadcast({ type: 'morning', ...result })
    incrementCount()
  } catch (e) {
    console.error('[scheduler] 晨间播报失败:', e.message)
  }
})

// 整点情绪检查（9:00 - 22:00）
cron.schedule('0 9-22 * * *', async () => {
  const h = new Date().getHours()
  const prompts = {
    9: '开始工作了，来一首有节奏感的',
    12: '午休时间，轻松一点',
    15: '下午了，给点能量',
    18: '下班了，放松一下',
    21: '深夜模式，治愈系',
  }
  const input = prompts[h] || '现在适合听什么'
  try {
    const ctx = await context.buildContext(input)
    const result = await claude.askClaude(ctx)
    let queue = []
    if (resolveQueueFn && Array.isArray(result.play) && result.play.length > 0) {
      queue = await resolveQueueFn(result.play)
    }
    broadcast({ type: 'scheduled', hour: h, ...result, queue })
    incrementCount()
  } catch (e) {
    console.error('[scheduler] 整点检查失败:', e.message)
  }
})

module.exports = { setWsClients, setResolveQueue, broadcast, getTodayCount, incrementCount }
