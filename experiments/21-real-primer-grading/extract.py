import json, os, re, sys, glob, hashlib

SESSIONS = os.path.expanduser("~/.pi/agent/sessions")
OUT = os.path.expanduser("~/.deja/experiments/21/injections.jsonl")
AFTER_CHARS = 6000
PROMPT_CHARS = 4000
NOTE_ID = re.compile(r"^\[(\w+)\]\s+([0-9A-Z]{26})\s", re.M)


def text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "toolCall":
            parts.append("TOOL CALL " + json.dumps(block.get("arguments", {}))[:600])
    return "\n".join(parts)


def project_of(cwd):
    return os.path.basename(cwd.rstrip("/")) or cwd


def injections(path):
    rows = [json.loads(line) for line in open(path) if line.strip()]
    header = rows[0] if rows and rows[0].get("type") == "session" else {}
    cwd = header.get("cwd", "")
    for index, row in enumerate(rows):
        if row.get("type") != "custom_message" or row.get("customType") != "deja-session-primer":
            continue
        prompt = ""
        for back in range(index - 1, -1, -1):
            message = rows[back].get("message", {})
            if rows[back].get("type") == "message" and message.get("role") == "user":
                prompt = text_of(message.get("content"))
                break
        after, used = [], 0
        for forward in rows[index + 1:]:
            message = forward.get("message", {})
            if forward.get("type") == "message" and message.get("role") == "user":
                break
            if forward.get("type") != "message":
                continue
            piece = f"[{message.get('role')}] " + text_of(message.get("content"))
            after.append(piece[: AFTER_CHARS - used])
            used += len(after[-1])
            if used >= AFTER_CHARS:
                break
        primer = row.get("content", "")
        yield {
            "key": hashlib.sha1(f"{path}:{index}".encode()).hexdigest()[:12],
            "session": os.path.basename(path),
            "project": project_of(cwd),
            "timestamp": row.get("timestamp", ""),
            "prompt": prompt[:PROMPT_CHARS],
            "primer": primer,
            "primerChars": len(primer),
            "notes": [{"trust": trust, "id": note_id} for trust, note_id in NOTE_ID.findall(primer)],
            "after": "\n\n".join(after),
        }


def main():
    files = [path for path in glob.glob(f"{SESSIONS}/**/*.jsonl", recursive=True) if '"deja-session-primer"' in open(path, errors="ignore").read()]
    count = 0
    with open(OUT, "w") as out:
        for path in files:
            for row in injections(path):
                out.write(json.dumps(row) + "\n")
                count += 1
    print(count, "injections from", len(files), "sessions ->", OUT)


main()
