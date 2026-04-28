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
| `/api/autofix` | POST | Generates actionable auto-fixes (Dockerfiles, configs, CI workflows) for detected issues |

### Analysis Pipeline

1. **File tree scan** — Lists root files via GitHub API to identify stack signals
2. **Content fetch** — Pulls key files (`package.json`, `Dockerfile`, CI configs, framework configs, `go.mod`, `Cargo.toml`, `requirements.txt`)
3. **Framework detection** — Identifies the framework across 5 languages:
   - **JavaScript**: Next.js, Astro, SvelteKit, Remix, Nuxt, Angular, Vue, Hono, React
   - **Python**: Django, Flask, FastAPI, Tornado, Bottle, Quart
   - **Go**: Gin, Echo, Fiber, Chi, Gorilla Mux
   - **Rust**: Actix Web, Axum, Rocket, Tide, Warp, WASM Workers
   - **Java**: Spring Boot, Quarkus, Micronaut
4. **Deep analysis** —
   - **Dockerfile**: multi-stage detection, base image, exposed ports, Node version, language-specific base images
   - **CI/CD**: platform detection (GitHub Actions, Vercel, Netlify, etc.), Cloudflare deploy check, workflow enumeration
   - **Dependencies**: total count, server frameworks, build tools, Cloudflare-related packages
   - **Framework**: config file detection, render mode (SSR/SPA/static/ISR), adapter detection
   - **Workers compatibility**: Node.js API usage scoring, known incompatible dependency scan
   - **Migration signals**: detects current hosting platforms (Vercel, Netlify, Railway, Fly.io, Render)
5. **Scoring** — language-aware weighted rubric (0–100)
   - JS with Cloudflare adapter → 90+ (Pages/Workers)
   - JS without adapter → checks Workers compatibility score
   - Python/Go/Rust/Java → Containers (Dockerfile bonuses)
   - WASM Rust → Workers
6. **Verdict** — maps score + stack to Cloudflare product recommendation
7. **Migration guide** — generates language/framework-specific migration steps with effort estimation
8. **Ric commentary** — generates persona-driven, data-injected observations
9. **Auto-fix engine** — generates specific code changes to fix detected issues

---

## Framework Detection

| Language | Frameworks | Cloudflare Path |
|----------|-----------|-----------------|
| **JavaScript** | Next.js, Astro, SvelteKit, Remix, Nuxt, Angular, Vue, Hono, React | Pages / Workers |
| **Python** | Django, Flask, FastAPI, Tornado, Bottle, Quart | Containers |
| **Go** | Gin, Echo, Fiber, Chi, Gorilla Mux | Containers |
| **Rust** | Actix Web, Axum, Rocket, Tide, Warp | Containers |
| **Rust (WASM)** | wasm-bindgen workers | Workers |
| **Java** | Spring Boot, Quarkus, Micronaut | Containers |

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
| **Dockerfile** | Dockerfile detected | Multi-stage flag, Node version, exposed port, base image language |
| **CI/CD** | CI config detected | Platform names, workflow count, Cloudflare deploy status |
| **Dependencies** | package.json analyzed | Total count, Cloudflare-related deps detected, server framework name |
| **Workers compat** | Workers score computed | Exact compatibility score, first incompatible API/issue named |
| **Framework** | Framework detected | Config filename, render mode (SSR/SPA/static/ISR), adapter name |
| **Migration** | Migration guide generated | Framework name, effort level, estimated time |
| **Structure** | File tree scanned | File count |
| **Verdict** | Final verdict assigned | Verdict label |

---

## Auto-Fix Engine

`POST /api/autofix` generates actionable fixes for detected issues. Each fix includes:

- **id**: unique identifier for the fix
- **title**: human-readable fix name
- **description**: what the fix does and why
- **file**: target file path
- **current**: existing code to replace (for `replace` actions)
- **replacement**: the new code/config to apply
- **action**: `create` | `replace` | `append`
- **effort**: `easy` | `medium` | `hard`
- **category**: `config` | `docker` | `ci` | `deps` | `code`

### Generated Fixes

| Fix | Trigger | Output |
|-----|---------|--------|
| **Add wrangler.toml** | JS project without wrangler config | Framework-specific `wrangler.toml` with correct `pages_build_output_dir` |
| **Add Dockerfile** | Python/Go/Rust/Java without Dockerfile | Language-specific Dockerfile (multi-stage for Go/Rust) |
| **Add CI/CD workflow** | No `.github/workflows` | GitHub Actions workflow for Pages or Containers |
| **Add Cloudflare adapter** | JS framework without adapter | Install command + config update for Next.js, Astro, SvelteKit, Remix |
| **Optimize Dockerfile** | Single-stage Dockerfile | Multi-stage conversion suggestion |
| **Add .dockerignore** | Dockerfile without `.dockerignore` | Standard `.dockerignore` for smaller builds |

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
