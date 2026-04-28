# Repo Autopsy ☠️

A Cloudflare Worker that analyzes GitHub repositories and determines if they can be deployed to Cloudflare (Pages, Workers, or Containers). It performs deep static analysis — Dockerfile inspection, CI/CD detection, dependency auditing, framework identification, and Workers API compatibility scoring — then delivers a snarky, data-driven verdict.

**Live:** https://deploy-check.jnara01.workers.dev

---

## Architecture

```
GitHub API → Deep Analyzer → Score Engine → Verdict → Ric Comments → Frontend
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Main UI — dark-mode SPA with animated terminal, score rings, and shareable cards |
| `/api/analyze` | POST | Analyzes a repo URL. Returns score, verdict, deep analysis, migration guide, and commentary |
| `/api/config` | POST | Generates framework-specific `wrangler.toml` / `wrangler.json` configs |
| `/api/share` | POST | Renders an SVG share card with repo name, score, and verdict |

### Analysis Pipeline

1. **File tree scan** — Lists root files via GitHub API to identify stack signals
2. **Content fetch** — Pulls key files (`package.json`, `Dockerfile`, CI configs, framework configs)
3. **Deep analysis** —
   - **Dockerfile**: multi-stage detection, base image, exposed ports, Node version
   - **CI/CD**: platform detection (GitHub Actions, Vercel, Netlify, etc.), Cloudflare deploy check
   - **Dependencies**: total count, server frameworks, build tools, Cloudflare-related packages
   - **Framework**: auto-detects Next.js, SvelteKit, Nuxt, Astro, Remix, etc. + render mode
   - **Workers compatibility**: Node.js API usage scoring, known incompatible dependency scan
   - **Migration signals**: detects current hosting platforms (Vercel, Netlify, Railway, etc.)
4. **Scoring** — weighted rubric across all dimensions (0–100)
5. **Verdict** — maps score + stack to Cloudflare product recommendation
6. **Migration guide** — generates framework-specific migration steps with effort estimation
7. **Ric commentary** — generates persona-driven, data-injected observations

---

## Ric Comment System

The "Ric" persona delivers commentary based on actual repo findings — not generic Mad Libs.

### Design Principles

- **Data-driven**: Comments inject real repo data — repo name, exact score, dependency counts, detected frameworks, CI platforms, Dockerfile details, Node versions, specific compatibility issues
- **Multi-variant**: Score tiers and verdict reactions have 3+ rotating variants. Same-score repos may get different quips on reload
- **Conditional depth**: Comments only appear when their trigger condition is met. A repo with no Dockerfile won't get Dockerfile commentary
- **Specificity over generality**: Instead of "some deps will break," it names the first incompatible dependency found

### Comment Categories

| Category | Triggers | Data Injected |
|----------|----------|---------------|
| **Score reaction** | Score tier (90+/70+/40+/sub-40) | Repo name, exact score |
| **Dockerfile** | Dockerfile detected | Multi-stage flag, Node version, exposed port |
| **CI/CD** | CI config detected | Platform names (GitHub Actions, Vercel...), workflow count |
| **Dependencies** | package.json analyzed | Total count, Cloudflare-related deps detected, server framework name |
| **Workers compat** | Workers score computed | Exact compatibility score, first incompatible API/issue named |
| **Framework** | Framework detected | Config filename, render mode (SSR/SPA/static/ISR), adapter name |
| **Migration** | Migration guide generated | Framework name, effort level, estimated time |
| **Structure** | File tree scanned | File count |
| **Verdict** | Final verdict assigned | Verdict label |

### Example Variation

Two repos scoring 75 will both hit the 70–89 tier, but their comments diverge based on actual findings:

- **Repo A** (Next.js, 45 deps, no Dockerfile, GitHub Actions):  
  *"tollywood-chronicles is a solid B+. Nothing embarrassing here."*  
  *"No Dockerfile detected. Fine for Pages/Workers."*  
  *"Got GitHub Actions CI/CD but no Cloudflare? Branching out, I see."*  
  *"45 dependencies. Hope you trust all of them."*  
  *"Next.js to Cloudflare? Easy money..."*

- **Repo B** (Astro, 8 deps, multi-stage Dockerfile, no CI):  
  *"cricboxd scored 75. Respectable. Could be worse. Could be PHP."*  
  *"Multi-stage Dockerfile (Node 20)? Someone actually read the docs. Respect."*  
  *"Only 8 dependencies. Minimalist. I respect it."*  
  *"Found astro.config.mjs. STATIC mode detected."*  
  *"Astro to Cloudflare? Easy money..."*

---

## Deploy

```bash
npm install
npx wrangler deploy
```

### Environment Variables

| Var | Required | Description |
|-----|----------|-------------|
| `GITHUB_TOKEN` | No | GitHub PAT for higher rate limits and private repo access |

```bash
npx wrangler secret put GITHUB_TOKEN
```

---

## Stack

- **Runtime**: Cloudflare Workers (v8 isolates)
- **Language**: TypeScript
- **Deploy**: Wrangler CLI
- **Frontend**: Vanilla JS + CSS (embedded HTML, no build step)
- **APIs**: GitHub REST API v3

---

## License

MIT
