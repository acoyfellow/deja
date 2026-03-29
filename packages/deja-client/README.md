# deja-client

HTTP client for a hosted [deja](https://github.com/acoyfellow/deja) instance.

```ts
import deja from 'deja-client'

const mem = deja('https://your-deja-instance.workers.dev', { apiKey: '...' })

await mem.learn('deploy failed', 'check wrangler.toml first')
const { prompt, learnings } = await mem.inject('deploying to production')
const results = await mem.query('wrangler config')
await mem.confirm(learnings[0].id, {
  identity: { proofRunId: 'lab-run-42', proofIterationId: 'lab-run-42:3' },
})
```

## Install

```bash
npm install deja-client
```

## API

```ts
const mem = deja(url, { apiKey?, fetch? })

await mem.learn(trigger, learning, { confidence?, scope?, reason?, source?, identity? })
await mem.confirm(id, { identity? })
await mem.reject(id, { identity? })
await mem.inject(context, { scopes?, limit?, format?, includeState?, runId?, identity? })
await mem.injectTrace(context, { scopes?, limit?, threshold?, identity? })
await mem.query(text, { scopes?, limit?, identity? })
await mem.list({ scope?, limit? })
await mem.learningNeighbors(id, { threshold?, limit? })
await mem.forget(id)
await mem.forgetBulk({ confidenceLt?, notRecalledInDays?, scope? })
await mem.cleanup()

await mem.getState(runId)
await mem.putState(runId, payload, { updatedBy?, changeSummary?, identity? })
await mem.patchState(runId, patch, { updatedBy?, identity? })
await mem.addStateEvent(runId, eventType, payload, { createdBy?, identity? })
await mem.resolveState(runId, { persistToLearn?, scope?, summaryStyle?, updatedBy?, identity? })

await mem.setSecret(name, value, { scope? })
await mem.getSecret(name, { scopes? })
await mem.deleteSecret(name, { scope? })
await mem.listSecrets({ scope? })

await mem.stats()
await mem.recordRun(outcome, attempts, { scope?, code?, error? })
await mem.getRuns({ scope?, limit? })
```

The client mirrors the hosted REST API. State payloads and trace responses are exposed as camelCase in TypeScript even when the underlying HTTP payload uses snake_case.

Exported types include `Learning`, `SharedRunIdentity`, `InjectResult`, `InjectTraceResult`, `LearningNeighbor`, `WorkingStatePayload`, `WorkingStateResponse`, `Secret`, `QueryResult`, `Stats`, and the loop-run result types.

## License

MIT
