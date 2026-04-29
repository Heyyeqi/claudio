const OpenCC = require('opencc-js')

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })
const TITLE_NOISE_PATTERNS = [
  /\s*[-:]\s*(live|demo|remaster(?:ed)?|acoustic|instrumental|karaoke|mono|stereo|edit|mix|version|ver\.?)\b.*$/gi,
  /\b(live|demo|remaster(?:ed)?|acoustic|instrumental|karaoke|mono|stereo|edit|mix|version|ver\.?|ost|soundtrack)\b/gi,
]
const ARTIST_SPLIT_RE = /\s*(?:\/|&|,|，|、|;|；|\+| x | X | feat\.?|ft\.?|featuring|with| and )\s*/gi
const CHINESE_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const ARTIST_ALIAS_GROUPS = [
  ['莫文蔚', 'Karen Mok', 'Karen Joy Morris'],
  ['王菲', 'Faye Wong'],
  ['张惠妹', '張惠妹', 'A-Mei', 'aMEI', '阿妹'],
  ['张学友', '張學友', 'Jacky Cheung'],
  ['陈奕迅', '陳奕迅', 'Eason Chan'],
  ['周杰伦', '周杰倫', 'Jay Chou'],
  ['蔡依林', 'Jolin Tsai'],
  ['林俊杰', '林俊傑', 'JJ Lin'],
  ['孙燕姿', '孫燕姿', 'Stefanie Sun'],
  ['梁静茹', '梁靜茹', 'Fish Leong'],
  ['田馥甄', 'Hebe Tien'],
]

function uniqueStrings(values) {
  const output = []
  const seen = new Set()
  for (const value of values || []) {
    const text = String(value || '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function safeConvert(converter, text) {
  try {
    return converter(String(text || ''))
  } catch {
    return String(text || '')
  }
}

function containsChinese(text) {
  return CHINESE_CHAR_RE.test(String(text || ''))
}

function normalizeBaseText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[／]/g, '/')
    .replace(/[　]/g, ' ')
    .trim()
}

function stripBracketContent(text) {
  return String(text || '').replace(/（.*?）|\(.*?\)|\[.*?]|【.*?】|「.*?」|『.*?』/g, ' ')
}

function stripTitleNoise(text) {
  let value = stripBracketContent(normalizeBaseText(text))
  for (const pattern of TITLE_NOISE_PATTERNS) {
    value = value.replace(pattern, ' ')
  }
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeCompareText(text, options = {}) {
  const { preserveSpaces = false } = options
  const value = safeConvert(toSimplified, normalizeBaseText(text))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[·•・]/g, ' ')
    .replace(/[’'".,!?()[\]{}<>《》〈〉、，。:：;；`~!@#$%^&*_+=|\\/-]/g, ' ')
    .replace(/\s+/g, preserveSpaces ? ' ' : '')
    .trim()
  return preserveSpaces ? value : value.replace(/\s+/g, '')
}

function normalizeSongKey(text) {
  return normalizeCompareText(stripTitleNoise(text))
}

function normalizeArtistKey(text) {
  return normalizeCompareText(text)
}

function splitArtistNames(text) {
  return uniqueStrings(
    normalizeBaseText(text)
      .split(ARTIST_SPLIT_RE)
      .map(part => part.trim())
      .filter(Boolean)
  )
}

function expandArtistAliases(name) {
  const normalized = normalizeArtistKey(name)
  if (!normalized) return []

  const variants = new Set([normalizeBaseText(name), safeConvert(toSimplified, name), safeConvert(toTraditional, name)])
  for (const group of ARTIST_ALIAS_GROUPS) {
    const normalizedGroup = group.map(item => normalizeArtistKey(item))
    if (normalizedGroup.includes(normalized)) {
      for (const alias of group) variants.add(alias)
    }
  }

  const output = []
  const seen = new Set()
  for (const variant of variants) {
    const text = normalizeBaseText(variant)
    const key = normalizeArtistKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function expandArtistParts(text) {
  const variants = new Set()
  for (const part of splitArtistNames(text)) {
    for (const alias of expandArtistAliases(part)) {
      variants.add(alias)
      for (const nested of splitArtistNames(alias)) variants.add(nested)
    }
  }
  return uniqueStrings([...variants])
}

function buildTitleVariants(song) {
  const rawTitles = uniqueStrings([song?.name, song?.name_tw, song?.name_en])
  const variants = new Set()
  for (const title of rawTitles) {
    variants.add(normalizeBaseText(title))
    if (containsChinese(title)) {
      variants.add(safeConvert(toSimplified, title))
      variants.add(safeConvert(toTraditional, title))
    }
  }

  const output = []
  const seen = new Set()
  for (const variant of variants) {
    const text = stripTitleNoise(variant)
    const key = normalizeSongKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function buildArtistVariants(song) {
  const rawArtists = uniqueStrings([song?.artist, song?.artist_en])
  const variants = new Set()
  for (const artist of rawArtists) {
    variants.add(normalizeBaseText(artist))
    for (const alias of expandArtistAliases(artist)) variants.add(alias)
    if (containsChinese(artist)) {
      variants.add(safeConvert(toSimplified, artist))
      variants.add(safeConvert(toTraditional, artist))
    }
  }

  const output = []
  const seen = new Set()
  for (const variant of variants) {
    const text = normalizeBaseText(variant)
    const key = normalizeArtistKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(text)
  }
  return output
}

function makeSongSearchProfile(songOrName, artist) {
  if (songOrName && typeof songOrName === 'object') {
    return {
      id: songOrName.id || null,
      name: normalizeBaseText(songOrName.name),
      artist: normalizeBaseText(songOrName.artist),
      name_en: normalizeBaseText(songOrName.name_en),
      artist_en: normalizeBaseText(songOrName.artist_en),
      name_tw: normalizeBaseText(songOrName.name_tw),
    }
  }

  return {
    id: null,
    name: normalizeBaseText(songOrName),
    artist: normalizeBaseText(artist),
    name_en: '',
    artist_en: '',
    name_tw: '',
  }
}

function titleMatchScore(expectedTitles, candidateTitle) {
  const candidateKey = normalizeSongKey(candidateTitle)
  if (!candidateKey) return 0

  let bestScore = 0
  for (const expectedTitle of expectedTitles || []) {
    const expectedKey = normalizeSongKey(expectedTitle)
    if (!expectedKey) continue
    if (candidateKey === expectedKey) bestScore = Math.max(bestScore, 100)
    else if (candidateKey.includes(expectedKey) || expectedKey.includes(candidateKey)) bestScore = Math.max(bestScore, 72)
  }
  return bestScore
}

function artistMatchScore(expectedArtists, candidateArtists) {
  const candidateParts = uniqueStrings(
    (candidateArtists || []).flatMap(name => [
      ...splitArtistNames(name),
      ...expandArtistParts(name),
    ])
  )
  const candidateKeys = candidateParts.map(normalizeArtistKey).filter(Boolean)
  if (!candidateKeys.length) return 0

  let bestScore = 0
  for (const expectedArtist of expectedArtists || []) {
    for (const part of expandArtistParts(expectedArtist)) {
      const partKey = normalizeArtistKey(part)
      if (!partKey) continue
      for (const candidateKey of candidateKeys) {
        if (candidateKey === partKey) bestScore = Math.max(bestScore, 100)
        else if (candidateKey.includes(partKey) || partKey.includes(candidateKey)) bestScore = Math.max(bestScore, 68)
      }
    }
  }
  return bestScore
}

module.exports = {
  artistMatchScore,
  buildArtistVariants,
  buildTitleVariants,
  makeSongSearchProfile,
  normalizeArtistKey,
  normalizeBaseText,
  normalizeCompareText,
  normalizeSongKey,
  splitArtistNames,
  stripTitleNoise,
  titleMatchScore,
}
