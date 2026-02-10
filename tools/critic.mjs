#!/usr/bin/env node
/**
 * critic.mjs - Check proposed actions against failure patterns
 * 
 * Usage: node critic.mjs "what I'm about to do"
 * 
 * Returns warnings if patterns match known failures.
 */

const action = process.argv.slice(2).join(' ');
if (!action) {
  console.log('Usage: node critic.mjs "what you are about to do"');
  process.exit(1);
}

// Red flag patterns
const RED_FLAGS = [
  { pattern: /creat(e|ing)\s+(a\s+)?(new\s+)?(repo|repository|service|project)/i, 
    warning: "Creating new repo/service", 
    query: "creating new project" },
  { pattern: /(this\s+)?should\s+work|let'?s?\s+(just\s+)?try/i, 
    warning: "Untested confidence", 
    query: "writing tests or gates" },
  { pattern: /clean\s*(it\s*)?(this\s*)?up\s+later/i, 
    warning: "Deferred cleanup", 
    query: "running tests against production" },
  { pattern: /\bI('?m|\s+am)\s+(pretty\s+)?(sure|confident)/i, 
    warning: "Confident without evidence", 
    query: "warning signs I am about to make a mistake" },
  { pattern: /multiple\s+(api\s+)?calls|several\s+requests/i,
    warning: "Multiple API calls",
    query: "starting a session" },
];

async function queryDeja(context) {
  try {
    const res = await fetch('https://deja-api.coey.dev/inject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, format: 'prompt', limit: 2 })
    });
    const data = await res.json();
    return data.injection || '';
  } catch (e) {
    return '';
  }
}

async function main() {
  console.log(`\n🔍 CRITIC reviewing: "${action.slice(0, 60)}${action.length > 60 ? '...' : ''}"\n`);
  
  let warnings = [];
  
  for (const flag of RED_FLAGS) {
    if (flag.pattern.test(action)) {
      warnings.push({ ...flag, matched: true });
    }
  }
  
  if (warnings.length === 0) {
    // No red flags, but still query deja for relevant failures
    const dejaResponse = await queryDeja(action);
    if (dejaResponse && dejaResponse.includes('FAILURE:')) {
      console.log('📋 Relevant context from memory:\n');
      console.log(dejaResponse);
    } else {
      console.log('✅ No red flags detected. Proceed with caution.\n');
    }
    return;
  }
  
  console.log('⚠️  RED FLAGS DETECTED:\n');
  
  for (const w of warnings) {
    console.log(`  🚩 ${w.warning}`);
    const context = await queryDeja(w.query);
    if (context) {
      // Extract just the failure/prevention part
      const lines = context.split('\n').filter(l => 
        l.includes('FAILURE:') || l.includes('PREVENTION:') || l.includes('RED FLAGS:')
      );
      if (lines.length > 0) {
        console.log('     From memory:');
        lines.slice(0, 3).forEach(l => console.log(`     ${l.trim()}`));
      }
    }
    console.log('');
  }
  
  console.log('─'.repeat(60));
  console.log('Consider: Is this the right approach? Check deja for alternatives.\n');
}

main();
