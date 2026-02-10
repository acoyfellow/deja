#!/usr/bin/env node
/**
 * approach-log.mjs - track what you tried within a session
 * 
 * Usage:
 *   node approach-log.mjs log "tried X" "result Y" "learned Z"
 *   node approach-log.mjs show
 *   node approach-log.mjs check "query"
 *   node approach-log.mjs persist <index>  # Save to deja
 *   node approach-log.mjs clear
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const LOG_FILE = '/tmp/approach-log.json';
const API_KEY_FILE = join(homedir(), '.deja-api-key');

function getLog() {
  if (!existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function getApiKey() {
  try {
    return readFileSync(API_KEY_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

async function persistToDeja(entry, apiKey) {
  const trigger = `approach: ${entry.tried}`;
  const learning = entry.result?.toLowerCase().includes('fail') || entry.result?.toLowerCase().includes('error')
    ? `FAILURE: ${entry.result}. PREVENTION: ${entry.learned || 'TBD'}`
    : entry.learned || entry.result || 'No details';
  
  const res = await fetch('https://deja-api.coey.dev/learn', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      trigger,
      learning,
      confidence: 0.8,
      source: 'approach-log',
    }),
  });
  
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to persist');
  }
  
  return await res.json();
}

const cmd = process.argv[2];

if (cmd === 'log') {
  const tried = process.argv[3];
  const result = process.argv[4];
  const learned = process.argv[5];
  
  if (!tried) {
    console.log('Usage: node approach-log.mjs log "tried X" "result Y" "learned Z"');
    process.exit(1);
  }
  
  const log = getLog();
  const entry = {
    time: new Date().toISOString(),
    tried,
    result: result || null,
    learned: learned || null,
    persisted: false,
  };
  log.push(entry);
  saveLog(log);
  
  console.log(`\u2713 Logged: ${tried}`);
  console.log(`  Attempts this session: ${log.length}`);
  
  // Auto-suggest persist for failures
  if (result?.toLowerCase().includes('fail') || result?.toLowerCase().includes('error')) {
    console.log(`\n\u26a0\ufe0f  This looks like a failure. Consider persisting to deja:`);
    console.log(`   node approach-log.mjs persist ${log.length}`);
  }
  
} else if (cmd === 'show') {
  const log = getLog();
  if (log.length === 0) {
    console.log('No approaches logged this session.');
  } else {
    console.log(`\n\u2501\u2501\u2501 APPROACH LOG (${log.length} entries) \u2501\u2501\u2501\n`);
    log.forEach((entry, i) => {
      const status = entry.persisted ? '\u2705' : '\u23f3';
      console.log(`${i + 1}. ${status} TRIED: ${entry.tried}`);
      if (entry.result) console.log(`      RESULT: ${entry.result}`);
      if (entry.learned) console.log(`      LEARNED: ${entry.learned}`);
      console.log('');
    });
    
    // Show patterns
    const failures = log.filter(e => 
      e.result?.toLowerCase().includes('fail') || 
      e.result?.toLowerCase().includes('error')
    );
    if (failures.length > 0) {
      console.log(`\u26a0\ufe0f  ${failures.length} failed attempts - don't repeat these.`);
      const unpersisted = failures.filter(f => !f.persisted);
      if (unpersisted.length > 0) {
        console.log(`\ud83d\udcbe ${unpersisted.length} failures not yet persisted to deja.`);
      }
    }
  }
  
} else if (cmd === 'clear') {
  const log = getLog();
  const unpersisted = log.filter(e => !e.persisted && 
    (e.result?.toLowerCase().includes('fail') || e.learned));
  
  if (unpersisted.length > 0) {
    console.log(`\u26a0\ufe0f  ${unpersisted.length} entries not persisted to deja.`);
    console.log('   Run "node approach-log.mjs show" to review.');
    console.log('   Run "node approach-log.mjs persist <index>" to save important ones.');
    console.log('   Run "node approach-log.mjs clear --force" to clear anyway.');
    if (process.argv[3] !== '--force') {
      process.exit(1);
    }
  }
  
  saveLog([]);
  console.log('\u2713 Approach log cleared.');
  
} else if (cmd === 'check') {
  const query = process.argv[3]?.toLowerCase();
  if (!query) {
    console.log('Usage: node approach-log.mjs check "what you want to try"');
    process.exit(1);
  }
  
  const log = getLog();
  const similar = log.filter(e => 
    e.tried.toLowerCase().includes(query) || 
    query.split(' ').some(word => e.tried.toLowerCase().includes(word))
  );
  
  if (similar.length > 0) {
    console.log(`\n\u26a0\ufe0f  Similar approaches already tried:\n`);
    similar.forEach(e => {
      console.log(`- ${e.tried}`);
      if (e.result) console.log(`  Result: ${e.result}`);
      if (e.learned) console.log(`  Learned: ${e.learned}`);
    });
    process.exit(1); // Exit with error to signal "already tried"
  } else {
    console.log(`\u2713 Nothing similar tried yet. Go ahead.`);
  }
  
} else if (cmd === 'persist') {
  const index = parseInt(process.argv[3]) - 1; // 1-indexed for user
  const log = getLog();
  
  if (isNaN(index) || index < 0 || index >= log.length) {
    console.log(`Usage: node approach-log.mjs persist <index>`);
    console.log(`       Index must be 1-${log.length}`);
    process.exit(1);
  }
  
  const entry = log[index];
  if (entry.persisted) {
    console.log(`\u2713 Entry ${index + 1} already persisted.`);
    process.exit(0);
  }
  
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('\u274c No API key found at ~/.deja-api-key');
    process.exit(1);
  }
  
  try {
    const result = await persistToDeja(entry, apiKey);
    log[index].persisted = true;
    log[index].dejaId = result.id;
    saveLog(log);
    console.log(`\u2713 Persisted to deja: ${result.id}`);
  } catch (e) {
    console.log(`\u274c Failed to persist: ${e.message}`);
    process.exit(1);
  }
  
} else if (cmd === 'persist-all') {
  const log = getLog();
  const apiKey = getApiKey();
  
  if (!apiKey) {
    console.log('\u274c No API key found at ~/.deja-api-key');
    process.exit(1);
  }
  
  // Only persist failures and entries with learnings
  const toPersist = log.filter((e, i) => 
    !e.persisted && 
    (e.result?.toLowerCase().includes('fail') || 
     e.result?.toLowerCase().includes('error') ||
     e.learned)
  );
  
  if (toPersist.length === 0) {
    console.log('No new entries to persist.');
    process.exit(0);
  }
  
  console.log(`Persisting ${toPersist.length} entries...`);
  let success = 0;
  
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.persisted) continue;
    if (!entry.result?.toLowerCase().includes('fail') && 
        !entry.result?.toLowerCase().includes('error') &&
        !entry.learned) continue;
    
    try {
      const result = await persistToDeja(entry, apiKey);
      log[i].persisted = true;
      log[i].dejaId = result.id;
      success++;
      console.log(`  \u2713 ${i + 1}. ${entry.tried.slice(0, 40)}...`);
    } catch (e) {
      console.log(`  \u274c ${i + 1}. ${e.message}`);
    }
  }
  
  saveLog(log);
  console.log(`\nPersisted ${success}/${toPersist.length} entries.`);
  
} else {
  console.log(`
approach-log - track attempts within a session

Commands:
  log "tried" "result" "learned"  - Record an attempt
  show                            - Show all attempts  
  check "query"                   - Check if similar was tried (exits 1 if found)
  persist <index>                 - Save entry to deja memory
  persist-all                     - Save all failures/learnings to deja
  clear                           - Reset for new session

Examples:
  node approach-log.mjs log "added /evaluate endpoint" "success" "AI needs structured prompt"
  node approach-log.mjs log "regex matching" "failed - too brittle" "use AI instead"
  node approach-log.mjs persist 2
`);
}
