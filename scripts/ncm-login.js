/**
 * 网易云音乐扫码登录
 * 运行：node scripts/ncm-login.js
 * 完成后将 Cookie 保存到 user/ncm-cookie.json
 */

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode-terminal')

const NCM_BASE = process.env.NCM_API_BASE || 'http://localhost:3000'
const COOKIE_PATH = path.join(__dirname, '../user/ncm-cookie.json')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getQrKey() {
  const res = await fetch(`${NCM_BASE}/login/qr/key?timestamp=${Date.now()}`)
  const data = await res.json()
  return data.data.unikey
}

async function getQrUrl(key) {
  const res = await fetch(`${NCM_BASE}/login/qr/create?key=${key}&qrimg=true&timestamp=${Date.now()}`)
  const data = await res.json()
  return { url: data.data.qrurl, img: data.data.qrimg }
}

async function checkQr(key) {
  const res = await fetch(`${NCM_BASE}/login/qr/check?key=${key}&timestamp=${Date.now()}`)
  const data = await res.json()
  // code: 800=二维码过期, 801=等待扫码, 802=已扫码待确认, 803=登录成功
  return { code: data.code, message: data.message, cookie: data.cookie }
}

async function main() {
  console.log('\n[ncm-login] 正在获取二维码...\n')

  const key = await getQrKey()
  const { url } = await getQrUrl(key)

  console.log('请用网易云音乐 App 扫描以下二维码：\n')
  qrcode.generate(url, { small: true })
  console.log('\n（二维码链接：' + url + '）\n')

  // 轮询扫码状态，最多等 3 分钟
  const deadline = Date.now() + 3 * 60 * 1000
  let lastCode = null

  while (Date.now() < deadline) {
    await sleep(2000)
    const { code, message, cookie } = await checkQr(key)

    if (code !== lastCode) {
      const labels = { 800: '二维码已过期', 801: '等待扫码...', 802: '已扫码，请在 App 确认登录', 803: '登录成功！' }
      console.log(labels[code] || `状态 ${code}: ${message}`)
      lastCode = code
    }

    if (code === 803) {
      // 解析 cookie 字符串为对象
      const cookieObj = {}
      cookie.split(';').forEach(pair => {
        const [k, v] = pair.trim().split('=')
        if (k) cookieObj[k.trim()] = (v || '').trim()
      })

      fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true })
      fs.writeFileSync(COOKIE_PATH, JSON.stringify({ raw: cookie, parsed: cookieObj, saved_at: new Date().toISOString() }, null, 2))
      console.log(`\nCookie 已保存到 user/ncm-cookie.json`)
      console.log('现在可以启动 RodiO：node server.js\n')
      process.exit(0)
    }

    if (code === 800) {
      console.log('二维码已过期，请重新运行脚本。')
      process.exit(1)
    }
  }

  console.log('超时未扫码，请重新运行脚本。')
  process.exit(1)
}

main().catch(e => {
  console.error('[ncm-login] 错误:', e.message)
  process.exit(1)
})
