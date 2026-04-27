require('dotenv').config()

const path = require('path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(__dirname, '../db/state.db')
const PREF_KEY = 'ncm_id_map_v1'

function loadMap(db) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(PREF_KEY)
  if (!row) return { rowExists: false, map: {} }

  try {
    const parsed = JSON.parse(row.value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ncm_id_map_v1 is not an object')
    }
    return { rowExists: true, map: parsed }
  } catch (error) {
    throw new Error(`Failed to parse ${PREF_KEY}: ${error.message}`)
  }
}

function summarize(map) {
  const entries = Object.entries(map)
  const hitCount = entries.filter(([, value]) => value && value.status === 'hit').length
  const missCount = entries.filter(([, value]) => value && value.status === 'miss').length
  return {
    total: entries.length,
    hitCount,
    missCount,
  }
}

function removeHitEntries(map) {
  return Object.fromEntries(
    Object.entries(map).filter(([, value]) => !value || value.status !== 'hit')
  )
}

function main() {
  const db = new Database(DB_PATH)
  const { rowExists, map } = loadMap(db)
  const before = summarize(map)
  const filtered = removeHitEntries(map)
  const after = summarize(filtered)
  const deleted = before.hitCount - after.hitCount

  if (rowExists) {
    db.prepare(
      'UPDATE prefs SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
    ).run(JSON.stringify(filtered), PREF_KEY)
  }

  console.log(JSON.stringify({
    prefKey: PREF_KEY,
    dbPath: DB_PATH,
    deletedHits: deleted,
    remainingHits: after.hitCount,
    remainingMisses: after.missCount,
    remainingTotal: after.total,
  }, null, 2))
}

main()
