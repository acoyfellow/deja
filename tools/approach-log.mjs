#!/usr/bin/env node
/**
 * approach-log - track what you tried within a session
 * 
 * Usage:
 *   node approach-log.mjs log "tried X" "result Y" "learned Z"
 *   node approach-log.mjs show
 *   node approach-log.mjs clear
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const LOG_FILE = '/tmp/approach-log.json';

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
    learned: learned || null
  };
  log.push(entry);
  saveLog(log);
  
  console.log(`✓ Logged: ${tried}`);
  console.log(`  Attempts this session: ${log.length}`);
  
} else if (cmd === 'show') {
  const log = getLog();
  if (log.length === 0) {
    console.log('No approaches logged this session.');
  } else {
    console.log(`\n━━━ APPROACH LOG (${log.length} entries) ━━━\n`);
    log.forEach((entry, i) => {
      console.log(`${i + 1}. TRIED: ${entry.tried}`);
      if (entry.result) console.log(`   RESULT: ${entry.result}`);
      if (entry.learned) console.log(`   LEARNED: ${entry.learned}`);
      console.log('');
    });
    
    // Show patterns
    const failures = log.filter(e => e.result?.toLowerCase().includes('fail') || e.result?.toLowerCase().includes('error'));
    if (failures.length > 0) {
      console.log(`⚠️  ${failures.length} failed attempts - don't repeat these.`);
    }
  }
  
} else if (cmd === 'clear') {
  saveLog([]);
  console.log('✓ Approach log cleared.');
  
} else if (cmd === 'check') {
  // Check if something similar was already tried
  const query = process.argv[3]?.toLowerCase();
  if (!query) {
    console.log('Usage: node approach-log.mjs check "what you want to try"');
    process.exit(1);
  }
  
  const log = getLog();
  const similar = log.filter(e => 
    e.tried.toLowerCase().includes(query) || 
    query.includes(e.tried.toLowerCase().split(' ')[0])
  );
  
  if (similar.length > 0) {
    console.log(`\n⚠️  Similar approaches already tried:\n`);
    similar.forEach(e => {
      console.log(`- ${e.tried}`);
      if (e.result) console.log(`  Result: ${e.result}`);
      if (e.learned) console.log(`  Learned: ${e.learned}`);
    });
  } else {
    console.log(`✓ Nothing similar tried yet. Go ahead.`);
  }
  
} else {
  console.log(`
approach-log - track attempts within a session

Commands:
  log "tried" "result" "learned"  - Record an attempt
  show                            - Show all attempts  
  check "query"                   - Check if similar was tried
  clear                           - Reset for new session
`);
}
