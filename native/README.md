# deja-native

A dependency-free MCP stdio server compiled to a native executable with `scriptc`. It implements JSON-RPC `initialize`, `ping`, `tools/list`, and `tools/call`, and publishes the 12 tool names and input schemas from `src/mcp.ts`.

The protocol layer is complete. The Bun SQLite storage implementation cannot be linked by scriptc today, so tool calls return an MCP error result explaining that storage is not configured. The server never fabricates memories or mailbox data.

## Seven-minute setup

### Minute 1: prerequisites

Install Node.js, npm, and scriptc, then confirm they are available:

```sh
node --version
npm --version
scriptc --version
```

### Minute 2: install type declarations

```sh
cd native
npm install
```

`@types/node` and TypeScript are development-only dependencies. The executable has no npm runtime dependencies.

### Minute 3: type-check

```sh
npm run typecheck
```

### Minute 4: verify static coverage

```sh
scriptc coverage server.ts
```

The expected result is 100% static coverage with no dynamic remainder.

### Minute 5: build

```sh
./build.sh
```

This runs coverage and then `scriptc build server.ts -o deja-native`.

### Minute 6: prove discovery

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"proof","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ./deja-native
```

Both output lines are valid JSON-RPC responses. The second response contains all 12 tools.

### Minute 7: prove safe tool failure

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"recall","arguments":{"query":""}}}' \
  | env -u DEJA_DB ./deja-native
```

The response is a valid MCP tool result with `isError: true` and an explicit not-configured message. No mock memory is returned.

## MCP client configuration

Point an MCP client at the absolute path to `native/deja-native`. The process reads one JSON-RPC object per line from stdin and writes one JSON-RPC object per line to stdout. Diagnostics must not be written to stdout.
