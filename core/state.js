const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const dbDir = path.join(__dirname, '../db')
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
const db = new Database(path.join(dbDir, 'state.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT,
    song_name TEXT,
    artist TEXT,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    mood TEXT
  );

  CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS song_feedback (
    song_key TEXT PRIMARY KEY,
    song_id TEXT,
    song_name TEXT,
    artist TEXT,
    feedback TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`)

function getRecentMessages(n = 10) {
  return db.prepare(
    'SELECT role, content FROM messages ORDER BY id DESC LIMIT ?'
  ).all(n).reverse()
}

function addMessage(role, content) {
  db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').run(role, content)
}

function addPlay(song) {
  db.prepare(
    'INSERT INTO plays (song_id, song_name, artist, mood) VALUES (?, ?, ?, ?)'
  ).run(song.id, song.name, song.artist, song.mood || null)
}

function getRecentPlays(n = 10) {
  return db.prepare(
    'SELECT song_id, song_name, artist, mood, played_at FROM plays ORDER BY id DESC LIMIT ?'
  ).all(n)
}

function getPref(key) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key)
  return row ? row.value : null
}

function setPref(key, value) {
  db.prepare(
    'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP'
  ).run(key, value)
}

function makeSongKey(song) {
  return `${String(song.name || '').trim().toLowerCase()}::${String(song.artist || '').trim().toLowerCase()}`
}

function setSongFeedback(song, feedback) {
  const songKey = makeSongKey(song)
  db.prepare(`
    INSERT INTO song_feedback (song_key, song_id, song_name, artist, feedback)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(song_key) DO UPDATE SET
      song_id=excluded.song_id,
      song_name=excluded.song_name,
      artist=excluded.artist,
      feedback=excluded.feedback,
      updated_at=CURRENT_TIMESTAMP
  `).run(songKey, song.id || null, song.name, song.artist, feedback)
}

function getSongFeedback(song) {
  const songKey = makeSongKey(song)
  return db.prepare(
    'SELECT song_id, song_name, artist, feedback, updated_at FROM song_feedback WHERE song_key = ?'
  ).get(songKey) || null
}

function getFeedbackByType(feedback, limit = 50) {
  return db.prepare(
    'SELECT song_id, song_name, artist, feedback, updated_at FROM song_feedback WHERE feedback = ? ORDER BY updated_at DESC LIMIT ?'
  ).all(feedback, limit)
}

module.exports = {
  getRecentMessages,
  addMessage,
  addPlay,
  getRecentPlays,
  getPref,
  setPref,
  setSongFeedback,
  getSongFeedback,
  getFeedbackByType,
}
