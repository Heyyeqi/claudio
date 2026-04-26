const OpenAI = require('openai')

const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})

// 从可能包含多余文字的字符串中提取第一个完整 JSON 对象
function extractFirstJson(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

async function askClaude(context) {
  const response = await client.chat.completions.create({
    model: 'qwen-max',
    messages: [
      { role: 'system', content: context.system },
      ...context.messages,
    ],
  })

  const raw = response.choices[0]?.message?.content || '{}'

  // 先尝试直接解析
  try {
    return JSON.parse(raw)
  } catch {
    // 提取第一个完整 JSON 对象
    const fragment = extractFirstJson(raw)
    if (fragment) {
      try {
        return JSON.parse(fragment)
      } catch {
        // ignore
      }
    }
    return { say: raw, play: [], reason: 'JSON 解析失败', segue: '' }
  }
}

module.exports = { askClaude }
