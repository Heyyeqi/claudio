# CLAUDE.md — RodiO 个人 AI 电台

你是这个项目的架构师和执行者。请完整读完这份文档再开始任何操作。

---

## 项目定位

RodiO 是一个运行在本地的个人 AI 电台。它读懂用户的音乐品味，像 DJ 一样播报，
用语音衔接每首歌，天气和时间会影响选曲逻辑。

**技术栈：** Node.js + Express · SQLite · PWA · Fish Audio TTS · 网易云音乐 API · Claude API

---

## 目录结构（请按此创建）

```
claudio/
├── CLAUDE.md                  ← 本文件
├── .env                       ← 所有 API Key（不提交 git）
├── .gitignore
├── package.json
├── server.js                  ← Express 主入口
│
├── core/
│   ├── router.js              ← 意图分流（音乐指令 / 自然语言 / 系统指令）
│   ├── context.js             ← 拼装 6 片 prompt 上下文
│   ├── claude.js              ← 调用 Claude API，解析 {say, play[], reason, segue}
│   ├── tts.js                 ← Fish Audio TTS，输出 mp3 到 cache/tts/
│   ├── scheduler.js           ← 定时任务（07:00 晨间播报，整点情绪检查）
│   └── state.js               ← SQLite 读写（messages, plays, prefs）
│
├── prompts/
│   ├── dj-persona.md          ← DJ 人格设定（系统提示词）
│   └── mood-rules.md          ← 选曲逻辑规则
│
├── user/
│   ├── taste.md               ← 用户音乐品味描述（手动填写）
│   ├── routines.md            ← 用户日常规律（手动填写）
│   └── playlists.json         ← 用户歌单种子数据
│
├── cache/
│   └── tts/                   ← TTS 生成的 mp3 文件
│
├── db/
│   └── state.db               ← SQLite 数据库（自动创建）
│
└── pwa/
    ├── index.html             ← 播放器主界面
    ├── app.js                 ← 前端逻辑
    ├── style.css              ← 样式
    └── sw.js                  ← Service Worker（PWA 缓存）
```

---

## 环境变量（.env 模板）

```env
# Claude
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx

# 网易云音乐 API（本地部署后的地址）
NCM_API_BASE=http://localhost:3000

# Fish Audio
FISH_API_KEY=xxxxxxxx
FISH_VOICE_ID=xxxxxxxx

# OpenWeather
WEATHER_API_KEY=xxxxxxxx
WEATHER_CITY=Shanghai

# 服务端口
PORT=8080
```

---

## 第零步：部署网易云音乐 API

在 claudio 项目**同级目录**执行：

```bash
git clone https://github.com/Binaryify/NeteaseCloudMusicApi.git
cd NeteaseCloudMusicApi
npm install
node app.js
# 默认跑在 http://localhost:3000
```

保持这个服务在后台运行，claudio 会通过 HTTP 调用它。

---

## 第一步：初始化项目

```bash
mkdir claudio && cd claudio
npm init -y
npm install express axios better-sqlite3 node-cron dotenv node-fetch
```

在根目录创建 `.gitignore`：
```
.env
cache/
db/
node_modules/
```

---

## 第二步：核心模块实现顺序

**请按以下顺序实现，每完成一个模块后验证再继续：**

### 2.1 state.js — 状态与记忆

使用 better-sqlite3 创建 SQLite 数据库，包含三张表：

```sql
-- 对话历史
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT,           -- 'user' | 'assistant'
  content TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 播放记录
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT,
  song_name TEXT,
  artist TEXT,
  played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  mood TEXT           -- 播放时的情绪标签
);

-- 用户偏好（KV 结构）
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

导出方法：`getRecentMessages(n)` / `addMessage(role, content)` / `addPlay(song)` / `getPref(key)` / `setPref(key, value)`

---

### 2.2 context.js — 六片拼装

每次请求时，动态拼装 system prompt，由六个片段组成：

```
① prompts/dj-persona.md          ← 静态，直接读文件
② user/taste.md + routines.md    ← 静态，直接读文件  
③ 环境注入                        ← 动态：当前时间 + 天气（调 OpenWeather）
④ 已检索记忆                      ← 动态：state.getRecentMessages(10) + 近期 plays
⑤ 用户输入 / 工具结果             ← 本次请求传入
⑥ 执行轨迹                        ← scheduler 状态（今天播了多少首，当前计划）
```

导出方法：`buildContext(userInput)` → 返回 `{ system, messages[] }`

OpenWeather 调用示例：
```javascript
const url = `https://api.openweathermap.org/data/2.5/weather?q=${WEATHER_CITY}&appid=${WEATHER_API_KEY}&units=metric&lang=zh_cn`
```

---

### 2.3 claude.js — 大脑适配器

调用 Claude API（使用 `claude-sonnet-4-20250514` 模型），**强制要求 Claude 只输出 JSON**：

system prompt 末尾追加：
```
你必须且只能输出一个合法 JSON 对象，不含任何 markdown 包裹，格式如下：
{
  "say": "播报文案（将被转为语音）",
  "play": [{"id": "歌曲NCM ID", "name": "歌名", "artist": "艺人"}],
  "reason": "内部选曲逻辑说明（不播报）",
  "segue": "衔接下一首时说的话"
}
如果用户只是闲聊，play 数组可为空。
```

导出方法：`askClaude(context)` → 返回解析后的 `{ say, play[], reason, segue }`

---

### 2.4 tts.js — 声音管线

调用 Fish Audio API 将文本转语音，缓存到 `cache/tts/<hash>.mp3`：

```javascript
// Fish Audio WebSocket TTS 端点
// 文档: https://docs.fish.audio/api-reference/tts
// 建议先用 REST /v1/tts 接口（更简单）

async function synthesize(text) {
  const hash = md5(text)  // 用 crypto 模块
  const cachePath = `cache/tts/${hash}.mp3`
  if (fs.existsSync(cachePath)) return cachePath  // 命中缓存直接返回
  
  // 调用 Fish Audio API
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FISH_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      reference_id: FISH_VOICE_ID,
      format: 'mp3'
    })
  })
  
  const buffer = await response.arrayBuffer()
  fs.writeFileSync(cachePath, Buffer.from(buffer))
  return cachePath
}
```

导出方法：`synthesize(text)` → 返回 mp3 文件路径

---

### 2.5 router.js — 意图分流

判断用户输入类型，决定走哪条路：

```javascript
function route(input) {
  // 纯音乐指令 → 直接查 NCM，跳过 Claude
  if (/^(播放|放一首|来一首|播|放)/.test(input)) return 'music_direct'
  
  // 系统指令
  if (/^(停止|暂停|下一首|音量)/.test(input)) return 'system'
  
  // 其他 → 走 Claude
  return 'claude'
}
```

---

### 2.6 server.js — Express 主入口

实现以下 6 个端点：

```
POST /api/chat          ← 主交互入口，接收用户输入，返回 {say, play[], segue}
GET  /api/now           ← 当前播放状态
GET  /api/next          ← 获取下一首推荐
GET  /api/taste         ← 返回用户品味文件内容
GET  /api/plan/today    ← 今日播放计划
WS   /stream            ← WebSocket，推送 now-playing 事件
```

`POST /api/chat` 的完整流程：
1. `router.route(input)` 判断意图
2. `context.buildContext(input)` 拼装上下文
3. `claude.askClaude(context)` 获取 JSON 响应
4. 如果 `play[]` 不为空，调 NCM API 获取歌曲直链
5. `tts.synthesize(say)` 生成语音
6. `state.addMessage()` 存历史
7. 返回 `{ say_audio: '/cache/tts/xxx.mp3', play_url, song_info, segue }`

NCM API 获取直链：
```
GET http://localhost:3000/song/url/v1?id={song_id}&level=standard
```

---

### 2.7 scheduler.js — 节律调度

```javascript
// 07:00 晨间播报
cron.schedule('0 7 * * *', async () => {
  const ctx = await context.buildContext('早安，今天适合听什么？')
  const result = await claude.askClaude(ctx)
  // 推送到 WebSocket clients
})

// 整点情绪检查（9:00 - 22:00）
cron.schedule('0 9-22 * * *', async () => {
  // 根据时间段和天气，触发一次轻量推荐
})
```

---

## 第三步：PWA 前端

`pwa/index.html` 实现三个视图（单页切换）：

### Player 视图（主视图）
- 专辑封面（从 NCM 获取）
- 歌名 + 艺人
- `<audio>` 标签，src 指向 NCM 直链
- 进度条
- TTS 播报文案显示区（DJ 说话时出现，播完消失）
- 底部输入框：发消息给 DJ

### Profile 视图
- 展示 `taste.md` 内容
- 近期播放记录（从 `/api/now` 拉取历史）

### Settings 视图
- Fish Audio Voice ID 设置
- 天气城市设置
- 晨间播报开关

**Service Worker（sw.js）：**
- 缓存 pwa/ 下所有静态文件
- 对 `/cache/tts/` 的请求做 cache-first 策略

---

## 第四步：用户配置文件（需 RW 手动填写）

### user/taste.md
```markdown
# 我的音乐品味

## 常听艺人
孙盛希、孙燕姿、王菲、张学友、方大同、林俊杰、陶喆、周杰伦（早期）、Billie Eilish

## 偏好风格
R&B、慢摇、带质感的流行、举重若轻的编曲
排斥：歇斯底里的嘶吼、过度电子、无聊的口水歌

## 情绪偏好
早晨 → 清醒克制、轻柔
工作时 → 有节奏感但不分心
深夜 → 治愈或带点忧郁
```

### user/routines.md
```markdown
# 我的日常规律

工作日在上海，从事数据资产工作
通常 9:00 开始工作，19:00 后放松
周末有时旅行，偶尔深夜听歌
```

### prompts/dj-persona.md
```markdown
# DJ 人格设定

你是 RodiO，一个有品味、克制、不废话的私人 DJ。

你了解听众十几年的歌单，知道他什么时候需要什么歌。
你说话简洁，有温度，偶尔一句话让人心里一动。
你不会说"好的！"或"当然！"，你只说有价值的话。

播报风格参考：深夜电台主播，像朋友，不像助手。
语言：中文为主，偶尔一句英文歌名或艺人名是自然的。
```

---

## 验证清单

完成每个模块后，按顺序验证：

- [ ] `node server.js` 能正常启动，无报错
- [ ] `curl http://localhost:8080/api/taste` 返回品味文件内容
- [ ] `curl -X POST http://localhost:8080/api/chat -d '{"input":"来一首晚上适合听的歌"}' -H 'Content-Type: application/json'` 返回 JSON 含 say 和 play
- [ ] `say_audio` 的 mp3 文件可以正常播放
- [ ] 浏览器打开 `http://localhost:8080` 出现播放器界面
- [ ] 点击播放，音乐和 TTS 语音都能正常响起

---

## 注意事项

1. NCM API 是非官方服务，仅供个人使用
2. Fish Audio 的 Voice ID 在 fish.audio 注册后，可以在控制台找到或创建声音
3. TTS 缓存是必要的，同样的文案不要重复生成
4. Claude 调用要做 JSON 解析的 try/catch，模型偶尔会输出格式错误
5. WebSocket 部分用 `ws` 库实现：`npm install ws`

---

## 启动命令

```bash
# 终端 1：网易云 API
cd ../NeteaseCloudMusicApi && node app.js

# 终端 2：RodiO 主服务
cd claudio && node server.js

# 浏览器
open http://localhost:8080
```
