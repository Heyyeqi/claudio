# RodiO FM — 项目状态文档

> 记录于 2026-04-26。方便在新环境继续开发。

---

## 一、项目概述

RodiO 是一个运行在本地的个人 AI 电台。核心体验：用自然语言告诉 AI DJ 你想听什么或什么都不说，它根据你的真实歌单、当前时间、天气自动选曲，用语音播报每批歌的氛围，然后一首接一首连续播放。

**技术栈：** Node.js (v24) · Express · SQLite · React 18 · msedge-tts · 通义千问 qwen-max · 网易云音乐 API (非官方本地部署)

---

## 二、已完成功能

### 核心链路（全部可用）

- [x] **AI 选曲**：用户发消息 → qwen-max 从真实歌单中选 3-5 首 → 返回 `{say, play[], reason, segue}`
- [x] **歌曲直链解析**：按歌名+艺人名搜索 NCM，三级匹配（精确/包含/仅歌名），无匹配则跳过，不盲目兜底
- [x] **完整音频播放**：NCM Cookie 以查询参数传入本地 API，返回完整无试听限制的直链（已修复 Cookie 注入方式）
- [x] **TTS 语音播报**：msedge-tts `zh-CN-YunxiNeural`，MD5 缓存，避免重复生成
- [x] **播放队列**：前端维护 `localQueue`，TTS 播完自动接第一首歌，歌曲结束后顺序播放队列
- [x] **播放记录去重**：服务端按 `song_name::artist` 去重，同一首歌不写入两次；prompt 注入近 20 首禁止重推
- [x] **真实歌单曲库**：从 3 个文件加载 4710 首用户真实歌曲，每次请求随机采样 40 首注入 prompt
- [x] **WebSocket 实时推送**：`/stream`，服务端主动推 `now-playing`、DJ 播报文案
- [x] **定时任务**：07:00 晨间播报，09:00–22:00 整点情绪检查（通过 WebSocket 推送给前端）
- [x] **天气注入**：OpenWeatherMap API，注入当前时间+天气到 prompt
- [x] **对话历史**：近 10 条消息写入 SQLite，下次请求时带入上下文

### 前端（`pwa/index.html`）

- [x] 像素点阵时钟（5×7 dot-matrix，实时更新）
- [x] 播放/暂停/上一首/下一首/停止按钮 → 控制真实 `<audio>` 元素
- [x] 进度条（实时更新 + 点击跳转）
- [x] 音量条（点击调节）
- [x] 队列面板（显示接下来最多 3 首，可点击立即播放）
- [x] 聊天界面（用户气泡 + DJ 气泡，打字动画，自动滚动）
- [x] 页面加载时拉取 `/api/now` 显示当前播放状态
- [x] WebSocket 断线自动重连（3 秒后重试）

---

## 三、文件结构

```
claudio/
├── server.js                  # Express 主入口，全部 API 路由，NCM 工具函数
├── .env                       # 所有 API Key（见第六节）
├── .gitignore                 # 排除 .env / cache/ / db/ / node_modules/
├── package.json
├── STATUS.md                  # 本文件
├── CLAUDE.md                  # 原始项目规格文档
│
├── core/
│   ├── claude.js              # 调用 qwen-max (OpenAI 兼容接口)，解析 JSON 响应
│   ├── context.js             # 拼装 system prompt（persona + 品味 + 环境 + 历史 + 曲库）
│   ├── router.js              # 意图分流：music_direct / system / claude
│   ├── scheduler.js           # node-cron 定时任务 + WebSocket broadcast 工具
│   ├── songpool.js            # 加载 3 个歌单文件，Fisher-Yates 随机采样
│   ├── state.js               # SQLite 封装（messages / plays / prefs 三张表）
│   └── tts.js                 # msedge-tts 合成，MD5 缓存到 cache/tts/
│
├── prompts/
│   ├── dj-persona.md          # DJ 人格设定（系统提示词第一片）
│   └── mood-rules.md          # 时间段/天气/连续选曲规则
│
├── user/
│   ├── taste.md               # 音乐品味画像（从真实歌单提炼，约 60 行）
│   ├── routines.md            # 日常规律（上海，工作日 9-19，深夜偶发）
│   ├── ncm-cookie.json        # 网易云登录 Cookie（node scripts/ncm-login.js 生成）
│   ├── ncm-playlist.txt       # 网易云歌单 1873 首（格式：歌名 - 艺人名）
│   ├── xiami-liked-songs.csv  # 虾米收藏 2631 首（CSV：歌曲名,专辑名,艺人名,...）
│   ├── xiami-playlists.csv    # 虾米创建歌单 795 首（CSV：歌单名,简介,歌曲名,艺人名,...）
│   └── xiami-liked-albums.csv # 虾米收藏专辑（目前未使用）
│
├── scripts/
│   └── ncm-login.js           # 网易云扫码登录，保存 Cookie 到 user/ncm-cookie.json
│
├── pwa/
│   └── index.html             # 完整单文件前端（React 18 + Babel，CDN 加载）
│                              # 其余 app.js / style.css / sw.js 为旧版残留，不使用
│
├── cache/
│   └── tts/                   # TTS 缓存 mp3（gitignore）
│
└── db/
    └── state.db               # SQLite 数据库，自动创建（gitignore）
```

---

## 四、各模块实现细节

### `server.js` — API 路由

| 端点 | 说明 |
|------|------|
| `POST /api/chat` | 主入口：意图分流 → buildContext → askClaude → resolveQueue → synthesize TTS → 返回 `{say, say_audio, queue[], reason, segue}` |
| `GET /api/next` | 弹出内存队列 `playQueue` 的下一首，并广播 `now-playing` |
| `GET /api/queue` | 查看当前内存队列（不消费） |
| `GET /api/now` | 最近一条播放记录 + 今日播放计数 |
| `GET /api/taste` | 返回 `user/taste.md` 原文 |
| `GET /api/plan/today` | 今日计数 + 最近 20 条播放记录 |
| `WS /stream` | WebSocket，广播 `now-playing` / `morning` / `scheduled` 事件 |

**NCM Cookie 注入方式（重要）：**
```javascript
// NeteaseCloudMusicApi 需要 cookie 作为 URL 查询参数，不是请求头
const finalUrl = cookie
  ? url + (url.includes('?') ? '&' : '?') + 'cookie=' + encodeURIComponent(cookie)
  : url
```
> 早期 bug：用 `headers: { Cookie: ... }` 发给本地 API，本地 API 不转发，导致所有歌曲只返回 30 秒试听片段。

**NCM 三级搜索匹配：**
1. 歌名 + 艺人完全匹配
2. 歌名完全匹配 + 艺人名互相包含（处理"王菲"vs"王 菲"等空格差异）
3. 仅歌名完全匹配（放弃艺人验证）
4. 三级全失败 → 返回 `null`，跳过该曲目，不盲目取第一条结果

### `core/context.js` — Prompt 拼装

每次请求动态拼装 system prompt，包含：
1. `prompts/dj-persona.md`（静态）
2. `user/taste.md` + `user/routines.md`（静态）
3. `prompts/mood-rules.md`（静态）
4. 当前时间（Asia/Shanghai）+ 天气（OpenWeatherMap）
5. 近 20 首播放记录（按 `song_name::artist` 去重），写入禁止重推名单
6. 从 4710 首歌随机采样 40 首（排除近期已播），作为**唯一可选曲库**

> AI 只能从注入的 40 首中选曲，不能编造，彻底杜绝幻觉歌单。

### `core/claude.js` — AI 调用

- 使用通义千问 `qwen-max`，通过 OpenAI SDK 兼容接口
- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `extractFirstJson()` 用括号计数从响应中提取第一个完整 JSON（qwen-max 有时在 JSON 前后输出解释文字）
- 返回格式: `{ say: string, play: [{id, name, artist}], reason: string, segue: string }`

### `core/tts.js` — 语音合成

- `msedge-tts` 包（CommonJS，无需 API Key）
- 音色：`zh-CN-YunxiNeural`，格式：`AUDIO_24KHZ_48KBITRATE_MONO_MP3`
- MD5 缓存：同样的文案只合成一次，直接返回 `/cache/tts/{hash}.mp3`

### `core/songpool.js` — 歌单曲库

解析三个格式不同的文件：
- `ncm-playlist.txt`：`歌名 - 艺人名`（每行）
- `xiami-liked-songs.csv`：`歌曲名,专辑名,艺人名,...`（CSV，艺人多个以分号分隔）
- `xiami-playlists.csv`：`歌单名,简介,歌曲名,艺人名,...`（CSV）

加载后按 `name::artist` 去重，结果缓存在内存，得到 **4710 首**。

### `pwa/index.html` — 前端

纯单文件，27KB，无构建步骤：
- React 18 + ReactDOM + Babel Standalone（均从 unpkg CDN 加载）
- `<script type="text/babel">` 内联 JSX 代码，Babel 在浏览器中实时编译
- `<audio>` 元素挂载到 `document.body`，贯穿整个会话
- `localQueue` 模块级数组，前端维护队列状态
- TTS 播完后自动起播第一首歌（解决 autoplay 限制：用户点发送触发了交互，允许播放）

---

## 五、依赖的外部服务

### 1. NeteaseCloudMusicApi（本地，必须）

非官方网易云 API，需在 claudio **同级目录**部署并保持运行：

```bash
# 初次安装
npm install -g NeteaseCloudMusicApi
# 或从 npm 安装到本地
cd ~/Projects
npm install NeteaseCloudMusicApi
cd NeteaseCloudMusicApi/node_modules/.bin
./NeteaseCloudMusicApi   # 默认跑在 http://localhost:3000
```

验证：`curl http://localhost:3000` 返回 HTML 页面即正常。

> GitHub 原始仓库 `Binaryify/NeteaseCloudMusicApi` 已因版权下架，npm 包 `NeteaseCloudMusicApi@4.31.0` 仍可用。

### 2. 网易云 Cookie（需要 VIP 账号）

无 VIP 账号所有歌曲只返回 30 秒试听片段。Cookie 有效期数月，过期后需重新登录。

```bash
node scripts/ncm-login.js   # 终端扫码，Cookie 保存到 user/ncm-cookie.json
```

### 3. 通义千问 API（必须）

- 账号：[dashscope.aliyun.com](https://dashscope.aliyun.com)
- 模型：`qwen-max`
- Base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`

### 4. OpenWeatherMap（可选）

无 key 时天气返回"天气未知"，不影响主功能。

---

## 六、环境变量（`.env`）

```env
# 通义千问（必须）
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 网易云音乐本地 API 地址（必须，默认 http://localhost:3000）
NCM_API_BASE=http://localhost:3000

# Fish Audio TTS（目前未使用，msedge-tts 不需要 key）
FISH_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FISH_VOICE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenWeather（可选，无 key 跳过天气注入）
WEATHER_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WEATHER_CITY=Shanghai

# 服务端口（默认 8080）
PORT=8080
```

---

## 七、启动步骤

```bash
# 终端 1：网易云 API（保持运行）
cd ~/Projects/NeteaseCloudMusicApi
node app.js

# 终端 2：RodiO
cd ~/Projects/claudio
node server.js

# 浏览器
open http://localhost:8080
```

首次在新环境需要先登录网易云：
```bash
node scripts/ncm-login.js
```

---

## 八、待完成 / 已知问题

### 功能待完善

- [ ] **LOGIN 按钮**：页面顶部 LOGIN 按钮为设计稿占位符，尚未实现任何功能（可以留空，本地单用户不需要认证）
- [ ] **LIGHT 主题切换**：DARK/LIGHT 按钮点击无效，只有深色模式
- [ ] **♥ 收藏按钮**：点击无响应，可接到 `state.setPref` 写入喜好标记
- [ ] **▶ REPLAY 按钮**：点击重播该条 TTS 音频，目前无响应
- [ ] **上一首**：当前行为是跳到当前歌曲开头（`audio.currentTime = 0`），没有真正跳到上一首（上一首 URL 已不持有）
- [ ] **定时任务前端处理**：scheduler 通过 WebSocket 发出 `morning` / `scheduled` 事件，前端目前只处理 `now-playing` 和 `say`，定时任务的 `play[]` 没有自动解析并加入队列
- [ ] **Service Worker**：`pwa/sw.js` 存在但未注册，PWA 离线缓存未启用
- [ ] **Volume 滑动**：音量条目前只支持点击，不支持拖动

### 已知限制

- **NCM 版权**：部分歌曲即使有 VIP 也无法获取直链（code 非 200），会被 `resolveQueue` 自动跳过
- **Babel CDN**：前端依赖 unpkg CDN（React、ReactDOM、Babel），离线环境无法访问时页面空白。可改为本地 vendor 文件
- **qwen-max 选曲质量**：偶尔从曲库 40 首样本中挑出风格偏差的歌，提高 `samplePool` 数量（目前 40）可改善
- **TTS 首次延迟**：首次合成一段新文案约 3-8 秒，msedge-tts 需要建立 WebSocket 连接

### 可选改进

- [ ] 把 `samplePool(40, ...)` 改为加权采样（偏向 taste.md 里的核心艺人）
- [ ] 前端增加歌词显示（NCM `/lyric?id=xxx` 接口已有）
- [ ] 定时任务触发时通过 `/api/chat` 同路径自动解析并加入前端队列
- [ ] 将 React/Babel 改为本地 vendor，去除 CDN 依赖
- [ ] 给 `plays` 表增加 `rating` 字段，支持收藏/屏蔽
