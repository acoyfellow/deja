#!/usr/bin/env node
/**
 * check.mjs - Combined pre-action verification (AI-enhanced)
 * 
 * Usage: node check.mjs "what I'm about to do"
 * 
 * Uses deja's /evaluate endpoint for AI-based semantic checking.
 * Falls back to regex patterns if AI is unavailable.
 * Returns exit code 0 for PROCEED, 1 for STOP.
 */

const action = process.argv.slice(2).join(' ');
if (!action) {
  console.log('Usage: node check.mjs "what you are about to do"');
  console.log('Returns: PROCEED (exit 0) or STOP (exit 1)');
  process.exit(1);
}

// Fallback red flag patterns (used if AI is unavailable)
const RED_FLAGS = [
  { pattern: /creat(e|ing)\s+(a\s+)?(new\s+)?(repo|repository|service|project)/i,
    severity: 'HIGH', warning: 'Creating new repo/service - can existing be extended?' },
  { pattern: /(this\s+)?should\s+work|let'?s?\s+(just\s+)?try/i,
    severity: 'MEDIUM', warning: 'Untested confidence - do you have evidence?' },
  { pattern: /clean\s*(it\s*)?(this\s*)?up\s+later/i,
    severity: 'MEDIUM', warning: 'Deferred cleanup - do it now' },
  { pattern: /\bI('?m|\s+am)\s+(pretty\s+)?(sure|confident)/i,
    severity: 'MEDIUM', warning: 'Confident without evidence - what proof?' },
  { pattern: /before\s+(writing|running)\s+tests/i,
    severity: 'HIGH', warning: 'Code before tests - write tests first' },
  { pattern: /skip(ping)?\s+(the\s+)?test/i,
    severity: 'HIGH', warning: 'Skipping tests - why?' },
];

async function aiEvaluate(action) {
  try {
    const res = await fetch('https://deja.coey.dev/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    
    if (!res.ok) {
      return null; // Fall back to regex
    }
    
    return await res.json();
  } catch (e) {
    return null; // Fall back to regex
  }
}

function regexEvaluate(action) {
  let highFlags = [];
  let mediumFlags = [];
  
  for (const flag of RED_FLAGS) {
    if (flag.pattern.test(action)) {
      if (flag.severity === 'HIGH') highFlags.push(flag);
      else mediumFlags.push(flag);
    }
  }
  
  if (highFlags.length > 0) {
    return {
      verdict: 'STOP',
      confidence: 0.8,
      reasons: highFlags.map(f => f.warning),
      suggestions: ['Address the red flags before proceeding'],
      fallback: true,
    };
  }
  
  if (mediumFlags.length > 0) {
    return {
      verdict: 'CAUTION',
      confidence: 0.6,
      reasons: mediumFlags.map(f => f.warning),
      suggestions: ['Proceed with awareness'],
      fallback: true,
    };
  }
  
  return {
    verdict: 'PROCEED',
    confidence: 0.5,
    reasons: ['No obvious red flags detected'],
    suggestions: [],
    fallback: true,
  };
}

async function main() {
  console.log(`\n━━━ CHECK: "${action.slice(0, 50)}${action.length > 50 ? '...' : ''}" ━━━\n`);
  
  // Try AI evaluation first
  let result = await aiEvaluate(action);
  
  if (!result) {
    // Fall back to regex
    console.log('📡 AI unavailable, using pattern matching...\n');
    result = regexEvaluate(action);
  } else {
    console.log(`📡 AI evaluation (confidence: ${(result.confidence * 100).toFixed(0)}%)\n`);
  }
  
  // Display result
  const icons = {
    'STOP': '🛑',
    'CAUTION': '⚠️ ',
    'PROCEED': '✅',
  };
  
  console.log(`${icons[result.verdict] || '❓'} ${result.verdict}`);
  
  if (result.reasons && result.reasons.length > 0) {
    console.log('\nReasons:');
    result.reasons.forEach(r => console.log(`   • ${r}`));
  }
  
  if (result.suggestions && result.suggestions.length > 0) {
    console.log('\nSuggestions:');
    result.suggestions.forEach(s => console.log(`   → ${s}`));
  }
  
  if (result.memory_matches) {
    console.log(`\n📋 Memory matches: ${result.memory_matches}`);
  }
  
  console.log('');
  
  // Exit code
  process.exit(result.verdict === 'STOP' ? 1 : 0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
