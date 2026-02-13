# Drizzle migrations

This directory stores SQL migration artifacts derived from `src/schema.ts`.

## Generate

```bash
bunx drizzle-kit generate
```

## Apply (Cloudflare D1 target, existing repo pattern)

```bash
wrangler d1 execute deja-db --file=drizzle/0000_live_working_state.sql --remote
```
