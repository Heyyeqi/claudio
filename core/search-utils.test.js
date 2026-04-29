const test = require('node:test')
const assert = require('node:assert/strict')

const {
  artistMatchScore,
  buildTitleVariants,
  normalizeSongKey,
  titleMatchScore,
} = require('./search-utils')

test('traditional and simplified titles normalize to the same key', () => {
  assert.equal(normalizeSongKey('愛'), normalizeSongKey('爱'))
  assert.equal(normalizeSongKey('達爾文'), normalizeSongKey('达尔文'))
})

test('title matching ignores version suffixes and bracketed qualifiers', () => {
  const expectedTitles = buildTitleVariants({ name: '爱的代价', name_tw: '愛的代價' })
  assert.equal(titleMatchScore(expectedTitles, '爱的代价 (Live)'), 100)
  assert.equal(titleMatchScore(expectedTitles, '愛的代價 - Remastered 2019'), 100)
})

test('artist matching accepts common chinese and english aliases', () => {
  assert.ok(artistMatchScore(['莫文蔚'], ['Karen Mok']) >= 68)
  assert.ok(artistMatchScore(['王菲'], ['Faye Wong']) >= 68)
  assert.ok(artistMatchScore(['张惠妹'], ['A-Mei']) >= 68)
})
