# deja-client

HTTP client for a hosted [deja](https://github.com/acoyfellow/deja) instance.

```ts
import deja from 'deja-client'

const mem = deja('https://your-deja-instance.workers.dev', { apiKey: '...' })

await mem.learn('deploy failed', 'check wrangler.toml first')
const { prompt, learnings } = await mem.inject('deploying to production')
const results = await mem.query('wrangler config')
```

## Install

```bash
npm install deja-client
```

## API

```ts
const mem = deja(url, { apiKey?, fetch? })

await mem.learn(trigger, learning, { confidence?, scope?, reason?, source? })
await mem.inject(context, { scopes?, limit?, format? })
await mem.query(text, { scopes?, limit? })
await mem.list({ scope?, limit? })
await mem.forget(id)
await mem.stats()
await mem.recordRun(outcome, attempts, { scope?, code?, error? })
await mem.getRuns({ scope?, limit? })
```

All types (`Learning`, `InjectResult`, `QueryResult`, `Stats`) are exported for TypeScript users.

## License

MIT
