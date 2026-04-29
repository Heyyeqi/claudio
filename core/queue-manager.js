function createQueueManager(options = {}) {
  const {
    targetSize = 12,
    refillThreshold = 4,
    itemKey = (item) => item?.song_info ? `${item.song_info.name}::${item.song_info.artist}`.toLowerCase() : '',
    onQueueChange = null,
    onRefillStart = null,
    onRefillComplete = null,
    onRefillError = null,
  } = options

  let readyPool = []
  let refillHandler = null
  let refillPromise = null
  let isRefilling = false

  function emitQueueChange(reason) {
    if (typeof onQueueChange === 'function') {
      onQueueChange(readyPool.slice(), reason)
    }
  }

  function dedupeItems(items, baseItems = readyPool) {
    const seen = new Set(baseItems.map(itemKey).filter(Boolean))
    const output = []
    for (const item of Array.isArray(items) ? items : []) {
      const key = itemKey(item)
      if (!key || seen.has(key)) continue
      seen.add(key)
      output.push(item)
    }
    return output
  }

  function getSnapshot() {
    return readyPool.slice()
  }

  function size() {
    return readyPool.length
  }

  function peek() {
    return readyPool[0] || null
  }

  function clear(reason = 'clear') {
    readyPool = []
    emitQueueChange(reason)
  }

  function replace(items, reason = 'replace') {
    readyPool = dedupeItems(items, [])
    emitQueueChange(reason)
    return getSnapshot()
  }

  function prepend(items, reason = 'prepend') {
    const deduped = dedupeItems(items, [])
    if (!deduped.length) return getSnapshot()
    const incomingKeys = new Set(deduped.map(itemKey).filter(Boolean))
    readyPool = [...deduped, ...readyPool.filter(item => !incomingKeys.has(itemKey(item)))]
    emitQueueChange(reason)
    return getSnapshot()
  }

  function append(items, reason = 'append') {
    const deduped = dedupeItems(items)
    if (!deduped.length) return getSnapshot()
    readyPool = [...readyPool, ...deduped]
    emitQueueChange(reason)
    return getSnapshot()
  }

  function remove(predicate, reason = 'remove') {
    const before = readyPool.length
    readyPool = readyPool.filter(item => !predicate(item))
    if (readyPool.length !== before) emitQueueChange(reason)
    return getSnapshot()
  }

  function pop(reason = 'pop') {
    const item = readyPool.shift() || null
    if (item) emitQueueChange(reason)
    return item
  }

  function setRefillHandler(handler) {
    refillHandler = handler
  }

  async function ensureFilled(reason = 'auto', extra = {}) {
    if (typeof refillHandler !== 'function') return []
    if (size() >= refillThreshold && !extra.force) return []
    if (refillPromise) return refillPromise

    const sizeBefore = size()
    const needed = Math.max(0, targetSize - sizeBefore)
    if (needed <= 0 && !extra.force) return []

    isRefilling = true
    if (typeof onRefillStart === 'function') onRefillStart({ reason, needed, sizeBefore, force: !!extra.force })

    refillPromise = (async () => {
      try {
        const items = await refillHandler({
          reason,
          needed,
          sizeBefore,
          currentQueue: getSnapshot(),
          force: !!extra.force,
          meta: extra.meta || null,
        })
        const inserted = append(items, `refill:${reason}`)
        if (typeof onRefillComplete === 'function') {
          onRefillComplete({
            reason,
            sizeBefore,
            sizeAfter: size(),
            insertedCount: size() - sizeBefore,
            queue: getSnapshot(),
            meta: extra.meta || null,
          })
        }
        return inserted
      } catch (error) {
        if (typeof onRefillError === 'function') onRefillError(error, { reason, meta: extra.meta || null })
        throw error
      } finally {
        isRefilling = false
        refillPromise = null
      }
    })()

    return refillPromise
  }

  return {
    append,
    clear,
    ensureFilled,
    getSnapshot,
    isRefilling: () => isRefilling,
    peek,
    pop,
    prepend,
    remove,
    replace,
    setRefillHandler,
    size,
    targetSize,
    refillThreshold,
  }
}

module.exports = { createQueueManager }
