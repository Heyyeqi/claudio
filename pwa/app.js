// ── 视图切换 ─────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active')
    if (btn.dataset.view === 'profile') loadProfile()
  })
})

// ── 播放队列（前端镜像）──────────────────────
let localQueue = []   // [{song_info, play_url}, ...]
let currentSong = null

function renderQueue() {
  const wrap = document.getElementById('queue-wrap')
  const list = document.getElementById('queue-list')
  const count = document.getElementById('queue-count')
  if (localQueue.length === 0) {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden')
  count.textContent = `${localQueue.length} 首`
  list.innerHTML = localQueue.map((item, i) =>
    `<li>
      <span class="q-idx">${i + 1}</span>
      <span class="q-name">${item.song_info.name}</span>
      <span class="q-artist">${item.song_info.artist}</span>
    </li>`
  ).join('')
}

function playSong(item) {
  if (!item?.play_url) return
  currentSong = item.song_info
  audio.src = item.play_url
  audio.play().catch(() => {})
  document.getElementById('song-name').textContent = item.song_info.name
  document.getElementById('song-artist').textContent = item.song_info.artist
}

// ── Audio ────────────────────────────────────
const audio = document.getElementById('audio-player')
const progressFill = document.getElementById('progress-fill')
const timeCur = document.getElementById('time-cur')
const timeTotal = document.getElementById('time-total')

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return
  progressFill.style.width = (audio.currentTime / audio.duration * 100) + '%'
  timeCur.textContent = fmt(audio.currentTime)
  timeTotal.textContent = fmt(audio.duration)
})

// 当前歌曲结束，自动播下一首
audio.addEventListener('ended', async () => {
  if (localQueue.length > 0) {
    // 先消耗本地队列
    const next = localQueue.shift()
    renderQueue()
    playSong(next)
  } else {
    // 队列空了，问服务端（服务端也有镜像）
    try {
      const res = await fetch('/api/next')
      const data = await res.json()
      if (data.play_url) playSong(data)
      // 队列空时也可以不处理，让 DJ 闲置
    } catch {}
  }
})

function fmt(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}

document.getElementById('progress-bar').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect()
  audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration
})

// ── DJ Say ───────────────────────────────────
const djSay = document.getElementById('dj-say')
let sayTimeout = null

function showSay(text) {
  djSay.textContent = text
  djSay.classList.remove('hidden')
  clearTimeout(sayTimeout)
  sayTimeout = setTimeout(() => djSay.classList.add('hidden'), 12000)
}

// ── TTS ──────────────────────────────────────
let ttsAudio = null

function playTts(url) {
  if (!url) return
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null }
  ttsAudio = new Audio(url)
  // TTS 播完后再开音乐
  ttsAudio.addEventListener('ended', () => {
    if (localQueue.length > 0) {
      const first = localQueue.shift()
      renderQueue()
      playSong(first)
    }
  })
  ttsAudio.play().catch(() => {
    // 自动播放被拦截，直接播音乐
    if (localQueue.length > 0) {
      const first = localQueue.shift()
      renderQueue()
      playSong(first)
    }
  })
}

// ── Chat ─────────────────────────────────────
const chatInput = document.getElementById('chat-input')
const chatSend = document.getElementById('chat-send')

async function sendChat() {
  const input = chatInput.value.trim()
  if (!input) return
  chatInput.value = ''
  chatSend.disabled = true
  chatSend.textContent = '...'

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })
    const data = await res.json()

    if (data.queue && data.queue.length > 0) {
      localQueue = data.queue  // 替换队列
      renderQueue()

      // 先展示 DJ 播报，TTS 播完后自动开第一首
      if (data.say) showSay(data.say)
      if (data.say_audio) {
        playTts(data.say_audio)
      } else {
        // 没有 TTS 直接播
        const first = localQueue.shift()
        renderQueue()
        playSong(first)
      }
    } else if (data.say) {
      showSay(data.say)
    }
  } catch (e) {
    showSay('出了点问题，稍后再试')
  } finally {
    chatSend.disabled = false
    chatSend.textContent = '发送'
  }
}

chatSend.addEventListener('click', sendChat)
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat() })

// ── WebSocket ─────────────────────────────────
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/stream`)
  ws.onmessage = e => {
    try {
      const data = JSON.parse(e.data)
      if (data.type === 'now-playing' && data.song_info && data.play_url) {
        playSong(data)
      }
      if (data.say) showSay(data.say)
    } catch {}
  }
  ws.onclose = () => setTimeout(connectWs, 3000)
}
connectWs()

// ── Profile ───────────────────────────────────
async function loadProfile() {
  try {
    const [taste, plan] = await Promise.all([
      fetch('/api/taste').then(r => r.text()),
      fetch('/api/plan/today').then(r => r.json()),
    ])
    document.getElementById('taste-content').textContent = taste
    const ul = document.getElementById('recent-plays')
    ul.innerHTML = (plan.recent_plays || []).map(p =>
      `<li>${p.song_name}<span>${p.artist}</span></li>`
    ).join('') || '<li style="color:#666">暂无记录</li>'
  } catch {}
}

// ── Settings ──────────────────────────────────
document.getElementById('settings-save').addEventListener('click', () => {
  const voiceId = document.getElementById('set-voice-id').value.trim()
  const city = document.getElementById('set-city').value.trim()
  if (voiceId) localStorage.setItem('voice_id', voiceId)
  if (city) localStorage.setItem('city', city)
  alert('已保存（重启服务后生效）')
})

// ── Service Worker ────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}
