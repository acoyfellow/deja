# Memory health loop

An hourly terraloop that runs `scripts/memory-health-tick.sh`, fixes the worst
failing target, and logs one row here. Hidden notes are expired, never purged;
backups live in `~/.deja/backups/` and any note can be brought back by setting
its state to `kept`.

Targets: used share of injected notes at least 30% (24h) · 0 bot recalls in
the last hour · under 20% of kept notes stale (over 60 days, never used) · no
note recalled 20+ times in 14 days by real prompts while never used.

| time (UTC) | used | bots/1h | stale | noisy | streak | action |
|---|---|---|---|---|---|---|
| 2026-11-02 13:05 | 52% ✅ | 40 ❌ | 57% ❌ | 8 ❌ | 0 | Bot leak: eval harness pastes `…/eval/results/…/prompt-N.txt`, which the skip list missed (pi-fresh-session-handoff `dea34d9`), reloaded 20 sessions. Expired the 25 oldest stale notes (Apr 26–27: cloudshell, desk, hardware, early deja goals), backup `20261102T130330Z.db`, ids in `.tmp/batch1.tsv`. Noisy count now ignores bot/replay recalls (10 → 8). |
| 2026-11-02 13:06 | 52% ✅ | 40 ❌ (12:33 burst, before fix) | 54% ❌ | 8 ❌ | 0 | Expired 25 more stale notes (Apr 27–May 1: desk, a0, cloudshell, filepath, exp 29, cf-agent span bug), kept 6 standing rules (MR hygiene, no stubs, "check" = read only, no-call-out, no work-mode prompt). Backup `20261102T130602Z.db`, ids in `.tmp/batch2.tsv`. |
