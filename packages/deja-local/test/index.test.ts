import { describe, test, expect, beforeEach } from 'bun:test'
import { dejaLocal, type DejaLocalClient } from '../src/index'

describe('deja-local', () => {
  let mem: DejaLocalClient

  beforeEach(() => {
    mem = dejaLocal()
  })

  test('learn stores a memory', async () => {
    const l = await mem.learn('deploy fails', 'check wrangler.toml first')
    expect(l.id).toBeTruthy()
    expect(l.trigger).toBe('deploy fails')
    expect(l.learning).toBe('check wrangler.toml first')
    expect(l.confidence).toBe(0.8)
    expect(l.scope).toBe('shared')
    expect(mem.size).toBe(1)
  })

  test('learn → inject immediately (no eventual consistency)', async () => {
    await mem.learn('deploy fails', 'check wrangler.toml first')
    const result = await mem.inject('deploying and it failed')
    expect(result.learnings.length).toBe(1)
    expect(result.learnings[0].learning).toBe('check wrangler.toml first')
    expect(result.prompt).toContain('check wrangler.toml first')
  })

  test('inject returns most relevant memories', async () => {
    await mem.learn('database migration', 'always backup before migrating')
    await mem.learn('deploy fails', 'check wrangler.toml first')
    await mem.learn('css broken', 'clear the build cache')

    const result = await mem.inject('deploying to production')
    expect(result.learnings.length).toBeGreaterThan(0)
    // deploy-related memory should rank highest
    expect(result.learnings[0].learning).toBe('check wrangler.toml first')
  })

  test('query returns scored results', async () => {
    await mem.learn('tests fail', 'check for env vars')
    await mem.learn('build slow', 'enable turbo cache')

    const result = await mem.query('test failures')
    expect(result.learnings.length).toBeGreaterThan(0)
    expect(result.scores.size).toBeGreaterThan(0)
  })

  test('scope filtering works', async () => {
    await mem.learn('global tip', 'always lint', { scope: 'shared' })
    await mem.learn('agent tip', 'use gpt-4', { scope: 'agent:1' })

    const shared = await mem.inject('any task', { scopes: ['shared'] })
    const agent = await mem.inject('any task', { scopes: ['agent:1'] })

    expect(shared.learnings.every(l => l.scope === 'shared')).toBe(true)
    expect(agent.learnings.every(l => l.scope === 'agent:1')).toBe(true)
  })

  test('forget removes a memory', async () => {
    const l = await mem.learn('test', 'test learning')
    expect(mem.size).toBe(1)
    const result = await mem.forget(l.id)
    expect(result.success).toBe(true)
    expect(mem.size).toBe(0)
  })

  test('forget returns false for unknown id', async () => {
    const result = await mem.forget('nonexistent')
    expect(result.success).toBe(false)
  })

  test('list returns all memories', async () => {
    await mem.learn('a', 'learning a')
    await mem.learn('b', 'learning b', { scope: 'agent:1' })

    const all = await mem.list()
    expect(all.length).toBe(2)

    const scoped = await mem.list({ scope: 'agent:1' })
    expect(scoped.length).toBe(1)
    expect(scoped[0].learning).toBe('learning b')
  })

  test('stats returns correct counts', async () => {
    await mem.learn('a', 'a', { scope: 'shared' })
    await mem.learn('b', 'b', { scope: 'shared' })
    await mem.learn('c', 'c', { scope: 'agent:1' })

    const s = await mem.stats()
    expect(s.totalLearnings).toBe(3)
    expect(s.scopes['shared']).toBe(2)
    expect(s.scopes['agent:1']).toBe(1)
    expect(s.dimensions).toBe(384)
  })

  test('clear wipes everything', async () => {
    await mem.learn('a', 'b')
    await mem.learn('c', 'd')
    expect(mem.size).toBe(2)
    mem.clear()
    expect(mem.size).toBe(0)
  })

  test('recall count increments on inject', async () => {
    const l = await mem.learn('test trigger', 'test learning')
    expect(l.recallCount).toBe(0)

    await mem.inject('test trigger')
    const list = await mem.list()
    expect(list[0].recallCount).toBe(1)

    await mem.inject('test trigger')
    const list2 = await mem.list()
    expect(list2[0].recallCount).toBe(2)
  })

  test('custom embed function works', async () => {
    // Trivial 3-dim embedder
    const trivialEmbed = (text: string) => {
      const len = text.length
      return [len / 100, (len % 10) / 10, text.includes('fail') ? 1 : 0]
    }

    const custom = dejaLocal({ embed: trivialEmbed })
    await custom.learn('failure mode', 'restart the service')
    const result = await custom.inject('it failed')
    expect(result.learnings.length).toBeGreaterThan(0)
  })

  test('persistence round-trip', async () => {
    const path = '/tmp/deja-local-test-' + Date.now() + '.json'
    const mem1 = dejaLocal({ persistPath: path })
    await mem1.learn('test', 'persisted learning')
    await mem1.save()

    const mem2 = dejaLocal({ persistPath: path })
    await mem2.load()
    expect(mem2.size).toBe(1)
    const list = await mem2.list()
    expect(list[0].learning).toBe('persisted learning')

    // Cleanup
    const fs = await import('fs')
    fs.unlinkSync(path)
  })

  test('inject with threshold filters low-similarity results', async () => {
    await mem.learn('javascript closures', 'variables are captured by reference')
    const result = await mem.inject('kubernetes deployment yaml', { threshold: 0.9 })
    // Very different topics — should get filtered at high threshold
    expect(result.learnings.length).toBe(0)
  })
})
