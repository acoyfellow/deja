#!/usr/bin/env node
/**
 * preflight.mjs - query memory, think, then build
 * 
 * Usage: node preflight.mjs "what you're about to do"
 * 
 * Enhanced version that:
 * - Queries deja for relevant memory
 * - Checks for similar past failures
 * - Forces you to answer key questions before building
 */

const task = process.argv.slice(2).join(' ');
if (!task) {
  console.log("Usage: node preflight.mjs 'what you're about to build'");
  process.exit(1);
}

async function queryDeja(context, limit = 5) {
  try {
    const res = await fetch('https://deja.coey.dev/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, format: 'prompt', limit }),
    });
    const data = await res.json();
    return data.injection || null;
  } catch (e) {
    return null;
  }
}

async function checkEvaluate(action) {
  try {
    const res = await fetch('https://deja.coey.dev/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function main() {
  const width = 64;
  const taskDisplay = task.slice(0, width - 14).padEnd(width - 14);
  
  console.log(`
╔${'\u2550'.repeat(width)}╗
║  PREFLIGHT: ${taskDisplay}  ║
╚${'\u2550'.repeat(width)}╝
`);

  // Query deja for memory
  console.log("⏳ Querying memory...");
  const [memory, evaluation] = await Promise.all([
    queryDeja(task),
    checkEvaluate(task),
  ]);

  // Show AI evaluation if available
  if (evaluation && evaluation.verdict) {
    const icons = { 'STOP': '🛑', 'CAUTION': '⚠️ ', 'PROCEED': '✅' };
    console.log(`\n${icons[evaluation.verdict] || '❓'} AI VERDICT: ${evaluation.verdict}`);
    if (evaluation.reasons && evaluation.reasons.length > 0) {
      evaluation.reasons.forEach(r => console.log(`   • ${r}`));
    }
    if (evaluation.verdict === 'STOP') {
      console.log('\n❌ AI recommends STOP. Review before continuing.');
    }
  }
  
  // Show memory
  if (memory) {
    console.log("\n" + "━".repeat(width));
    console.log("FROM MEMORY:");
    console.log("━".repeat(width));
    console.log(memory);
  } else {
    console.log("\n📭 No relevant memory found.");
  }

  // Extract failure patterns
  const failures = [];
  if (memory) {
    const lines = memory.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes('failure:') || 
          line.toLowerCase().includes('prevention:')) {
        failures.push(line.trim());
      }
    }
  }
  
  if (failures.length > 0) {
    console.log("\n" + "━".repeat(width));
    console.log("⚠️  PAST FAILURES TO AVOID:");
    console.log("━".repeat(width));
    failures.slice(0, 5).forEach(f => console.log(f));
  }

  // Questions
  console.log("\n" + "━".repeat(width));
  console.log("BEFORE YOU BUILD, ANSWER:");
  console.log("━".repeat(width));
  console.log(`
1. WHAT exactly are you building?
   (Be specific. "POST /endpoint that does X" not "a service")

2. WHY is this needed?
   (What problem? Is there a simpler way? Does memory show prior art?)

3. HOW will you know it works?
   (Write the test BEFORE the code)

4. WHAT could go wrong?
   (Red-team: what bad code passes your test?)

5. Is the answer in memory already?
   (If yes, don't build\u2014use what exists)

${"━".repeat(width)}
If you can't answer #3 and #4, you're not ready.
${"━".repeat(width)}
`);
}

main();
