import json, os, collections

GRADES = os.path.expanduser("~/.deja/experiments/21/grades.jsonl")
rows = [json.loads(line) for line in open(GRADES) if line.strip()]
rows = [row for row in rows if not row.get("error")]
notes = [note for row in rows for note in row["notes"]]


def pct(part, whole):
    return f"{part}/{whole} ({100 * part / whole:.0f}%)" if whole else "0/0"


needed = collections.Counter(row["needed"] for row in rows)
saved = collections.Counter(row["savedWork"] for row in rows)
relevant = sum(note["relevant"] for note in notes)
used = sum(note["used"] for note in notes)
misleading = sum(note["misleading"] for note in notes)
not_needed = [row for row in rows if row["needed"] == "no"]
injections_with_use = sum(any(note["used"] for note in row["notes"]) for row in rows)
projects = collections.Counter(row["project"] for row in rows)
chars = sorted(row["primerChars"] for row in rows)
p95 = chars[int(0.95 * (len(chars) - 1))]
cost = sum(row["cost"] for row in rows)

print("injections graded", len(rows), "projects", len(projects), "notes", len(notes), "grading cost", round(cost, 2))
print("needed", dict(needed))
print("saved work", dict(saved))
print("notes relevant", pct(relevant, len(notes)))
print("notes used", pct(used, len(notes)))
print("notes misleading", pct(misleading, len(notes)))
print("injections where any note was used", pct(injections_with_use, len(rows)))
print("injections into requests that needed no memory", pct(len(not_needed), len(rows)))
print("primer tokens median", chars[len(chars) // 2] // 4, "p95", p95 // 4)
by_needed = collections.defaultdict(lambda: [0, 0])
for row in rows:
    by_needed[row["needed"]][0] += row["savedWork"] == "yes"
    by_needed[row["needed"]][1] += 1
print("saved work by need", {key: f"{a}/{b}" for key, (a, b) in by_needed.items()})
trust = collections.defaultdict(lambda: [0, 0, 0])
inj = {json.loads(l)["key"]: json.loads(l) for l in open(os.path.expanduser("~/.deja/experiments/21/injections.jsonl"))}
for row in rows:
    levels = {n["id"]: n["trust"] for n in inj[row["key"]]["notes"]}
    for note in row["notes"]:
        level = levels.get(note["id"], "?")
        trust[level][0] += 1
        trust[level][1] += note["relevant"]
        trust[level][2] += note["used"]
print("by trust level (n, relevant, used)", {k: tuple(v) for k, v in trust.items()})

SELF_CONTAINED = [
    r'^<skill name="',
    r'^<file name="[^"]*(?:HANDOFF|BRIEF|handoff|brief|task-\d+)[^"]*\.md">',
    r'^(?:Read|Open|read|open) (?:\S*/)?[\w.-]*(?:HANDOFF|BRIEF|Handoff|Brief|handoff|brief)[\w.-]*\.md\b',
    r'^(?:Read|Open|read|open) \S+\.md\b[^\n]{0,120}\b(?:do (?:exactly )?what it says|carry it out|follow it)',
]
import re
skipped = [row for row in rows if any(re.match(p, inj[row["key"]]["prompt"].lstrip()) for p in SELF_CONTAINED)]
kept = [row for row in rows if row not in skipped]
print("self-contained rule would skip", len(skipped), "needed=no among them", sum(r["needed"] == "no" for r in skipped), "saved work lost", sum(r["savedWork"] == "yes" for r in skipped))
print("after rule: injections into no-need requests", pct(sum(r["needed"] == "no" for r in kept), len(kept)))
print("after rule: injections where a note was used", pct(sum(any(n["used"] for n in r["notes"]) for r in kept), len(kept)))
