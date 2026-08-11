#!/usr/bin/env bun
/**
 * Deterministic proof generator for Stage 3 mechanics.
 *
 * Builds an in-memory Deja instance, performs redaction, records a complete
 * paired evidence episode, and emits proof/stage3-mechanics.json. The JSON
 * asserts verified mechanics and explicitly marks model transfer as unproven
 * for this Phase 1 API.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Deja } from "../src/index.ts";

// Pin identifiers and time so the output is byte-for-byte deterministic.
process.env.DEJA_SESSION = "stage3-proof-session";
process.env.DEJA_AUTHOR = "stage3-proof-agent";

const PINNED_TIME = 1_757_000_000_000;
const realNow = Date.now;
Date.now = () => PINNED_TIME;

// Deterministic randomness for ULIDs produced during this script.
let randomByteIndex = 0;
const deterministicBytes = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);
crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
  if (!array) return array;
  const buffer = array as ArrayBufferView;
  const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < view.length; i++) {
    view[i] = deterministicBytes[randomByteIndex % deterministicBytes.length]!;
    randomByteIndex++;
  }
  return array;
};

const d = new Deja({ path: ":memory:", skipGc: true, rawMemoryLocal: true });

// 1. Remember a slip that captures a failure/repair signal.
const slip = d.remember("Stage 3 mechanics: paired ablation requires distinct evidence receipt refs");
d.keep([slip.id], { noChainRollup: true });

// 2. Redact the slip: raw text stays local; portable output is masked.
d.redact(slip.id);

// 3. Record a failure→repair episode.
const episode = d.recordEpisode({
  failureMode: "paired ablation contract validation",
  failureSlipIds: [slip.id],
  repairSlipIds: [slip.id],
  taskClass: "stage3-mechanics",
  failingModel: "model-a",
  repairModel: "model-a",
});

// 4. Add complete paired evaluations with distinct evidence receipt refs.
d.addEpisodeEvaluation(episode.id, {
  caseLabel: "contract-validation",
  pass: true,
  modelId: "model-a",
  ablated: false,
  evaluatedAt: 1_757_000_000_000,
  evidenceReceiptRef: "stage3-ev-with-episode",
});
d.addEpisodeEvaluation(episode.id, {
  caseLabel: "contract-validation",
  pass: false,
  modelId: "model-a",
  ablated: true,
  evaluatedAt: 1_757_000_001_000,
  evidenceReceiptRef: "stage3-ev-ablated",
});

// 5. Generate the ablation receipt.
const receipt = d.ablationReceipt("stage3-mechanics");
if (!receipt) {
  throw new Error("proof generator failed to produce ablation receipt");
}
if (!receipt.mechanicsVerified) {
  throw new Error("proof generator expected mechanicsVerified === true");
}
if (!receipt.modelTransferUnproven) {
  throw new Error("proof generator expected modelTransferUnproven === true");
}
if (!receipt.ablationDemonstrated) {
  throw new Error("proof generator expected ablationDemonstrated === true");
}

d.close();

// 6. Emit the proof artifact.
const output = {
  generatedAt: new Date(1_757_000_002_000).toISOString(),
  modelTransfer: "unproven",
  receipt,
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, "proof", "stage3-mechanics.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${outPath}`);
