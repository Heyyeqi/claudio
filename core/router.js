function route(input) {
  if (/^(播放|放一首|来一首|播|放)\s*.+/.test(input)) return 'music_direct'
  if (/^(停止|暂停|下一首|上一首|音量)/.test(input)) return 'system'
  return 'claude'
}

module.exports = { route }
