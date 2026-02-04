export const marketingPage = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>deja — persistent memory for agents</title>
    <meta
      name="description"
      content="deja is an open source Cloudflare Worker that gives agents durable recall. Store, query, and inject learnings with precision."
    />
    <style>
      :root {
        color-scheme: dark;
        --space-indigo: #1b1b3a;
        --velvet-purple: #693668;
        --berry-blush: #a74482;
        --deep-pink: #f84aa7;
        --hot-fuchsia: #ff3562;
        
        --bg: #1b1b3a;
        --bg-elevated: rgba(105, 54, 104, 0.2);
        --bg-glass: rgba(105, 54, 104, 0.3);
        --text: #ffffff;
        --muted: #e5c9e4;
        --accent: #f84aa7;
        --accent-strong: #ff3562;
        --border: rgba(248, 74, 167, 0.15);
        --glow: rgba(248, 74, 167, 0.4);
      }

      * {
        box-sizing: border-box;
      }

      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Playfair+Display:wght@400;700;900&display=swap');

      body {
        margin: 0;
        font-family: "Playfair Display", Georgia, serif;
        background: radial-gradient(1200px 600px at 20% 10%, rgba(248, 74, 167, 0.15), transparent 60%),
          radial-gradient(900px 500px at 90% 0%, rgba(167, 68, 130, 0.1), transparent 70%),
          var(--bg);
        color: var(--text);
        line-height: 1.6;
        letter-spacing: 0.01em;
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      .shell {
        max-width: 1160px;
        margin: 0 auto;
        padding: 0 24px 80px;
      }

      header {
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(14px);
        background: rgba(27, 27, 58, 0.86);
        border-bottom: 1px solid var(--border);
      }

      .nav {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 24px;
      }

      .logo {
        font-family: "JetBrains Mono", monospace;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.32em;
        font-size: 12px;
      }

      .nav-links {
        display: flex;
        gap: 18px;
        font-size: 13px;
        color: var(--muted);
      }

      .hero {
        padding: 96px 0 72px;
        position: relative;
      }

      .title-card {
        border: 1px solid var(--border);
        background: linear-gradient(135deg, rgba(105, 54, 104, 0.4), rgba(27, 27, 58, 0.95));
        border-radius: 24px;
        padding: 48px;
        box-shadow: 0 40px 120px rgba(248, 74, 167, 0.2);
        position: relative;
        overflow: hidden;
      }

      .title-card::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(500px 200px at 20% 0%, rgba(248, 74, 167, 0.3), transparent 70%),
          radial-gradient(600px 400px at 80% 30%, rgba(167, 68, 130, 0.2), transparent 70%);
        opacity: 0.6;
      }

      .title-card-inner {
        position: relative;
        z-index: 1;
      }

      .title {
        font-family: "Playfair Display", serif;
        font-size: clamp(40px, 5vw, 72px);
        font-weight: 700;
        letter-spacing: -0.02em;
        margin: 0 0 12px;
      }

      .title span {
        color: var(--accent);
      }

      .subtitle {
        font-size: 18px;
        color: var(--muted);
        max-width: 640px;
        margin-bottom: 32px;
      }

      .cta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
      }

      .button {
        font-family: "JetBrains Mono", monospace;
        padding: 12px 20px;
        border-radius: 999px;
        font-weight: 600;
        border: 1px solid var(--accent);
        background: linear-gradient(120deg, rgba(248, 74, 167, 0.4), rgba(248, 74, 167, 0.1));
        box-shadow: 0 0 30px var(--glow);
      }

      .button.secondary {
        border-color: var(--border);
        background: rgba(17, 22, 35, 0.6);
        color: var(--muted);
        box-shadow: none;
      }

      section {
        margin-top: 72px;
      }

      .section-title {
        font-family: "JetBrains Mono", monospace;
        font-size: 20px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.28em;
        color: var(--muted);
        margin-bottom: 24px;
      }

      .grid {
        display: grid;
        gap: 24px;
      }

      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }

      .grid.three {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .card {
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 24px;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.02);
      }

      .card h3 {
        font-family: "Playfair Display", serif;
        font-weight: 700;
        margin: 0 0 12px;
        font-size: 20px;
      }

      .card p {
        color: var(--muted);
        margin: 0 0 16px;
      }

      .card ul {
        padding-left: 16px;
        margin: 0;
        color: var(--muted);
      }

      .code-block {
        background: #070a13;
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 16px;
        font-family: "JetBrains Mono", monospace;
        font-size: 13px;
        color: #d8e0ff;
        overflow-x: auto;
        white-space: pre-wrap;
      }

      .progress {
        display: grid;
        gap: 12px;
      }

      .level {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 12px 18px;
        border-radius: 14px;
        background: rgba(248, 74, 167, 0.08);
        border: 1px solid rgba(248, 74, 167, 0.2);
      }

      .level span {
        font-weight: 600;
        color: var(--accent-strong);
      }

      .progress-bar {
        position: relative;
        height: 4px;
        background: rgba(248, 74, 167, 0.15);
        border-radius: 999px;
        overflow: hidden;
        margin-top: 18px;
      }

      .progress-bar::after {
        content: "";
        position: absolute;
        inset: 0;
        width: 45%;
        background: linear-gradient(90deg, rgba(248, 74, 167, 0.3), rgba(255, 53, 98, 0.9));
        animation: glide 6s ease-in-out infinite;
      }

      @keyframes glide {
        0%,
        100% {
          transform: translateX(-40%);
        }
        50% {
          transform: translateX(120%);
        }
      }

      .title-moment {
        text-align: center;
        padding: 64px 24px;
        border-radius: 26px;
        background: linear-gradient(160deg, rgba(248, 74, 167, 0.2), rgba(27, 27, 58, 0.96));
        border: 1px solid var(--border);
        box-shadow: 0 30px 90px rgba(248, 74, 167, 0.3);
      }

      .title-moment h2 {
        font-family: "Playfair Display", serif;
        font-weight: 700;
        margin: 0 0 12px;
        font-size: clamp(32px, 4vw, 52px);
      }
      
      .title-moment .cta-row {
        justify-content: center;
      }
      
      .title-moment .subtitle {
        margin: 0 auto 32px;
      }

      footer {
        margin-top: 80px;
        padding-top: 32px;
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 14px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px 24px;
        justify-content: space-between;
      }

      @media (max-width: 720px) {
        .title-card {
          padding: 32px;
        }

        .cta-row {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="nav shell">
        <div class="logo">deja</div>
        <div class="nav-links">
          <a href="https://github.com/acoyfellow/deja" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/deja" target="_blank" rel="noreferrer">Deploy</a>
          <a href="https://alchemy.run" target="_blank" rel="noreferrer">Alchemy</a>
        </div>
      </div>
    </header>

    <main class="shell">
      <section class="hero">
        <div class="title-card">
          <div class="title-card-inner">
            <div class="logo">Persistent memory for agents</div>
            <h1 class="title">deja, the <span>durable recall</span> layer for Cloudflare Workers.</h1>
            <p class="subtitle">
              Open source memory that outlives a single run. Deja captures what mattered, stores it in your Cloudflare
              account, and feeds it back when agents level up. Precision you can audit. Progress you can feel.
            </p>
            <div class="cta-row">
              <a class="button" href="https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/deja" target="_blank" rel="noreferrer">
                Deploy to Cloudflare
              </a>
              <a class="button secondary" href="https://github.com/acoyfellow/deja#usage" target="_blank" rel="noreferrer">
                Read the API
              </a>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">Two perspectives</div>
        <div class="grid two">
          <div class="card">
            <h3>"Hey agent — install deja. What do you think?"</h3>
            <p>Agents want frictionless memory. Deja gives you a single endpoint to learn, inject, and query.</p>
            <div class="code-block">
              curl -X POST $DEJA_URL/learn
              -H "Authorization: Bearer $API_KEY"
              -H "Content-Type: application/json"
              -d '{"trigger":"deploying","learning":"run wrangler deploy --dry-run","confidence":0.9}'
            </div>
            <ul>
              <li>Post-run recall only — no hidden context.</li>
              <li>Scoped memories by agent, session, or shared.</li>
              <li>Vector search tuned for relevance, not noise.</li>
            </ul>
          </div>
          <div class="card">
            <h3>"I'm a human. I want deja on my Cloudflare account."</h3>
            <p>Humans need ownership. Deja deploys into your account with clear rails and auditable storage.</p>
            <div class="code-block">
              npm install -g wrangler
              wrangler login
              wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine
              wrangler secret put API_KEY
              wrangler deploy
            </div>
            <ul>
              <li>Cloudflare Worker + Durable Objects + Vectorize.</li>
              <li>One worker per user, isolation by architecture.</li>
              <li>Bring your own secrets, revoke at will.</li>
            </ul>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">Use cases</div>
        <div class="grid three">
          <div class="card">
            <h3>Incident response</h3>
            <p>Capture the postmortem as learnings, inject them before the next on-call handoff.</p>
          </div>
          <div class="card">
            <h3>Agent onboarding</h3>
            <p>Give fresh agents the muscle memory of your best runs without flooding them with logs.</p>
          </div>
          <div class="card">
            <h3>Long-running workflows</h3>
            <p>Stitch multi-day work into a single arc. Deja remembers outcomes, not noise.</p>
          </div>
          <div class="card">
            <h3>Tool reliability</h3>
            <p>Teach agents the traps: flaky endpoints, brittle migrations, and safe retries.</p>
          </div>
          <div class="card">
            <h3>Ops playbooks</h3>
            <p>Store the short form. Inject it when the runbook needs to be alive.</p>
          </div>
          <div class="card">
            <h3>Product memory</h3>
            <p>Let agents remember the why, not just the what. Keep decisions tethered.</p>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">Progress feels like leveling up</div>
        <div class="card">
          <div class="progress">
            <div class="level"><span>Level 01</span> Boot sequence: capture the run.</div>
            <div class="level"><span>Level 02</span> Sync: store what mattered, discard the rest.</div>
            <div class="level"><span>Level 03</span> Inject: unlock recall before the next mission.</div>
          </div>
          <div class="progress-bar"></div>
        </div>
      </section>

      <section>
        <div class="section-title">Stack + deployment story</div>
        <div class="grid two">
          <div class="card">
            <h3>Built for Cloudflare</h3>
            <p>Workers for latency, Durable Objects for isolation, Vectorize + Workers AI for recall.</p>
            <ul>
              <li>Hono for routing.</li>
              <li>Drizzle + SQLite for auditability.</li>
              <li>Runs entirely inside your account.</li>
            </ul>
          </div>
          <div class="card">
            <h3>Deploy like it’s 2026</h3>
            <p>Use Wrangler for control, or ship it with Alchemy when you want a modern workflow.</p>
            <div class="code-block">
              npm install -g wrangler
              wrangler deploy
              # or push with Alchemy
              alchemy deploy
            </div>
            <p class="subtitle" style="margin:12px 0 0;">Completion should feel like unlocking something, not finishing a task.</p>
          </div>
        </div>
      </section>

      <section class="title-moment">
        <h2>Unlock durable recall.</h2>
        <p class="subtitle">
          The peak moment is a title card: a new run begins, and everything it needs is already waiting.
        </p>
        <div class="cta-row">
          <a class="button" href="https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/deja" target="_blank" rel="noreferrer">
            Level up with deja
          </a>
        </div>
      </section>

      <footer>
        <div>Open source. MIT licensed. Built for Cloudflare Workers.</div>
      </footer>
    </main>
  </body>
</html>`;
