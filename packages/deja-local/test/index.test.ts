import { describe, test, expect } from 'bun:test'
import { createMemory } from '../src/index'

describe('createMemory', () => {
  test('learn + recall', async () => {
    const mem = createMemory({ embed: 'ngram' })

    await mem.learn('check wrangler.toml before deploying')
    const results = await mem.recall('deploy is failing')

    expect(results.length).toBe(1)
    expect(results[0].memory.text).toBe('check wrangler.toml before deploying')
    expect(results[0].score).toBeGreaterThan(0)
  })

  test('recall ranks by relevance', async () => {
    const mem = createMemory({ embed: 'ngram' })

    await mem.learn('always backup before running migrations')
    await mem.learn('check wrangler.toml before deploying')
    await mem.learn('clear build cache when css looks wrong')

    const results = await mem.recall('deploying to production')
    expect(results[0].memory.text).toBe('check wrangler.toml before deploying')
  })

  test('recall respects threshold', async () => {
    const mem = createMemory({ embed: 'ngram' })
    await mem.learn('javascript closures capture by reference')

    const results = await mem.recall('kubernetes yaml config', { threshold: 0.9 })
    expect(results.length).toBe(0)
  })

  test('recall respects limit', async () => {
    const mem = createMemory({ embed: 'ngram' })
    for (let i = 0; i < 10; i++) await mem.learn(`memory number ${i}`)

    const results = await mem.recall('memory', { limit: 3 })
    expect(results.length).toBe(3)
  })

  test('forget removes a memory', async () => {
    const mem = createMemory({ embed: 'ngram' })
    const m = await mem.learn('test memory')
    expect(mem.size).toBe(1)

    const ok = await mem.forget(m.id)
    expect(ok).toBe(true)
    expect(mem.size).toBe(0)
  })

  test('forget returns false for unknown id', async () => {
    const mem = createMemory({ embed: 'ngram' })
    expect(await mem.forget('nope')).toBe(false)
  })

  test('list returns all memories', async () => {
    const mem = createMemory({ embed: 'ngram' })
    await mem.learn('a')
    await mem.learn('b')
    expect(mem.list().length).toBe(2)
  })

  test('clear wipes everything', async () => {
    const mem = createMemory({ embed: 'ngram' })
    await mem.learn('a')
    await mem.learn('b')
    mem.clear()
    expect(mem.size).toBe(0)
  })

  test('custom embed function', async () => {
    const mem = createMemory({
      embed: (text) => [text.length / 100, text.includes('fail') ? 1 : 0],
    })
    await mem.learn('failure mode — restart the service')
    const results = await mem.recall('it failed')
    expect(results.length).toBeGreaterThan(0)
  })

  test('persistence round-trip', async () => {
    const p = `/tmp/deja-test-${Date.now()}.json`

    const mem1 = createMemory({ embed: 'ngram', path: p })
    await mem1.learn('persisted memory')
    await mem1.save()

    const mem2 = createMemory({ embed: 'ngram', path: p })
    await mem2.load()
    expect(mem2.size).toBe(1)
    expect(mem2.list()[0].text).toBe('persisted memory')

    const fs = await import('fs')
    fs.unlinkSync(p)
  })

  test('immediately available (no eventual consistency)', async () => {
    const mem = createMemory({ embed: 'ngram' })

    // Learn and recall in the same tick — no waiting
    await mem.learn('the sky is blue')
    const results = await mem.recall('what color is the sky')
    expect(results.length).toBe(1)
  })
})
