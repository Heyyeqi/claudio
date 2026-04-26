const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CACHE_DIR = path.join(__dirname, '../cache/tts')
const MINIMAX_URL = 'https://api.minimax.chat/v1/t2a_v2'

function normalizeTtsText(text) {
  const cleaned = String(text || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, '，')
    .replace(/[“”"]/g, '')
    .replace(/[‘’']/g, '')
    .replace(/……/g, '，')
    .replace(/—+/g, '，')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return ''
  return /[。！？.!?]$/.test(cleaned) ? cleaned : `${cleaned}。`
}

async function synthesizeWithOptions(text, options = {}) {
  const { speed = 0.96, suffix = '' } = options
  const normalizedText = normalizeTtsText(text)
  const hash = crypto.createHash('md5').update(normalizedText).digest('hex')
  const filename = `${hash}${suffix}.mp3`
  const cachePath = path.join(CACHE_DIR, filename)

  if (fs.existsSync(cachePath)) return `/cache/tts/${filename}`

  const apiKey = process.env.MINIMAX_API_KEY
  if (!apiKey) throw new Error('MINIMAX_API_KEY 未配置')

  fs.mkdirSync(CACHE_DIR, { recursive: true })

  const requestBody = {
    model: 'speech-01-turbo',
    text: normalizedText,
    stream: false,
    voice_setting: {
      voice_id: 'male-qn-jingying',
      speed,
      vol: 0.92,
      pitch: 0,
    },
    audio_setting: {
      audio_sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
    },
  }

  console.log('[minimax-tts] request body:', JSON.stringify(requestBody))

  const response = await fetch(MINIMAX_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  })

  console.log('[minimax-tts] response status:', response.status)

  const rawText = await response.text()
  console.log('[minimax-tts] response preview:', rawText.slice(0, 500))

  const payload = rawText ? JSON.parse(rawText) : {}
  if (!response.ok) {
    throw new Error(payload?.base_resp?.status_msg || payload?.message || `MiniMax TTS 请求失败: ${response.status}`)
  }

  const base64Audio = payload?.data?.audio
  if (!base64Audio) {
    throw new Error('MiniMax TTS 未返回音频数据')
  }

  const isHexAudio = typeof base64Audio === 'string' && /^[0-9a-f]+$/i.test(base64Audio) && base64Audio.length % 2 === 0
  const audioBuffer = isHexAudio
    ? Buffer.from(base64Audio, 'hex')
    : Buffer.from(base64Audio, 'base64')

  fs.writeFileSync(cachePath, audioBuffer)

  return `/cache/tts/${filename}`
}

async function synthesize(text) {
  return synthesizeWithOptions(text)
}

async function synthesizeSlow(text) {
  return synthesizeWithOptions(text, { speed: 0.84, suffix: '_slow' })
}

module.exports = { synthesize, synthesizeSlow }
