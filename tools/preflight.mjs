#!/usr/bin/env node
/**
 * preflight - query memory, think, then build
 * 
 * Usage: node preflight.mjs "what you're about to do"
 */

const task = process.argv[2];
if (!task) {
  console.log("Usage: node preflight.mjs 'what you're about to build'");
  process.exit(1);
}

async function queryDeja(context) {
  try {
    const res = await fetch('https://deja.coey.dev/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, format: 'prompt', limit: 5 })
    });
    const data = await res.json();
    return data.injection || null;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  PREFLIGHT: ${task.slice(0, 46).padEnd(46)}  ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Query deja
  console.log("⏳ Querying memory...\n");
  const memory = await queryDeja(task);
  
  if (memory) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("FROM MEMORY:");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(memory);
    console.log("");
  } else {
    console.log("📭 No relevant memory found.\n");
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("BEFORE YOU BUILD, ANSWER:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`
1. WHAT exactly are you building?
   (Be specific. Not "a service" but "POST /endpoint that does X")

2. WHY is this needed?
   (What problem? Is there a simpler way? Did memory show prior art?)

3. HOW will you know it works?
   (Write the test BEFORE the code)

4. WHAT could go wrong?
   (Red-team: what bad code passes your test?)

5. Is the answer in memory already?
   (If yes, don't build—use what exists)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If you can't answer #3 and #4, you're not ready.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main();
