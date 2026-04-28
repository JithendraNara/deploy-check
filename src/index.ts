// Deploy Check v2 - Repo Autopsy
// Analyzes GitHub repos for Cloudflare deployability with cinematic UX

interface Env {
  GITHUB_TOKEN?: string;
}

const CACHE = new Map<string, { data: any; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/analyze' && request.method === 'POST') {
      return handleAnalyze(request, env);
    }
    if (path === '/api/analyze' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (path === '/api/config' && request.method === 'POST') {
      return handleConfigGen(request);
    }
    if (path === '/api/config' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (path === '/api/share' && request.method === 'POST') {
      return handleShareGen(request);
    }
    if (path === '/api/share' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (path === '/api/autofix' && request.method === 'POST') {
      return handleAutoFix(request, env);
    }
    if (path === '/api/autofix' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

interface RepoFile { name: string; type: 'file' | 'dir'; }

interface DeepAnalysis {
  dockerfile?: { detected: boolean; multiStage: boolean; distro: string; exposesPort: boolean; nodeVersion?: string; notes: string[] };
  cicd?: { detected: boolean; platforms: string[]; workflows: string[]; hasCloudflareDeploy: boolean; notes: string[] };
  migrationSignals?: { detected: boolean; platforms: string[]; notes: string[] };
  dependencies?: { total: number; devDeps: number; cloudflareRelated: string[]; serverFrameworks: string[]; buildTools: string[]; notes: string[] };
  workersCompatibility?: { score: number; issues: string[]; warnings: string[] };
  frameworkDetection?: { framework: string; frameworkVersion?: string; language?: string; adapter?: string; configFile?: string; renderMode?: 'ssr' | 'spa' | 'static' | 'isr' | 'unknown'; notes: string[] };
}

interface MigrationGuide {
  framework: string; detectedVersion?: string; fromPlatform?: string; targetProduct: string; productUrl: string;
  effort: 'easy' | 'medium' | 'hard'; adapter?: string; adapterInstall?: string; steps: string[]; configChanges: string[]; gotchas: string[]; docsUrl: string; estimatedTime: string;
}

interface RicComment {
  text: string; tone: 'savage' | 'encouraging' | 'neutral' | 'impressed' | 'concerned';
}

interface AnalyzeResult {
  repo: string; owner: string; repoName: string; score: number;
  verdict: 'pages-static' | 'pages-spa' | 'workers' | 'containers' | 'not-compatible' | 'uncertain';
  verdictLabel: string; verdictColor: string; verdictEmoji: string;
  why: string[]; files: string[]; detectedStack: string; recommendations: string[];
  canAutodeploy: boolean; deepAnalysis: DeepAnalysis; migrationGuide?: MigrationGuide;
  ricComments: RicComment[]; scanLog: string[];
}

function makeGhHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'DeployCheck-Worker-v2',
  };
  if (env.GITHUB_TOKEN) h['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function fetchFileContent(owner: string, repo: string, path: string, env: Env): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers: makeGhHeaders(env) });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data.content ? atob(data.content.replace(/\s/g, '')) : null;
  } catch { return null; }
}

async function fetchDirContents(owner: string, repo: string, path: string, env: Env): Promise<RepoFile[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, { headers: makeGhHeaders(env) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function pickOne<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRicComments(result: AnalyzeResult): RicComment[] {
  const comments: RicComment[] = [];
  const s = result.score;
  const v = result.verdict;
  const d = result.deepAnalysis;
  const repo = result.repoName;
  const files = result.files.length;

  // Score-based reactions (3+ variants each, injected with real data)
  if (s >= 90) {
    comments.push(pickOne([
      { text: `Oh damn. ${repo} is basically begging to be deployed.`, tone: 'impressed' },
      { text: `${repo}? Chef's kiss. This thing is production-ready.`, tone: 'impressed' },
      { text: `Score of ${s}? ${repo} is showing off now.`, tone: 'impressed' },
    ]));
  } else if (s >= 70) {
    comments.push(pickOne([
      { text: `Not bad. I've seen worse. I've seen WAY worse.`, tone: 'encouraging' },
      { text: `${repo} is a solid B+. Nothing embarrassing here.`, tone: 'encouraging' },
      { text: `${s}/100? Respectable. Could be worse. Could be PHP.`, tone: 'encouraging' },
    ]));
  } else if (s >= 40) {
    comments.push(pickOne([
      { text: `Okay, so... we're gonna need to talk about some things.`, tone: 'concerned' },
      { text: `${repo} is giving "it works on my machine" energy.`, tone: 'concerned' },
      { text: `Look, it's not terrible. It's just... not great.`, tone: 'concerned' },
    ]));
  } else {
    comments.push(pickOne([
      { text: `Buddy. Pal. Friend. What are we even doing here?`, tone: 'savage' },
      { text: `${repo} scored ${s}. Out of 100. Let that sink in.`, tone: 'savage' },
      { text: `I've seen abandoned repos with better structure.`, tone: 'savage' },
    ]));
  }

  // Dockerfile observations (specific, data-driven)
  if (d.dockerfile?.detected) {
    const df = d.dockerfile;
    if (df.multiStage) {
      comments.push({ text: `Multi-stage Dockerfile${df.nodeVersion ? ` (Node ${df.nodeVersion})` : ''}? Someone actually read the docs. Respect.`, tone: 'impressed' });
    } else {
      comments.push({ text: `Single-stage Dockerfile. Cute. Like deploying with a parachute made of tissue paper.`, tone: 'savage' });
    }
    if (df.exposesPort && !df.multiStage) {
      comments.push({ text: `Exposes a port but no multi-stage build. Bold.`, tone: 'concerned' });
    }
  } else if (files > 0) {
    comments.push({ text: `No Dockerfile detected. ${s >= 70 ? 'Fine for Pages/Workers.' : 'Might want one for containers.'}`, tone: 'neutral' });
  }

  // CI/CD observations (platform-specific)
  if (d.cicd?.detected) {
    const cicd = d.cicd;
    if (cicd.hasCloudflareDeploy) {
      comments.push({ text: `Already deploying to Cloudflare? You're just showing off now.`, tone: 'impressed' });
    } else if (cicd.platforms.length > 0) {
      const platforms = cicd.platforms.join(', ');
      comments.push({ text: `Got ${platforms} CI/CD but no Cloudflare? Branching out, I see.`, tone: 'neutral' });
      if (cicd.workflows.length > 2) {
        comments.push({ text: `${cicd.workflows.length} workflow files. Someone likes automation.`, tone: 'encouraging' });
      }
    }
  }

  // Migration signals (specific platforms)
  if (d.migrationSignals?.detected) {
    const platforms = d.migrationSignals.platforms;
    comments.push({ text: `Currently squatting on ${platforms.join(' + ')}. Time to upgrade.`, tone: 'savage' });
  }

  // Dependency/framework observations (specific names)
  if (d.dependencies?.serverFrameworks.length) {
    const fw = d.dependencies.serverFrameworks[0];
    comments.push({ text: `${fw}? In ${new Date().getFullYear()}? Bold strategy. Let's see if it pays off.`, tone: 'concerned' });
  }
  if (d.dependencies?.total > 50) {
    comments.push({ text: `${d.dependencies.total} dependencies. Hope you trust all of them.`, tone: 'concerned' });
  } else if (d.dependencies?.total > 0 && d.dependencies.total < 10) {
    comments.push({ text: `Only ${d.dependencies.total} dependencies. Minimalist. I respect it.`, tone: 'impressed' });
  }
  if (d.dependencies?.cloudflareRelated.length) {
    const cfDeps = d.dependencies.cloudflareRelated.slice(0, 3).join(', ');
    comments.push({ text: `Spotted ${cfDeps}. Someone's been reading the Cloudflare docs.`, tone: 'impressed' });
  }

  // Workers compatibility (score-driven, specific issues)
  if (d.workersCompatibility) {
    const wc = d.workersCompatibility;
    if (wc.score >= 80) {
      comments.push({ text: `Workers compatibility is solid. This'll run smoother than my pickup lines.`, tone: 'impressed' });
    } else if (wc.score >= 50) {
      comments.push({ text: `Some Node.js APIs in there. Workers will complain like my mom when I don't call.`, tone: 'concerned' });
    } else if (wc.issues.length > 0) {
      const issue = wc.issues[0];
      comments.push({ text: `Yeah no, ${issue} is gonna throw a tantrum in Workers.`, tone: 'savage' });
    }
  }

  // Framework detection (specific config file + render mode)
  if (d.frameworkDetection?.framework) {
    const fd = d.frameworkDetection;
    if (fd.configFile) {
      comments.push({ text: `Found ${fd.configFile}. ${fd.renderMode ? `${fd.renderMode.toUpperCase()} mode detected.` : ''}`, tone: 'neutral' });
    }
    if (fd.adapter) {
      comments.push({ text: `${fd.adapter} adapter installed. You're halfway to Cloudflare already.`, tone: 'encouraging' });
    }
  }

  // Migration guide (specific effort + framework)
  if (result.migrationGuide) {
    const mg = result.migrationGuide;
    if (mg.effort === 'easy') {
      comments.push({ text: `${mg.framework} to Cloudflare? Easy money. Like stealing candy from a baby. A very technical baby.`, tone: 'encouraging' });
    } else if (mg.effort === 'hard') {
      comments.push({ text: `${mg.framework}? Oh honey. Buckle up. This is gonna hurt... but only a little.`, tone: 'concerned' });
    } else {
      comments.push({ text: `${mg.framework} migration? Doable. Grab some coffee.`, tone: 'neutral' });
    }
    if (mg.estimatedTime) {
      comments.push({ text: `Estimated migration time: ${mg.estimatedTime}. That's... optimistic.`, tone: 'neutral' });
    }
  }

  // File structure observations
  if (files === 0) {
    comments.push({ text: `Couldn't read the file tree. GitHub API said "nah."`, tone: 'savage' });
  } else if (files < 5) {
    comments.push({ text: `Only ${files} files? This is either elegant or abandoned.`, tone: 'concerned' });
  }

  // Final verdict reaction (varied by actual verdict)
  if (v === 'workers' || v === 'pages-static' || v === 'pages-spa') {
    comments.push(pickOne([
      { text: `Verdict? DEPLOY IT. Stop reading and push that button.`, tone: 'impressed' },
      { text: `What are you waiting for? Ship it.`, tone: 'impressed' },
      { text: `${result.verdictLabel} is the move here. Obvious choice.`, tone: 'impressed' },
    ]));
  } else if (v === 'containers') {
    comments.push({ text: `Could work on Containers... but honestly? Just rewrite it. You'll thank me later.`, tone: 'neutral' });
  } else if (v === 'not-compatible') {
    comments.push(pickOne([
      { text: `Look, I'm not saying give up. But maybe... consider a different repo?`, tone: 'savage' },
      { text: `This ain't it, chief.`, tone: 'savage' },
    ]));
  } else if (v === 'uncertain') {
    comments.push({ text: `I honestly don't know what this is. Good luck.`, tone: 'concerned' });
  }

  return comments;
}

function generateScanLog(result: AnalyzeResult): string[] {
  const log: string[] = [];
  const files = result.files;
  
  log.push("> INITIALIZING REPO AUTOPSY v2.0...");
  log.push("> TARGET: " + result.repo);
  log.push("> CONNECTING TO GITHUB API... [OK]");
  log.push("> SCANNING FILESYSTEM... " + files.length + " ENTRIES FOUND");
  
  const keyFiles = files.filter((f: string) => 
    ['package.json', 'Dockerfile', 'wrangler.toml', 'wrangler.json', 'wrangler.jsonc', 
     'vite.config.ts', 'next.config.js', 'tsconfig.json', 'index.html', 'app.py',
     'requirements.txt', 'go.mod', 'Cargo.toml'].includes(f)
  );
  
  keyFiles.forEach((f: string) => {
    const type = f === 'Dockerfile' ? 'CONTAINER_CONFIG' :
                 f.startsWith('wrangler') ? 'WORKER_MANIFEST' :
                 f === 'package.json' ? 'DEPENDENCY_MANIFEST' :
                 f.endsWith('.config.') ? 'BUILD_CONFIG' : 'SOURCE_FILE';
    log.push("> DISCOVERED [" + type + "] " + f);
  });

  if (result.deepAnalysis.dockerfile?.detected) {
    const df = result.deepAnalysis.dockerfile;
    log.push("> ANALYZING DOCKERFILE...");
    log.push(">  |- BASE_IMAGE: " + df.distro);
    log.push(">  |- MULTI_STAGE: " + (df.multiStage ? 'YES' : 'NO'));
    log.push(">  |- EXPOSES_PORT: " + (df.exposesPort ? 'YES' : 'NO'));
  }

  if (result.deepAnalysis.cicd?.detected) {
    log.push("> SCANNING CI/CD PIPELINES...");
    result.deepAnalysis.cicd.platforms.forEach((p: string) => log.push(">  |- PLATFORM: " + p));
  }

  if (result.deepAnalysis.dependencies) {
    const dep = result.deepAnalysis.dependencies;
    log.push("> PARSING DEPENDENCIES... " + dep.total + " PROD, " + dep.devDeps + " DEV");
    if (dep.cloudflareRelated.length) {
      log.push(">  |- CLOUDFLARE_ECOSYSTEM: " + dep.cloudflareRelated.join(', '));
    }
    if (dep.serverFrameworks.length) {
      log.push(">  |- SERVER_FRAMEWORKS: " + dep.serverFrameworks.join(', '));
    }
  }

  log.push("> COMPUTING DEPLOYABILITY SCORE...");
  log.push("> ========================================");
  log.push("> SCORE: " + result.score + "/100");
  log.push("> VERDICT: " + result.verdictLabel.toUpperCase());
  log.push("> ========================================");
  log.push("> AUTOPSY COMPLETE.");

  return log;
}

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  let body: { repoUrl?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const repoUrl = body.repoUrl?.trim() || '';
  if (!repoUrl) return jsonResponse({ error: 'repoUrl is required' }, 400);

  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return jsonResponse({ error: 'Invalid GitHub URL. Use format: https://github.com/owner/repo' }, 400);

  const [, owner, rawRepo] = match;
  const repoName = rawRepo.replace(/\.git$/, '');
  const cacheKey = `${owner}/${repoName}`;

  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return jsonResponse(cached.data);
  }

  try {
    const result = await analyzeRepo(owner, repoName, env);
    result.ricComments = generateRicComments(result);
    result.scanLog = generateScanLog(result);
    CACHE.set(cacheKey, { data: result, ts: Date.now() });
    return jsonResponse(result);
  } catch (err: any) {
    return jsonResponse({ error: err.message || 'Failed to analyze repo' }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework Detectors
// ─────────────────────────────────────────────────────────────────────────────

interface DetectedFramework {
  framework: string;
  frameworkVersion?: string;
  language: string;
  configFile?: string;
  renderMode?: 'ssr' | 'spa' | 'static' | 'isr' | 'unknown';
  adapter?: string;
  notes: string[];
}

async function detectJSFramework(owner: string, repo: string, names: string[], pkg: any, env: Env): Promise<DetectedFramework | null> {
  const allDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const framework: DetectedFramework = { framework: 'Node.js', language: 'javascript', notes: [] };

  if (allDeps['next']) {
    framework.framework = 'Next.js';
    framework.frameworkVersion = allDeps['next'];
    framework.configFile = names.find(n => n.startsWith('next.config')) || undefined;
    framework.renderMode = allDeps['react-dom'] && !allDeps['next']?.includes('static') ? 'ssr' : 'static';
    if (allDeps['@cloudflare/next-on-pages']) { framework.adapter = '@cloudflare/next-on-pages'; framework.notes.push('Cloudflare adapter already installed'); }
    else if (allDeps['vercel']) framework.notes.push('Vercel-optimized Next.js');
  } else if (allDeps['astro']) {
    framework.framework = 'Astro';
    framework.frameworkVersion = allDeps['astro'];
    framework.configFile = names.find(n => n.startsWith('astro.config')) || undefined;
    framework.renderMode = allDeps['@astrojs/node'] ? 'ssr' : 'static';
    if (allDeps['@astrojs/cloudflare']) { framework.adapter = '@astrojs/cloudflare'; framework.notes.push('Cloudflare adapter already installed'); }
  } else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) {
    framework.framework = 'SvelteKit';
    framework.frameworkVersion = allDeps['@sveltejs/kit'] || allDeps['svelte'];
    framework.configFile = names.find(n => n.startsWith('svelte.config')) || undefined;
    framework.renderMode = 'ssr';
    if (allDeps['@sveltejs/adapter-cloudflare']) { framework.adapter = '@sveltejs/adapter-cloudflare'; framework.notes.push('Cloudflare adapter already installed'); }
    else if (allDeps['@sveltejs/adapter-auto']) framework.notes.push('Using adapter-auto');
    else if (allDeps['@sveltejs/adapter-vercel']) framework.notes.push('Currently using Vercel adapter');
  } else if (allDeps['nuxt'] || allDeps['nuxt3']) {
    framework.framework = 'Nuxt';
    framework.frameworkVersion = allDeps['nuxt'] || allDeps['nuxt3'];
    framework.configFile = names.find(n => n.startsWith('nuxt.config')) || undefined;
    framework.renderMode = 'ssr';
    if (allDeps['nitro-cloudflare-dev']) framework.notes.push('Nitro with Cloudflare preset');
  } else if (allDeps['@remix-run/react'] || allDeps['remix']) {
    framework.framework = 'Remix';
    framework.frameworkVersion = allDeps['@remix-run/react'] || allDeps['remix'];
    framework.configFile = names.find(n => n.startsWith('remix.config') || n.startsWith('vite.config')) || undefined;
    framework.renderMode = 'ssr';
    if (allDeps['@remix-run/cloudflare']) { framework.adapter = '@remix-run/cloudflare'; framework.notes.push('Cloudflare adapter already installed'); }
  } else if (allDeps['@angular/core'] || allDeps['angular']) {
    framework.framework = 'Angular';
    framework.frameworkVersion = allDeps['@angular/core'] || allDeps['angular'];
    framework.configFile = names.find(n => n.startsWith('angular.json')) || undefined;
    framework.renderMode = 'spa';
  } else if (allDeps['vue'] || allDeps['vite']) {
    framework.framework = 'Vue/Vite';
    framework.frameworkVersion = allDeps['vite'] || allDeps['vue'];
    framework.configFile = names.find(n => n.startsWith('vite.config')) || undefined;
    framework.renderMode = 'spa';
  } else if (allDeps['react'] && !allDeps['next']) {
    framework.framework = 'React';
    framework.frameworkVersion = allDeps['react'];
    framework.renderMode = 'spa';
    framework.notes.push('Plain React app - may need build config');
  } else if (allDeps['hono']) {
    framework.framework = 'Hono';
    framework.frameworkVersion = allDeps['hono'];
    framework.renderMode = 'ssr';
    framework.notes.push('Hono is Cloudflare-native');
  } else {
    return null;
  }
  return framework;
}

async function detectPythonFramework(owner: string, repo: string, names: string[], env: Env): Promise<DetectedFramework | null> {
  const framework: DetectedFramework = { framework: 'Python', language: 'python', notes: [] };

  // Check requirements.txt
  let reqs = '';
  if (names.includes('requirements.txt')) {
    const content = await fetchFileContent(owner, repo, 'requirements.txt', env);
    if (content) reqs = content.toLowerCase();
  }
  // Check pyproject.toml
  let pyproject = '';
  if (names.includes('pyproject.toml')) {
    const content = await fetchFileContent(owner, repo, 'pyproject.toml', env);
    if (content) pyproject = content.toLowerCase();
  }
  const combined = reqs + pyproject;

  if (combined.includes('django')) {
    framework.framework = 'Django';
    framework.configFile = names.find(n => n === 'manage.py') || undefined;
    framework.notes.push('Django app - needs Containers or ASGI Workers');
  } else if (combined.includes('fastapi')) {
    framework.framework = 'FastAPI';
    framework.configFile = names.find(n => n === 'main.py' || n.endsWith('.py')) || undefined;
    framework.notes.push('FastAPI - excellent for Cloudflare Containers');
  } else if (combined.includes('flask')) {
    framework.framework = 'Flask';
    framework.configFile = names.find(n => n === 'app.py' || n === 'wsgi.py') || undefined;
    framework.notes.push('Flask app - straightforward containerization');
  } else if (combined.includes('tornado') || combined.includes('bottle') || combined.includes('quart')) {
    const fw = combined.includes('tornado') ? 'Tornado' : combined.includes('bottle') ? 'Bottle' : 'Quart';
    framework.framework = fw;
    framework.notes.push(`${fw} - containerize with gunicorn/uvicorn`);
  } else if (names.includes('app.py') || names.includes('main.py') || combined.length > 0) {
    framework.framework = 'Python';
    framework.notes.push('Generic Python app - containerization recommended');
  } else {
    return null;
  }
  return framework;
}

async function detectGoFramework(owner: string, repo: string, names: string[], env: Env): Promise<DetectedFramework | null> {
  const framework: DetectedFramework = { framework: 'Go', language: 'go', notes: [] };

  if (!names.includes('go.mod')) return null;

  const goMod = await fetchFileContent(owner, repo, 'go.mod', env);
  if (!goMod) return framework;

  const content = goMod.toLowerCase();
  if (content.includes('gin-gonic')) {
    framework.framework = 'Gin';
    framework.notes.push('Gin web framework - compile to static binary for Containers');
  } else if (content.includes('echo') || content.includes('labstack')) {
    framework.framework = 'Echo';
    framework.notes.push('Echo framework - lightweight, great for containers');
  } else if (content.includes('fiber')) {
    framework.framework = 'Fiber';
    framework.notes.push('Fiber (Express-inspired) - fast, container-friendly');
  } else if (content.includes('chi')) {
    framework.framework = 'Chi';
    framework.notes.push('Chi router - minimal, container-ready');
  } else if (content.includes('mux') || content.includes('gorilla')) {
    framework.framework = 'Gorilla Mux';
    framework.notes.push('Gorilla toolkit - standard Go HTTP');
  } else {
    framework.framework = 'Go';
    framework.notes.push('Standard Go app - build static binary for Containers');
  }
  return framework;
}

async function detectRustFramework(owner: string, repo: string, names: string[], env: Env): Promise<DetectedFramework | null> {
  const framework: DetectedFramework = { framework: 'Rust', language: 'rust', notes: [] };

  if (!names.includes('Cargo.toml')) return null;

  const cargo = await fetchFileContent(owner, repo, 'Cargo.toml', env);
  if (!cargo) return framework;

  const content = cargo.toLowerCase();
  if (content.includes('actix-web')) {
    framework.framework = 'Actix Web';
    framework.notes.push('Actix Web - high-performance, container-friendly');
  } else if (content.includes('axum')) {
    framework.framework = 'Axum';
    framework.notes.push('Axum (Tokio) - modern Rust web framework');
  } else if (content.includes('rocket')) {
    framework.framework = 'Rocket';
    framework.notes.push('Rocket - compile in release mode for containers');
  } else if (content.includes('tide') || content.includes('warp')) {
    const fw = content.includes('tide') ? 'Tide' : 'Warp';
    framework.framework = fw;
    framework.notes.push(`${fw} - async Rust framework`);
  } else if (content.includes('worker') || content.includes('wasm')) {
    framework.framework = 'Rust (Workers/WASM)';
    framework.notes.push('WASM-compatible Rust - could run on Workers!');
    framework.adapter = 'wasm-bindgen';
  } else {
    framework.framework = 'Rust';
    framework.notes.push('Rust app - compile to static binary for Containers');
  }
  return framework;
}

async function detectJavaFramework(owner: string, repo: string, names: string[], env: Env): Promise<DetectedFramework | null> {
  const framework: DetectedFramework = { framework: 'Java', language: 'java', notes: [] };
  const hasPom = names.includes('pom.xml');
  const hasGradle = names.some(n => n.includes('build.gradle') || n === 'gradlew');

  if (!hasPom && !hasGradle) return null;

  framework.notes.push(hasPom ? 'Maven project' : 'Gradle project');

  if (hasPom) {
    const pom = await fetchFileContent(owner, repo, 'pom.xml', env);
    if (pom) {
      const content = pom.toLowerCase();
      if (content.includes('spring-boot')) {
        framework.framework = 'Spring Boot';
        framework.notes.push('Spring Boot - containerize with Jib or Dockerfile');
      } else if (content.includes('quarkus')) {
        framework.framework = 'Quarkus';
        framework.notes.push('Quarkus - native compilation possible for Containers');
      } else if (content.includes('micronaut')) {
        framework.framework = 'Micronaut';
        framework.notes.push('Micronaut - AOT compilation, container-friendly');
      }
    }
  } else if (hasGradle) {
    const gradle = await fetchFileContent(owner, repo, 'build.gradle', env);
    if (gradle) {
      const content = gradle.toLowerCase();
      if (content.includes('spring')) {
        framework.framework = 'Spring Boot';
        framework.notes.push('Spring Boot with Gradle');
      }
    }
  }

  return framework;
}

function computeWorkersCompatibility(allDeps: Record<string, string>): { score: number; issues: string[]; warnings: string[] } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const deps = Object.keys(allDeps);

  const incompatible = [
    'express', 'koa', 'fastify', 'restify', 'hapi', 'socket.io',
    'node-cron', 'bull', 'agenda', 'node-schedule',
    'sharp', 'bcrypt', 'argon2', 'sqlite3',
    'prisma', '@prisma/client', 'sequelize', 'typeorm',
    'mongoose', 'mongodb', 'pg', 'mysql2',
    'puppeteer', 'playwright', 'selenium-webdriver',
    'canvas', 'node-gd', 'jimp',
    'ffmpeg-static', 'fluent-ffmpeg', 'node-speech',
    'node-pty', 'ssh2', 'telnet-client',
    'dgram', 'net', 'tls', 'child_process', 'cluster',
  ];

  const compatible = [
    'hono', 'itty-router', '@cloudflare/workers-types', 'wrangler',
    'jose', '@tsndr/cloudflare-worker-jwt',
    'drizzle-orm', 'kysely',
    '@neondatabase/serverless', 'postgres',
  ];

  deps.forEach(d => {
    if (incompatible.includes(d)) issues.push(d);
    if (compatible.includes(d)) warnings.push(`${d} is Cloudflare-friendly`);
  });

  // Framework-specific issues
  if (deps.includes('next') && !deps.includes('@cloudflare/next-on-pages')) {
    issues.push('next (needs @cloudflare/next-on-pages adapter)');
  }
  if (deps.includes('react') && !deps.includes('react-dom/server')) {
    warnings.push('React without SSR - may need hydration setup');
  }

  let score = 100;
  score -= issues.length * 12;
  score -= warnings.filter(w => !w.includes('friendly')).length * 5;
  score = Math.max(0, Math.min(100, score));

  return { score, issues, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Analysis
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeRepo(owner: string, repoName: string, env: Env): Promise<AnalyzeResult> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/`;
  const res = await fetch(apiUrl, { headers: makeGhHeaders(env) });

  if (res.status === 404) throw new Error('Repository not found or not public');
  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const resetAt = res.headers.get('x-ratelimit-reset');
      const resetDate = resetAt ? new Date(parseInt(resetAt) * 1000).toLocaleTimeString() : 'soon';
      throw new Error(`GitHub API rate limit hit (resets at ${resetDate}). Add a GITHUB_TOKEN secret to raise the limit.`);
    }
    throw new Error('GitHub API access denied. The repo may be private or require authentication.');
  }
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);

  const files: RepoFile[] = await res.json();
  const names = files.map((f) => f.name);

  const result: AnalyzeResult = {
    repo: `${owner}/${repoName}`, owner, repoName, score: 0,
    verdict: 'uncertain', verdictLabel: 'Uncertain', verdictColor: '#888', verdictEmoji: '?',
    why: [], files: names, detectedStack: 'Unknown', recommendations: [],
    canAutodeploy: false, deepAnalysis: {
      dockerfile: { detected: false, multiStage: false, distro: 'unknown', exposesPort: false, notes: [] },
      cicd: { detected: false, platforms: [], workflows: [], hasCloudflareDeploy: false, notes: [] },
      migrationSignals: { detected: false, platforms: [], notes: [] },
      dependencies: { total: 0, devDeps: 0, cloudflareRelated: [], serverFrameworks: [], buildTools: [], notes: [] },
      workersCompatibility: { score: 0, issues: [], warnings: [] },
      frameworkDetection: { framework: 'Unknown', notes: [] },
    },
    ricComments: [], scanLog: [],
  };

  // ── File existence checks ──
  const hasPackageJson = names.includes('package.json');
  const hasWrangler = names.includes('wrangler.json') || names.includes('wrangler.jsonc') || names.includes('wrangler.toml');
  const hasDockerfile = names.includes('Dockerfile');
  const hasRequirements = names.includes('requirements.txt');
  const hasGoMod = names.includes('go.mod');
  const hasCargo = names.includes('Cargo.toml');
  const hasPom = names.includes('pom.xml');
  const hasGradle = names.some(n => n.includes('build.gradle') || n === 'gradlew');
  const hasPyproject = names.includes('pyproject.toml');
  const hasPipfile = names.includes('Pipfile');

  // ── Fetch package.json for JS projects ──
  let pkg: any = null;
  if (hasPackageJson) {
    try {
      const pkgRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/package.json`, { headers: makeGhHeaders(env) });
      if (pkgRes.ok) { const pkgData: any = await pkgRes.json(); pkg = JSON.parse(atob(pkgData.content)); }
    } catch { /* ignore */ }
  }

  const deps = pkg?.dependencies || {};
  const devDeps = pkg?.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };

  // ── Detect language & framework ──
  let detectedFw: DetectedFramework | null = null;

  if (hasPackageJson) {
    detectedFw = await detectJSFramework(owner, repoName, names, pkg, env);
  } else if (hasRequirements || hasPyproject || hasPipfile || names.some(n => n.endsWith('.py'))) {
    detectedFw = await detectPythonFramework(owner, repoName, names, env);
  } else if (hasGoMod) {
    detectedFw = await detectGoFramework(owner, repoName, names, env);
  } else if (hasCargo) {
    detectedFw = await detectRustFramework(owner, repoName, names, env);
  } else if (hasPom || hasGradle) {
    detectedFw = await detectJavaFramework(owner, repoName, names, env);
  }

  if (detectedFw) {
    result.detectedStack = detectedFw.framework;
    result.deepAnalysis.frameworkDetection = {
      framework: detectedFw.framework,
      frameworkVersion: detectedFw.frameworkVersion,
      language: detectedFw.language,
      configFile: detectedFw.configFile,
      renderMode: detectedFw.renderMode,
      adapter: detectedFw.adapter,
      notes: detectedFw.notes,
    };
    result.why.push(`Detected ${detectedFw.framework} (${detectedFw.language})`);
  }

  // ── Dockerfile analysis ──
  if (hasDockerfile) {
    const dockerContent = await fetchFileContent(owner, repoName, 'Dockerfile', env);
    if (dockerContent) {
      const d = result.deepAnalysis.dockerfile!;
      d.detected = true;
      d.multiStage = /FROM\s+\S+.*AS\s+\w+/i.test(dockerContent);
      const fromMatch = dockerContent.match(/FROM\s+(\S+)/i);
      d.distro = fromMatch ? fromMatch[1] : 'unknown';
      d.exposesPort = /EXPOSE\s+\d+/i.test(dockerContent);
      const nodeMatch = dockerContent.match(/node:?(\d+)/i);
      d.nodeVersion = nodeMatch ? nodeMatch[1] : undefined;
      if (d.multiStage) d.notes.push('Multi-stage build detected');
      if (d.distro.includes('alpine')) d.notes.push('Alpine-based - minimal');
      if (d.distro.includes('python')) d.notes.push('Python base image');
      if (d.distro.includes('golang')) d.notes.push('Go base image');
      if (d.distro.includes('rust')) d.notes.push('Rust base image');
    }
  }

  // ── CI/CD detection ──
  const hasGithubActions = names.includes('.github');
  if (hasGithubActions) {
    const cicd = result.deepAnalysis.cicd!;
    cicd.detected = true;
    cicd.platforms.push('GitHub Actions');
    // Check for workflow files
    const workflows = await fetchDirContents(owner, repoName, '.github/workflows', env);
    cicd.workflows = workflows.map(w => w.name);
    // Check if any workflow references Cloudflare
    for (const wf of workflows.slice(0, 3)) {
      const content = await fetchFileContent(owner, repoName, `.github/workflows/${wf.name}`, env);
      if (content) {
        if (content.includes('cloudflare') || content.includes('wrangler') || content.includes('pages.dev')) {
          cicd.hasCloudflareDeploy = true;
          break;
        }
      }
    }
  }

  // Check for other CI configs
  if (names.includes('vercel.json')) {
    result.deepAnalysis.cicd!.detected = true;
    result.deepAnalysis.cicd!.platforms.push('Vercel');
    result.deepAnalysis.migrationSignals!.detected = true;
    result.deepAnalysis.migrationSignals!.platforms.push('Vercel');
  }
  if (names.includes('netlify.toml')) {
    result.deepAnalysis.cicd!.detected = true;
    result.deepAnalysis.cicd!.platforms.push('Netlify');
    result.deepAnalysis.migrationSignals!.detected = true;
    result.deepAnalysis.migrationSignals!.platforms.push('Netlify');
  }
  if (names.includes('railway.json') || names.includes('railway.yaml')) {
    result.deepAnalysis.migrationSignals!.detected = true;
    result.deepAnalysis.migrationSignals!.platforms.push('Railway');
  }
  if (names.includes('fly.toml')) {
    result.deepAnalysis.migrationSignals!.detected = true;
    result.deepAnalysis.migrationSignals!.platforms.push('Fly.io');
  }
  if (names.includes('render.yaml')) {
    result.deepAnalysis.migrationSignals!.detected = true;
    result.deepAnalysis.migrationSignals!.platforms.push('Render');
  }

  // ── Dependency analysis (JS only for now) ──
  const depAnalysis = result.deepAnalysis.dependencies!;
  if (hasPackageJson) {
    depAnalysis.total = Object.keys(deps).length;
    depAnalysis.devDeps = Object.keys(devDeps).length;

    const cloudflareDeps = ['wrangler', '@cloudflare/workers-types', 'hono', 'itty-router', '@cloudflare/pages-plugin-', 'next-on-pages'];
    cloudflareDeps.forEach((cd: string) => {
      Object.keys(allDeps).forEach(d => { if (d.includes(cd.replace(/-$/, ''))) depAnalysis.cloudflareRelated.push(d); });
    });

    const serverFrameworks = ['express', 'fastify', 'koa', 'hapi', 'restify', 'nestjs', 'sails', 'feathers'];
    serverFrameworks.forEach((sf: string) => { if (allDeps[sf]) depAnalysis.serverFrameworks.push(sf); });

    const buildTools = ['vite', 'webpack', 'rollup', 'esbuild', 'parcel', 'turbo'];
    buildTools.forEach((bt: string) => { if (allDeps[bt] || devDeps[bt]) depAnalysis.buildTools.push(bt); });

    // Workers compatibility
    result.deepAnalysis.workersCompatibility = computeWorkersCompatibility(allDeps);
  }

  // ── Scoring & Verdict ──
  let baseScore = 50;

  // Already configured for Cloudflare?
  if (hasWrangler) {
    baseScore = 95;
    result.verdict = 'workers';
    result.verdictLabel = 'Cloudflare Workers';
    result.verdictColor = '#f97316'; result.verdictEmoji = '⚡';
    result.canAutodeploy = true;
    result.why.push('wrangler config detected');
    result.recommendations.push('Run `wrangler deploy` to deploy instantly');
  }
  // Has Dockerfile - Containers candidate
  else if (hasDockerfile) {
    baseScore = 70;
    result.verdict = 'containers';
    result.verdictLabel = 'Cloudflare Containers';
    result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
    result.why.push('Dockerfile found - ready for containerization');
    result.recommendations.push('Build and push to Cloudflare Container Registry');
    result.recommendations.push('Create a Container deployment with `wrangler`');
    if (detectedFw) {
      result.detectedStack = `${detectedFw.framework} (Containerized)`;
    }
  }
  // JS framework detected
  else if (detectedFw?.language === 'javascript') {
    const fw = detectedFw.framework;
    const hasAdapter = !!detectedFw.adapter;
    const wc = result.deepAnalysis.workersCompatibility;

    if (hasAdapter) {
      baseScore = 90;
      result.verdict = 'pages-static';
      result.verdictLabel = 'Cloudflare Pages';
      result.verdictColor = '#3b82f6'; result.verdictEmoji = '🚀';
      result.canAutodeploy = true;
      result.why.push(`${fw} with Cloudflare adapter installed`);
      result.recommendations.push('Run `wrangler pages deploy` to deploy');
    } else if (wc.score >= 80) {
      baseScore = 80;
      result.verdict = 'workers';
      result.verdictLabel = 'Cloudflare Workers';
      result.verdictColor = '#f97316'; result.verdictEmoji = '⚡';
      result.canAutodeploy = true;
      result.why.push(`${fw} is Workers-compatible (score: ${wc.score})`);
      result.recommendations.push('Add Cloudflare adapter and deploy');
    } else if (wc.score >= 50) {
      baseScore = 65;
      result.verdict = 'pages-spa';
      result.verdictLabel = 'Cloudflare Pages (SPA)';
      result.verdictColor = '#3b82f6'; result.verdictEmoji = '🚀';
      result.canAutodeploy = true;
      result.why.push(`${fw} can run on Pages with some adjustments`);
      result.recommendations.push('Install Cloudflare adapter for your framework');
    } else {
      baseScore = 40;
      result.verdict = 'containers';
      result.verdictLabel = 'Cloudflare Containers';
      result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
      result.why.push(`${fw} has Workers compatibility issues`);
      result.recommendations.push('Containerize this app for Cloudflare Containers');
      result.recommendations.push('Or migrate to a Cloudflare-native framework like Hono');
    }
  }
  // Python detected
  else if (detectedFw?.language === 'python') {
    baseScore = hasDockerfile ? 75 : 50;
    result.verdict = 'containers';
    result.verdictLabel = 'Cloudflare Containers';
    result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
    result.why.push(`${detectedFw.framework} app - best on Containers`);
    if (!hasDockerfile) {
      result.recommendations.push('Add a Dockerfile for containerization');
      result.recommendations.push('Use gunicorn/uvicorn as the entrypoint');
    } else {
      result.recommendations.push('Build container and deploy to Cloudflare');
    }
  }
  // Go detected
  else if (detectedFw?.language === 'go') {
    baseScore = hasDockerfile ? 80 : 55;
    result.verdict = 'containers';
    result.verdictLabel = 'Cloudflare Containers';
    result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
    result.why.push(`${detectedFw.framework} app - compile to static binary`);
    if (!hasDockerfile) {
      result.recommendations.push('Add a multi-stage Dockerfile (build with golang:latest, run with scratch/alpine)');
    }
    result.recommendations.push('Use `CGO_ENABLED=0` for static binary');
  }
  // Rust detected
  else if (detectedFw?.language === 'rust') {
    baseScore = hasDockerfile ? 80 : 55;
    if (detectedFw.adapter === 'wasm-bindgen') {
      result.verdict = 'workers';
      result.verdictLabel = 'Cloudflare Workers (WASM)';
      result.verdictColor = '#f97316'; result.verdictEmoji = '⚡';
      baseScore = 85;
      result.why.push('WASM-compatible Rust - can run on Workers');
      result.recommendations.push('Use `wasm-pack` to build for Workers');
    } else {
      result.verdict = 'containers';
      result.verdictLabel = 'Cloudflare Containers';
      result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
      result.why.push(`${detectedFw.framework} app - compile in release mode`);
      if (!hasDockerfile) {
        result.recommendations.push('Add a multi-stage Dockerfile with rust:slim');
      }
    }
  }
  // Java detected
  else if (detectedFw?.language === 'java') {
    baseScore = hasDockerfile ? 70 : 45;
    result.verdict = 'containers';
    result.verdictLabel = 'Cloudflare Containers';
    result.verdictColor = '#a855f7'; result.verdictEmoji = '📦';
    result.why.push(`${detectedFw.framework} app - JRE-based containerization`);
    if (!hasDockerfile) {
      result.recommendations.push('Add Dockerfile with Eclipse Temurin or Amazon Corretto base');
    }
  }
  // Fallback: has package.json but no framework detected
  else if (hasPackageJson) {
    baseScore = 60;
    result.verdict = 'pages-spa';
    result.verdictLabel = 'Cloudflare Pages (SPA)';
    result.verdictColor = '#3b82f6'; result.verdictEmoji = '🚀';
    result.detectedStack = 'Node.js';
    result.why.push('package.json detected');
    result.canAutodeploy = true;
    result.recommendations.push('Configure build command in Pages settings');
  }
  // Truly unknown
  else {
    baseScore = 20;
    result.verdict = 'uncertain';
    result.verdictLabel = 'Uncertain';
    result.verdictColor = '#888'; result.verdictEmoji = '?';
    result.why.push('Could not determine stack');
    result.recommendations.push('Add a README with stack details');
  }

  // Adjust score based on Dockerfile quality
  if (hasDockerfile && result.deepAnalysis.dockerfile?.multiStage) {
    baseScore += 5;
  }

  // Adjust score based on CI/CD presence
  if (result.deepAnalysis.cicd?.detected) {
    baseScore += 5;
  }

  result.score = Math.min(100, Math.max(0, baseScore));

  result.migrationGuide = buildMigrationGuide(result.deepAnalysis, result.detectedStack, pkg);
  result.ricComments = generateRicComments(result);
  result.scanLog = generateScanLog(result);

  return result;
}

function buildMigrationGuide(deep: DeepAnalysis, stack: string, pkg: any): MigrationGuide | undefined {
  if (stack === 'Cloudflare Worker') return undefined;

  const today = new Date().toISOString().split('T')[0];
  const fd = deep.frameworkDetection;
  const fw = fd?.framework || stack;
  const language = fd?.language || 'javascript';

  // Python guides
  if (language === 'python') {
    const pyFw = fw.toLowerCase();
    const steps = ['Create a Dockerfile with your Python framework', 'Use a slim base image (python:3.11-slim)', 'Install dependencies from requirements.txt', 'Set up gunicorn/uvicorn as the entrypoint', 'Build and deploy to Cloudflare Containers'];
    const gotchas = ['Ensure all deps are in requirements.txt', 'Use environment variables for config', 'Health check endpoint recommended'];
    if (pyFw.includes('django')) {
      steps.splice(2, 0, 'Run collectstatic before serving');
      gotchas.push('Django needs STATIC_ROOT and MEDIA_ROOT configured');
    }
    return {
      framework: fw, targetProduct: 'Cloudflare Containers', productUrl: 'https://developers.cloudflare.com/containers',
      effort: 'medium', estimatedTime: '30 min',
      steps, configChanges: ['Add Dockerfile', 'Create requirements.txt if missing'], gotchas,
      docsUrl: 'https://developers.cloudflare.com/containers',
    };
  }

  // Go guides
  if (language === 'go') {
    return {
      framework: fw, targetProduct: 'Cloudflare Containers', productUrl: 'https://developers.cloudflare.com/containers',
      effort: 'easy', estimatedTime: '20 min',
      steps: ['Create multi-stage Dockerfile', 'Build stage: golang:latest with CGO_ENABLED=0', 'Runtime stage: scratch or alpine', 'Copy static binary to runtime stage', 'Expose port and set CMD', 'Build and deploy to Cloudflare Containers'],
      configChanges: ['Add Dockerfile', 'Ensure go.mod is tidy'], gotchas: ['CGO_ENABLED=0 is required for scratch images', 'Use distroless or alpine for smaller images'],
      docsUrl: 'https://developers.cloudflare.com/containers',
    };
  }

  // Rust guides
  if (language === 'rust') {
    if (fd?.adapter === 'wasm-bindgen') {
      return {
        framework: fw, targetProduct: 'Cloudflare Workers (WASM)', productUrl: 'https://developers.cloudflare.com/workers',
        effort: 'hard', estimatedTime: '2 hours',
        steps: ['Install wasm-pack', 'Configure wasm-bindgen for Workers', 'Build with wasm-pack build --target web', 'Set up wrangler.toml with wasm_module', 'Deploy with wrangler deploy'],
        configChanges: ['Add wrangler.toml with wasm_module path', 'Configure Cargo.toml for wasm32 target'], gotchas: ['Not all Rust crates compile to WASM', 'Avoid std::fs and std::net in WASM'],
        docsUrl: 'https://developers.cloudflare.com/workers/languages/rust',
      };
    }
    return {
      framework: fw, targetProduct: 'Cloudflare Containers', productUrl: 'https://developers.cloudflare.com/containers',
      effort: 'medium', estimatedTime: '30 min',
      steps: ['Create multi-stage Dockerfile with rust:slim', 'Build in release mode: cargo build --release', 'Runtime stage: debian:stable-slim or alpine', 'Copy binary from target/release/', 'Expose port and deploy'],
      configChanges: ['Add Dockerfile', 'Ensure Cargo.lock is committed'], gotchas: ['Alpine needs musl target (x86_64-unknown-linux-musl)', 'Release builds take longer but run faster'],
      docsUrl: 'https://developers.cloudflare.com/containers',
    };
  }

  // Java guides
  if (language === 'java') {
    return {
      framework: fw, targetProduct: 'Cloudflare Containers', productUrl: 'https://developers.cloudflare.com/containers',
      effort: 'medium', estimatedTime: '45 min',
      steps: ['Create Dockerfile with Eclipse Temurin or Amazon Corretto JRE', 'Copy JAR or WAR file to container', 'Set JAVA_OPTS for containerized environment', 'Expose application port', 'Build and deploy to Cloudflare Containers'],
      configChanges: ['Add Dockerfile', 'Configure Maven/Gradle to build fat JAR'], gotchas: ['Use JRE not JDK for smaller images', 'Consider GraalVM native image for smaller footprint'],
      docsUrl: 'https://developers.cloudflare.com/containers',
    };
  }

  // JS framework guides
  const fwLower = fw.toLowerCase();
  if (fwLower.includes('next.js')) {
    return {
      framework: 'Next.js', targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
      effort: 'easy', adapter: '@cloudflare/next-on-pages', adapterInstall: 'npm install @cloudflare/next-on-pages',
      estimatedTime: '20 min',
      steps: ['Install @cloudflare/next-on-pages', 'Update next.config.js with output: "export"', 'Add wrangler.toml', 'Run npx @cloudflare/next-on-pages@latest', 'Deploy with wrangler pages deploy'],
      configChanges: [`name = "my-next-app"\ncompatibility_date = "${today}"\npages_build_output_dir = ".vercel/output/static"`],
      gotchas: ['API routes need @cloudflare/next-on-pages', 'Some Node.js APIs are not available'], docsUrl: 'https://developers.cloudflare.com/pages/framework-guides/nextjs/',
    };
  }
  if (fwLower.includes('astro')) {
    return {
      framework: 'Astro', targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
      effort: 'easy', adapter: '@astrojs/cloudflare', adapterInstall: 'npx astro add cloudflare',
      estimatedTime: '15 min',
      steps: ['Run npx astro add cloudflare', 'Update astro.config.mjs', 'Add wrangler.toml', 'Build with astro build', 'Deploy with wrangler pages deploy'],
      configChanges: [`name = "my-astro-site"\ncompatibility_date = "${today}"\npages_build_output_dir = "dist"`],
      gotchas: ['SSR mode requires @astrojs/cloudflare adapter', 'Node APIs not available in Workers'], docsUrl: 'https://docs.astro.build/en/guides/integrations-guide/cloudflare/',
    };
  }
  if (fwLower.includes('sveltekit')) {
    return {
      framework: 'SvelteKit', targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
      effort: 'easy', adapter: '@sveltejs/adapter-cloudflare', adapterInstall: 'npm install -D @sveltejs/adapter-cloudflare',
      estimatedTime: '15 min',
      steps: ['Install @sveltejs/adapter-cloudflare', 'Update svelte.config.js', 'Add wrangler.toml', 'Build and deploy with wrangler'],
      configChanges: [`name = "my-sveltekit-app"\ncompatibility_date = "${today}"\npages_build_output_dir = ".svelte-kit/cloudflare"`],
      gotchas: ['Replace @sveltejs/adapter-auto if present', 'Check for Node-only dependencies'], docsUrl: 'https://kit.svelte.dev/docs/adapter-cloudflare',
    };
  }
  if (fwLower.includes('remix')) {
    return {
      framework: 'Remix', targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
      effort: 'easy', adapter: '@remix-run/cloudflare', adapterInstall: 'npm install @remix-run/cloudflare',
      estimatedTime: '20 min',
      steps: ['Install @remix-run/cloudflare', 'Update remix.config.js', 'Add wrangler.toml', 'Build and deploy'],
      configChanges: [`name = "my-remix-app"\ncompatibility_date = "${today}"`],
      gotchas: ['Some Node APIs need polyfills', 'Cloudflare KV for session storage'], docsUrl: 'https://remix.run/docs/en/main/guides/cloudflare',
    };
  }
  if (fwLower.includes('nuxt')) {
    return {
      framework: 'Nuxt', targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
      effort: 'easy', adapter: 'nitro-cloudflare-dev', adapterInstall: 'npm install -D nitro-cloudflare-dev',
      estimatedTime: '15 min',
      steps: ['Install nitro-cloudflare-dev', 'Update nuxt.config.ts with nitro preset', 'Add wrangler.toml', 'Build with nuxt build', 'Deploy with wrangler'],
      configChanges: [`name = "my-nuxt-app"\ncompatibility_date = "${today}"\npages_build_output_dir = ".output/public"`],
      gotchas: ['Use cloudflare_pages nitro preset', 'Check for Node-only modules'], docsUrl: 'https://nitro.unjs.io/deploy/providers/cloudflare',
    };
  }

  // Default JS guide
  return {
    framework: stack, targetProduct: 'Cloudflare Pages', productUrl: 'https://pages.dev',
    effort: 'easy', estimatedTime: '15 min',
    steps: ['Install Wrangler CLI', 'Run wrangler pages project create', 'Configure build command', 'Deploy'],
    configChanges: [`name = "my-app"\ncompatibility_date = "${today}"\n\n[build]\ncommand = "npm run build"`], gotchas: ['Check Node.js compatibility'],
    docsUrl: 'https://developers.cloudflare.com/pages',
  };
}

async function handleConfigGen(request: Request): Promise<Response> {
  let body: { repoUrl?: string; framework?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { framework } = body;
  if (!framework) return jsonResponse({ error: 'framework required' }, 400);

  let config = '';
  let filename = '';
  const today = new Date().toISOString().split('T')[0];
  const fwLower = framework.toLowerCase();

  switch (fwLower) {
    case 'next.js':
      filename = 'wrangler.jsonc';
      config = `{\n  "name": "my-next-app",\n  "compatibility_date": "${today}",\n  "pages_build_output_dir": ".vercel/output/static"\n}`;
      break;
    case 'astro':
      filename = 'wrangler.jsonc';
      config = `{\n  "name": "my-astro-site",\n  "compatibility_date": "${today}",\n  "pages_build_output_dir": "dist"\n}`;
      break;
    case 'sveltekit':
      filename = 'wrangler.jsonc';
      config = `{\n  "name": "my-sveltekit-app",\n  "compatibility_date": "${today}",\n  "pages_build_output_dir": ".svelte-kit/cloudflare"\n}`;
      break;
    case 'remix':
      filename = 'wrangler.jsonc';
      config = `{\n  "name": "my-remix-app",\n  "compatibility_date": "${today}",\n  "pages_build_output_dir": "public"\n}`;
      break;
    case 'nuxt':
      filename = 'wrangler.jsonc';
      config = `{\n  "name": "my-nuxt-app",\n  "compatibility_date": "${today}",\n  "pages_build_output_dir": ".output/public"\n}`;
      break;
    case 'django':
      filename = 'Dockerfile';
      config = `FROM python:3.11-slim\n\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\nEXPOSE 8000\n\nCMD ["gunicorn", "--bind", "0.0.0.0:8000", "myproject.wsgi:application"]`;
      break;
    case 'fastapi':
      filename = 'Dockerfile';
      config = `FROM python:3.11-slim\n\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\nEXPOSE 8000\n\nCMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`;
      break;
    case 'flask':
      filename = 'Dockerfile';
      config = `FROM python:3.11-slim\n\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\nEXPOSE 5000\n\nCMD ["gunicorn", "--bind", "0.0.0.0:5000", "app:app"]`;
      break;
    case 'gin':
    case 'echo':
    case 'fiber':
    case 'chi':
    case 'go':
      filename = 'Dockerfile';
      config = `# Build stage\nFROM golang:1.22-alpine AS builder\nWORKDIR /app\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 GOOS=linux go build -o main .\n\n# Runtime stage\nFROM alpine:latest\nRUN apk --no-cache add ca-certificates\nWORKDIR /root/\nCOPY --from=builder /app/main .\nEXPOSE 8080\nCMD ["./main"]`;
      break;
    case 'actix web':
    case 'axum':
    case 'rocket':
    case 'rust':
      filename = 'Dockerfile';
      config = `# Build stage\nFROM rust:1.75-slim AS builder\nWORKDIR /app\nCOPY Cargo.toml Cargo.lock ./\nCOPY src ./src\nRUN cargo build --release\n\n# Runtime stage\nFROM debian:bookworm-slim\nWORKDIR /app\nCOPY --from=builder /app/target/release/myapp ./\nEXPOSE 8080\nCMD ["./myapp"]`;
      break;
    case 'spring boot':
    case 'java':
      filename = 'Dockerfile';
      config = `FROM eclipse-temurin:21-jre-alpine\n\nWORKDIR /app\nCOPY target/*.jar app.jar\n\nEXPOSE 8080\nENTRYPOINT ["java", "-jar", "app.jar"]`;
      break;
    default:
      filename = 'wrangler.toml';
      config = `name = "my-app"\ncompatibility_date = "${today}"\n\n[build]\ncommand = "npm run build"`;
  }

  return jsonResponse({ filename, config });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Fix Engine
// ─────────────────────────────────────────────────────────────────────────────

interface AutoFix {
  id: string;
  title: string;
  description: string;
  file: string;
  current?: string;
  replacement: string;
  action: 'create' | 'replace' | 'append';
  effort: 'easy' | 'medium' | 'hard';
  category: 'config' | 'docker' | 'ci' | 'deps' | 'code';
}

async function handleAutoFix(request: Request, env: Env): Promise<Response> {
  let body: { repoUrl?: string; finding?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { repoUrl, finding } = body;
  if (!repoUrl) return jsonResponse({ error: 'repoUrl required' }, 400);

  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return jsonResponse({ error: 'Invalid GitHub URL' }, 400);
  const [, owner, rawRepo] = match;
  const repoName = rawRepo.replace(/\.git$/, '');

  // Run analysis to get full context
  const result = await analyzeRepo(owner, repoName, env);
  const fixes: AutoFix[] = [];
  const fd = result.deepAnalysis.frameworkDetection;
  const today = new Date().toISOString().split('T')[0];

  // Fix 1: Missing wrangler config for JS projects
  if (fd?.language === 'javascript' && !result.files.some(f => f.startsWith('wrangler'))) {
    const fw = fd.framework;
    let wranglerConfig = '';
    let buildDir = 'dist';
    if (fw === 'Next.js') buildDir = '.vercel/output/static';
    else if (fw === 'Astro') buildDir = 'dist';
    else if (fw === 'SvelteKit') buildDir = '.svelte-kit/cloudflare';
    else if (fw === 'Nuxt') buildDir = '.output/public';
    else if (fw === 'Remix') buildDir = 'public';

    wranglerConfig = `name = "${repoName}"\ncompatibility_date = "${today}"\npages_build_output_dir = "${buildDir}"`;

    fixes.push({
      id: 'add-wrangler-config',
      title: 'Add wrangler.toml for Cloudflare deployment',
      description: `Create wrangler.toml with ${fw}-specific build output directory`,
      file: 'wrangler.toml',
      replacement: wranglerConfig,
      action: 'create',
      effort: 'easy',
      category: 'config',
    });
  }

  // Fix 2: Missing Dockerfile for non-JS projects
  if ((fd?.language === 'python' || fd?.language === 'go' || fd?.language === 'rust' || fd?.language === 'java') && !result.deepAnalysis.dockerfile?.detected) {
    const lang = fd.language;
    const fw = fd.framework;
    let dockerfile = '';

    if (lang === 'python') {
      const entry = fw === 'FastAPI' ? 'uvicorn main:app --host 0.0.0.0 --port 8000' : fw === 'Flask' ? 'gunicorn --bind 0.0.0.0:5000 app:app' : 'python app.py';
      dockerfile = `FROM python:3.11-slim\n\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\nEXPOSE 8000\n\nCMD ["${entry.split(' ').join('", "')}"]`;
    } else if (lang === 'go') {
      dockerfile = `FROM golang:1.22-alpine AS builder\nWORKDIR /app\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 GOOS=linux go build -o main .\n\nFROM alpine:latest\nRUN apk --no-cache add ca-certificates\nWORKDIR /root/\nCOPY --from=builder /app/main .\nEXPOSE 8080\nCMD ["./main"]`;
    } else if (lang === 'rust') {
      dockerfile = `FROM rust:1.75-slim AS builder\nWORKDIR /app\nCOPY Cargo.toml Cargo.lock ./\nCOPY src ./src\nRUN cargo build --release\n\nFROM debian:bookworm-slim\nWORKDIR /app\nCOPY --from=builder /app/target/release/${repoName} ./\nEXPOSE 8080\nCMD ["./${repoName}"]`;
    } else if (lang === 'java') {
      dockerfile = `FROM eclipse-temurin:21-jre-alpine\n\nWORKDIR /app\nCOPY target/*.jar app.jar\n\nEXPOSE 8080\nENTRYPOINT ["java", "-jar", "app.jar"]`;
    }

    fixes.push({
      id: 'add-dockerfile',
      title: `Add Dockerfile for ${fw || lang}`,
      description: `Containerize your ${fw || lang} app for Cloudflare Containers`,
      file: 'Dockerfile',
      replacement: dockerfile,
      action: 'create',
      effort: 'easy',
      category: 'docker',
    });
  }

  // Fix 3: Missing CI/CD for Cloudflare
  if (!result.deepAnalysis.cicd?.hasCloudflareDeploy && !result.files.includes('.github')) {
    const lang = fd?.language || 'javascript';
    let workflow = '';

    if (lang === 'javascript') {
      workflow = `name: Deploy to Cloudflare Pages\n\non:\n  push:\n    branches: [main]\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n      - run: npm ci\n      - run: npm run build\n      - name: Deploy to Cloudflare\n        uses: cloudflare/pages-action@v1\n        with:\n          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n          accountId: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n          projectName: ${repoName}\n          directory: dist`;
    } else {
      workflow = `name: Deploy to Cloudflare Containers\n\non:\n  push:\n    branches: [main]\n\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Build container\n        run: docker build -t ${repoName} .\n      - name: Deploy to Cloudflare\n        run: echo "Add your Cloudflare container deploy command here"`;
    }

    fixes.push({
      id: 'add-ci-cd',
      title: 'Add GitHub Actions workflow for Cloudflare deploy',
      description: `Automated deployment on every push to main`,
      file: '.github/workflows/deploy.yml',
      replacement: workflow,
      action: 'create',
      effort: 'medium',
      category: 'ci',
    });
  }

  // Fix 4: Missing Cloudflare adapter for JS frameworks
  if (fd?.language === 'javascript' && fd.framework && !fd.adapter) {
    const fw = fd.framework;
    let adapterName = '';
    let adapterInstall = '';
    let configUpdate = '';

    if (fw === 'Next.js') {
      adapterName = '@cloudflare/next-on-pages';
      adapterInstall = 'npm install @cloudflare/next-on-pages';
      configUpdate = '// next.config.js\nmodule.exports = {\n  output: "export",\n};';
    } else if (fw === 'Astro') {
      adapterName = '@astrojs/cloudflare';
      adapterInstall = 'npx astro add cloudflare';
      configUpdate = '// astro.config.mjs\nimport cloudflare from "@astrojs/cloudflare";\nexport default defineConfig({\n  output: "server",\n  adapter: cloudflare(),\n});';
    } else if (fw === 'SvelteKit') {
      adapterName = '@sveltejs/adapter-cloudflare';
      adapterInstall = 'npm install -D @sveltejs/adapter-cloudflare';
      configUpdate = '// svelte.config.js\nimport adapter from "@sveltejs/adapter-cloudflare";\nexport default {\n  kit: { adapter: adapter() }\n};';
    } else if (fw === 'Remix') {
      adapterName = '@remix-run/cloudflare';
      adapterInstall = 'npm install @remix-run/cloudflare';
    }

    if (adapterName) {
      fixes.push({
        id: 'add-cloudflare-adapter',
        title: `Install ${adapterName} for ${fw}`,
        description: `Add Cloudflare adapter to make ${fw} deployable on Pages/Workers`,
        file: 'package.json',
        replacement: `${adapterInstall}\n${configUpdate}`,
        action: 'append',
        effort: 'medium',
        category: 'deps',
      });
    }
  }

  // Fix 5: Single-stage Dockerfile → multi-stage
  if (result.deepAnalysis.dockerfile?.detected && !result.deepAnalysis.dockerfile.multiStage) {
    fixes.push({
      id: 'optimize-dockerfile',
      title: 'Convert Dockerfile to multi-stage build',
      description: 'Multi-stage builds reduce image size and attack surface',
      file: 'Dockerfile',
      replacement: '# See migration guide for multi-stage Dockerfile template',
      action: 'replace',
      effort: 'medium',
      category: 'docker',
    });
  }

  // Fix 6: Missing .dockerignore
  if (result.deepAnalysis.dockerfile?.detected && !result.files.includes('.dockerignore')) {
    fixes.push({
      id: 'add-dockerignore',
      title: 'Add .dockerignore to reduce image size',
      description: 'Exclude node_modules, .git, and build artifacts from Docker context',
      file: '.dockerignore',
      replacement: 'node_modules\n.git\n.env\n*.log\ndist\nbuild\n.DS_Store',
      action: 'create',
      effort: 'easy',
      category: 'docker',
    });
  }

  return jsonResponse({ repo: result.repo, fixes });
}

async function handleShareGen(request: Request): Promise<Response> {
  let body: { repo?: string; score?: number; verdict?: string; color?: string };
  try { body = await request.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const { repo = 'unknown/repo', score = 0, verdict = 'Unknown', color = '#888' } = body;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0a0a0f"/>
        <stop offset="100%" stop-color="#1a1a2e"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
        <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="1200" height="630" fill="url(#bg)"/>
    <text x="600" y="180" text-anchor="middle" fill="#888" font-family="monospace" font-size="24">REPO AUTOPSY</text>
    <text x="600" y="280" text-anchor="middle" fill="#fff" font-family="-apple-system, sans-serif" font-size="72" font-weight="800">${repo}</text>
    <text x="600" y="360" text-anchor="middle" fill="${color}" font-family="-apple-system, sans-serif" font-size="48" font-weight="700">${verdict}</text>
    <circle cx="600" cy="480" r="80" fill="none" stroke="${color}" stroke-width="8" filter="url(#glow)"/>
    <text x="600" y="495" text-anchor="middle" fill="${color}" font-family="-apple-system, sans-serif" font-size="48" font-weight="800">${score}</text>
    <text x="600" y="520" text-anchor="middle" fill="#888" font-family="monospace" font-size="16">DEPLOYABILITY SCORE</text>
    <text x="600" y="580" text-anchor="middle" fill="#444" font-family="monospace" font-size="14">deploy-check.jnara01.workers.dev</text>
  </svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}


const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Repo Autopsy - Can it run on Cloudflare?</title>
  <meta property="og:title" content="Repo Autopsy">
  <meta property="og:description" content="Drop a GitHub repo. I'll dissect it for Cloudflare deployability.">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #050508;
      --surface: #0c0c14;
      --surface-2: #141420;
      --border: #1e1e2e;
      --text: #e2e2e8;
      --text-dim: #6e6e80;
      --accent: #f97316;
      --green: #22c55e;
      --blue: #3b82f6;
      --red: #ef4444;
      --purple: #a855f7;
      --yellow: #eab308;
      --cyan: #06b6d4;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }

    @keyframes scanline {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(100vh); }
    }
    @keyframes flicker {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.97; }
      52% { opacity: 1; }
      55% { opacity: 0.98; }
    }
    @keyframes glitch {
      0% { transform: translate(0); }
      20% { transform: translate(-2px, 2px); }
      40% { transform: translate(-2px, -2px); }
      60% { transform: translate(2px, 2px); }
      80% { transform: translate(2px, -2px); }
      100% { transform: translate(0); }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 20px var(--accent)33; }
      50% { box-shadow: 0 0 40px var(--accent)55; }
    }
    @keyframes countUp {
      from { opacity: 0; transform: scale(0.5); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateX(-20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
      position: relative;
    }

    .scanline-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 1000;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,0,0,0.03) 2px,
        rgba(0,0,0,0.03) 4px
      );
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
      position: relative;
      z-index: 1;
    }

    .header {
      text-align: center;
      margin-bottom: 60px;
      animation: flicker 4s infinite;
    }
    .header h1 {
      font-size: 3rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #fff 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 12px;
    }
    .header .tagline {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
      font-size: 0.9rem;
    }
    .header .tagline::before {
      content: '> ';
      color: var(--accent);
    }

    .input-section { margin-bottom: 40px; }
    .input-wrap {
      display: flex;
      gap: 12px;
      position: relative;
    }
    .input-wrap input {
      flex: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      color: var(--text);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.95rem;
      outline: none;
      transition: all 0.3s;
    }
    .input-wrap input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent)22;
    }
    .input-wrap input::placeholder { color: #444; }

    .analyze-btn {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 16px 32px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.3s;
      position: relative;
      overflow: hidden;
    }
    .analyze-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px var(--accent)44;
    }
    .analyze-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .analyze-btn .btn-text {
      display: inline-block;
      transition: transform 0.3s;
    }

    .terminal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
      margin-bottom: 30px;
      display: none;
      animation: fadeIn 0.5s ease;
    }
    .terminal.visible { display: block; }
    .terminal-header {
      background: var(--surface-2);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--border);
    }
    .terminal-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .terminal-dot.red { background: var(--red); }
    .terminal-dot.yellow { background: var(--yellow); }
    .terminal-dot.green { background: var(--green); }
    .terminal-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-dim);
      margin-left: 8px;
    }
    .terminal-body {
      padding: 20px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      line-height: 1.8;
      max-height: 400px;
      overflow-y: auto;
    }
    .terminal-line {
      opacity: 0;
      animation: fadeIn 0.1s ease forwards;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-line.cyan { color: var(--cyan); }
    .terminal-line.green { color: var(--green); }
    .terminal-line.yellow { color: var(--yellow); }
    .terminal-line.red { color: var(--red); }
    .terminal-line.accent { color: var(--accent); }

    .verdict-section {
      display: none;
      text-align: center;
      margin-bottom: 40px;
      animation: fadeIn 0.8s ease;
    }
    .verdict-section.visible { display: block; }
    .score-display {
      position: relative;
      display: inline-block;
      margin-bottom: 24px;
    }
    .score-ring {
      width: 200px;
      height: 200px;
      border-radius: 50%;
      border: 8px solid var(--border);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      animation: pulse-glow 2s infinite;
    }
    .score-ring .score-number {
      font-size: 4rem;
      font-weight: 800;
      line-height: 1;
      transition: color 0.5s;
    }
    .score-ring .score-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-dim);
      margin-top: 8px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .verdict-emoji {
      font-size: 3rem;
      margin-bottom: 16px;
      animation: countUp 0.5s ease;
    }
    .verdict-text {
      font-size: 2rem;
      font-weight: 800;
      margin-bottom: 8px;
      animation: glitch 0.3s ease;
    }
    .verdict-stack {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
      font-size: 0.9rem;
    }

    .ric-section {
      display: none;
      margin-bottom: 30px;
    }
    .ric-section.visible { display: block; }
    .ric-bubble {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 12px;
      position: relative;
      animation: slideIn 0.4s ease;
      border-left: 4px solid var(--accent);
    }
    .ric-bubble.tone-savage { border-left-color: var(--red); }
    .ric-bubble.tone-encouraging { border-left-color: var(--green); }
    .ric-bubble.tone-impressed { border-left-color: var(--purple); }
    .ric-bubble.tone-concerned { border-left-color: var(--yellow); }
    .ric-bubble::before {
      content: 'RIC';
      position: absolute;
      top: -10px;
      left: 16px;
      background: var(--bg);
      padding: 2px 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 0.1em;
    }
    .ric-bubble.tone-savage::before { color: var(--red); }
    .ric-bubble.tone-encouraging::before { color: var(--green); }
    .ric-bubble.tone-impressed::before { color: var(--purple); }
    .ric-bubble.tone-concerned::before { color: var(--yellow); }

    .content-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 20px;
      margin-bottom: 30px;
    }
    @media (min-width: 768px) {
      .content-grid { grid-template-columns: 1fr 1fr; }
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      transition: all 0.3s;
    }
    .card:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
    }
    .card h3 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-dim);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card ul { list-style: none; }
    .card li {
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.9rem;
      line-height: 1.5;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .card li:last-child { border: none; }
    .card li::before {
      content: attr(data-icon);
      flex-shrink: 0;
      font-size: 1rem;
    }

    .files-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .file-tag {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.8rem;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
      transition: all 0.2s;
      cursor: default;
    }
    .file-tag:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .file-tag.highlight {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent)11;
    }

    .deep-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 16px;
      margin-bottom: 30px;
    }
    .deep-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      position: relative;
      overflow: hidden;
    }
    .deep-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--border);
    }
    .deep-card.status-yes::before { background: var(--green); }
    .deep-card.status-no::before { background: var(--red); }
    .deep-card.status-warn::before { background: var(--yellow); }
    .deep-card h4 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-dim);
      margin-bottom: 12px;
    }
    .deep-card .status {
      font-size: 1.1rem;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .deep-card .status.yes { color: var(--green); }
    .deep-card .status.no { color: var(--red); }
    .deep-card .status.warn { color: var(--yellow); }
    .deep-card .tag {
      display: inline-block;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 3px 10px;
      font-size: 0.75rem;
      margin: 3px 3px 0 0;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    .migration-section {
      display: none;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 30px;
      margin-bottom: 30px;
    }
    .migration-section.visible {
      display: block;
      animation: fadeIn 0.6s ease;
    }
    .migration-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .effort-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .effort-badge.easy {
      background: var(--green)22;
      color: var(--green);
      border: 1px solid var(--green)44;
    }
    .effort-badge.medium {
      background: var(--yellow)22;
      color: var(--yellow);
      border: 1px solid var(--yellow)44;
    }
    .effort-badge.hard {
      background: var(--red)22;
      color: var(--red);
      border: 1px solid var(--red)44;
    }
    .time-badge {
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
    }
    .code-block {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85rem;
      overflow-x: auto;
      margin: 16px 0;
      position: relative;
    }
    .code-block .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .code-block .copy-btn:hover {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .steps-list {
      counter-reset: step;
      list-style: none;
    }
    .steps-list li {
      counter-increment: step;
      padding: 16px 0 16px 48px;
      position: relative;
      border-bottom: 1px solid var(--border);
    }
    .steps-list li::before {
      content: counter(step);
      position: absolute;
      left: 0;
      top: 16px;
      width: 32px;
      height: 32px;
      background: var(--accent);
      color: #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.85rem;
    }
    .steps-list li:last-child { border: none; }
    .gotcha-item {
      display: flex;
      gap: 12px;
      padding: 12px 0;
      color: var(--yellow);
      font-size: 0.9rem;
    }
    .gotcha-item .icon {
      flex-shrink: 0;
      font-size: 1.2rem;
    }

    .action-bar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 24px;
    }
    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      border-radius: 12px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      text-decoration: none;
    }
    .action-btn:hover {
      transform: translateY(-2px);
      border-color: var(--accent);
    }
    .action-btn.primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .action-btn.primary:hover {
      box-shadow: 0 8px 25px var(--accent)44;
    }

    .share-section {
      display: none;
      text-align: center;
      margin-bottom: 30px;
    }
    .share-section.visible { display: block; }
    .share-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 30px;
      max-width: 600px;
      margin: 0 auto;
    }
    .share-preview {
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      border-radius: 12px;
      padding: 40px;
      margin-bottom: 20px;
      text-align: center;
    }
    .share-preview h4 {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
      font-size: 0.8rem;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .share-preview .share-repo {
      font-size: 1.8rem;
      font-weight: 800;
      color: #fff;
      margin-bottom: 12px;
      word-break: break-all;
    }
    .share-preview .share-verdict {
      font-size: 1.2rem;
      font-weight: 700;
      margin-bottom: 20px;
    }
    .share-preview .share-score-circle {
      width: 120px;
      height: 120px;
      border-radius: 50%;
      border: 6px solid;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      margin: 0 auto;
    }
    .share-preview .share-score-num {
      font-size: 2.5rem;
      font-weight: 800;
    }
    .share-preview .share-score-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.65rem;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .examples {
      text-align: center;
      margin-top: 40px;
    }
    .examples h3 {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 16px;
      letter-spacing: 0.1em;
    }
    .example-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 8px 18px;
      margin: 4px;
      font-size: 0.85rem;
      color: var(--text-dim);
      cursor: pointer;
      transition: all 0.3s;
      font-family: 'JetBrains Mono', monospace;
    }
    .example-chip:hover {
      border-color: var(--accent);
      color: var(--text);
      transform: translateY(-2px);
    }
    .example-chip .chip-icon {
      font-size: 1rem;
    }

    .footer {
      text-align: center;
      margin-top: 60px;
      padding-top: 30px;
      border-top: 1px solid var(--border);
      color: #444;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem;
    }
    .footer a {
      color: var(--text-dim);
      text-decoration: none;
    }
    .footer a:hover {
      color: var(--accent);
    }

    .error {
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid var(--red);
      color: var(--red);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      font-family: 'JetBrains Mono', monospace;
      display: none;
    }
    .error.visible {
      display: block;
      animation: fadeIn 0.3s ease;
    }

    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }
  </style>
</head>
<body>
  <div class="scanline-overlay"></div>

  <div class="container">
    <div class="header">
      <h1>REPO AUTOPSY</h1>
      <p class="tagline">Drop a GitHub repo. I'll dissect it for Cloudflare deployability.</p>
    </div>

    <div class="input-section">
      <div class="input-wrap">
        <input type="text" id="repoUrl" placeholder="https://github.com/owner/repo"
          onkeydown="if(event.key==='Enter') analyze()">
        <button class="analyze-btn" id="btn" onclick="analyze()">
          <span class="btn-text">AUTOPSY</span>
        </button>
      </div>
    </div>

    <div class="error" id="error"></div>

    <div class="terminal" id="terminal">
      <div class="terminal-header">
        <div class="terminal-dot red"></div>
        <div class="terminal-dot yellow"></div>
        <div class="terminal-dot green"></div>
        <span class="terminal-title">repo-autopsy - zsh</span>
      </div>
      <div class="terminal-body" id="terminalBody"></div>
    </div>

    <div class="verdict-section" id="verdictSection">
      <div class="verdict-emoji" id="verdictEmoji"></div>
      <div class="score-display">
        <div class="score-ring" id="scoreRing">
          <div class="score-number" id="scoreNumber">0</div>
          <div class="score-label">Deployable</div>
        </div>
      </div>
      <div class="verdict-text" id="verdictText"></div>
      <div class="verdict-stack" id="verdictStack"></div>
    </div>

    <div class="ric-section" id="ricSection"></div>

    <div class="content-grid" id="contentGrid" style="display:none;">
      <div class="card">
        <h3>Why</h3>
        <ul id="whyList"></ul>
      </div>
      <div class="card">
        <h3>Recommendations</h3>
        <ul id="recList"></ul>
      </div>
    </div>

    <div class="deep-grid" id="deepGrid" style="display:none;"></div>

    <div class="migration-section" id="migrationSection"></div>

    <div class="card" id="filesCard" style="display:none;">
      <h3>Files Detected</h3>
      <div class="files-grid" id="filesGrid"></div>
    </div>

    <div class="share-section" id="shareSection">
      <div class="share-card">
        <div class="share-preview" id="sharePreview"></div>
        <div class="action-bar">
          <button class="action-btn" onclick="downloadShare()">Download Card</button>
          <button class="action-btn" onclick="copyShareUrl()">Copy URL</button>
          <a class="action-btn primary" id="tweetBtn" href="#" target="_blank">Tweet This</a>
        </div>
      </div>
    </div>

    <div class="examples">
      <h3>Try These</h3>
      <span class="example-chip" onclick="setRepo('https://github.com/cloudflare/workers-sdk')">
        <span class="chip-icon">*</span> workers-sdk
      </span>
      <span class="example-chip" onclick="setRepo('https://github.com/vercel/next-learn')">
        <span class="chip-icon">^</span> next-learn
      </span>
      <span class="example-chip" onclick="setRepo('https://github.com/withastro/starlight')">
        <span class="chip-icon">@</span> starlight
      </span>
      <span class="example-chip" onclick="setRepo('https://github.com/sveltejs/realworld')">
        <span class="chip-icon">#</span> svelte-realworld
      </span>
    </div>

    <div class="footer">
      Built by <a href="https://github.com/JithendraNara">Jithendra Nara</a> -
      <a href="https://deploy-check.jnara01.workers.dev">deploy-check.jnara01.workers.dev</a>
    </div>
  </div>

  <script>
    let currentResult = null;

    function setRepo(url) {
      document.getElementById('repoUrl').value = url;
      analyze();
    }

    async function analyze() {
      const input = document.getElementById('repoUrl').value.trim();
      const btn = document.getElementById('btn');
      const terminal = document.getElementById('terminal');
      const terminalBody = document.getElementById('terminalBody');
      const error = document.getElementById('error');

      if (!input) return;

      btn.disabled = true;
      btn.querySelector('.btn-text').textContent = 'SCANNING...';
      error.classList.remove('visible');
      document.getElementById('verdictSection').classList.remove('visible');
      document.getElementById('ricSection').classList.remove('visible');
      document.getElementById('contentGrid').style.display = 'none';
      document.getElementById('deepGrid').style.display = 'none';
      document.getElementById('migrationSection').classList.remove('visible');
      document.getElementById('filesCard').style.display = 'none';
      document.getElementById('shareSection').classList.remove('visible');

      terminal.classList.add('visible');
      terminalBody.innerHTML = '<div class="terminal-line accent">> INITIALIZING REPO AUTOPSY v2.0...</div>';

      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl: input }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);
        currentResult = data;

        const log = data.scanLog || [];
        terminalBody.innerHTML = '';
        
        for (let i = 0; i < log.length; i++) {
          await new Promise(r => setTimeout(r, 80));
          const line = log[i];
          let colorClass = '';
          if (line.includes('[OK]') || line.includes('COMPUTE') || line.includes('COMPLETE')) colorClass = 'green';
          else if (line.includes('SCORE:') || line.includes('VERDICT:')) colorClass = 'accent';
          else if (line.includes('FOUND')) colorClass = 'cyan';
          else if (line.includes('ERROR') || line.includes('FAIL')) colorClass = 'red';
          
          const div = document.createElement('div');
          div.className = 'terminal-line ' + colorClass;
          div.style.animationDelay = '0s';
          div.textContent = line;
          terminalBody.appendChild(div);
          terminalBody.scrollTop = terminalBody.scrollHeight;
        }

        await new Promise(r => setTimeout(r, 500));

        const vs = document.getElementById('verdictSection');
        vs.classList.add('visible');
        document.getElementById('verdictEmoji').textContent = data.verdictEmoji;
        document.getElementById('verdictText').textContent = data.verdictLabel;
        document.getElementById('verdictText').style.color = data.verdictColor;
        document.getElementById('verdictStack').textContent = data.detectedStack;

        const scoreEl = document.getElementById('scoreNumber');
        const ring = document.getElementById('scoreRing');
        ring.style.borderColor = data.verdictColor;
        scoreEl.style.color = data.verdictColor;
        
        let currentScore = 0;
        const targetScore = data.score;
        const increment = targetScore / 30;
        const scoreInterval = setInterval(() => {
          currentScore += increment;
          if (currentScore >= targetScore) {
            currentScore = targetScore;
            clearInterval(scoreInterval);
          }
          scoreEl.textContent = Math.round(currentScore);
        }, 50);

        await new Promise(r => setTimeout(r, 800));
        const ricSection = document.getElementById('ricSection');
        ricSection.innerHTML = '';
        ricSection.classList.add('visible');
        
        const comments = data.ricComments || [];
        for (let i = 0; i < Math.min(comments.length, 4); i++) {
          await new Promise(r => setTimeout(r, 400));
          const c = comments[i];
          const bubble = document.createElement('div');
          bubble.className = 'ric-bubble tone-' + c.tone;
          bubble.textContent = c.text;
          bubble.style.animationDelay = '0s';
          ricSection.appendChild(bubble);
        }

        await new Promise(r => setTimeout(r, 300));
        document.getElementById('contentGrid').style.display = 'grid';
        
        const whyList = document.getElementById('whyList');
        whyList.innerHTML = data.why.map(w => '<li data-icon=">">' + w + '</li>').join('');
        
        const recList = document.getElementById('recList');
        recList.innerHTML = data.recommendations.map(r => '<li data-icon="+">' + r + '</li>').join('');

        const d = data.deepAnalysis || {};
        const deepHtml = [];

        if (d.dockerfile) {
          const df = d.dockerfile;
          deepHtml.push(makeDeepCard('Dockerfile', df.detected ? 'Detected' : 'Not found', df.detected ? 'yes' : 'no', df.notes, df.detected ? [df.distro, df.multiStage ? 'multi-stage' : 'single-stage'] : []));
        }
        if (d.cicd) {
          const ci = d.cicd;
          deepHtml.push(makeDeepCard('CI/CD', ci.detected ? ci.platforms.join(', ') : 'None', ci.detected ? 'yes' : 'no', ci.notes, ci.workflows.slice(0, 3)));
        }
        if (d.dependencies) {
          const dep = d.dependencies;
          deepHtml.push(makeDeepCard('Dependencies', dep.total + ' prod, ' + dep.devDeps + ' dev', dep.serverFrameworks.length ? 'warn' : 'yes', dep.notes, [...dep.cloudflareRelated.slice(0, 3), ...dep.buildTools.slice(0, 2)]));
        }
        if (d.workersCompatibility) {
          const wc = d.workersCompatibility;
          deepHtml.push(makeDeepCard('Workers Compat', 'Score: ' + wc.score + '/100', wc.score >= 70 ? 'yes' : wc.score >= 40 ? 'warn' : 'no', [...wc.issues, ...wc.warnings].slice(0, 4), []));
        }

        if (deepHtml.length) {
          document.getElementById('deepGrid').innerHTML = deepHtml.join('');
          document.getElementById('deepGrid').style.display = 'grid';
        }

        const mg = data.migrationGuide;
        if (mg) {
          const migSection = document.getElementById('migrationSection');
          migSection.classList.add('visible');
          migSection.innerHTML = makeMigrationHtml(mg);
        }

        const filesCard = document.getElementById('filesCard');
        filesCard.style.display = 'block';
        const highlights = ['package.json','wrangler.json','wrangler.jsonc','wrangler.toml','index.html','Dockerfile','vite.config.ts','next.config.js','tsconfig.json'];
        document.getElementById('filesGrid').innerHTML = data.files.map(function(f) {
          const hl = highlights.includes(f) ? 'highlight' : '';
          return '<span class="file-tag ' + hl + '">' + f + '</span>';
        }).join('');

        if (data.score > 0) {
          document.getElementById('shareSection').classList.add('visible');
          updateSharePreview(data);
        }

      } catch (err) {
        error.textContent = err.message;
        error.classList.add('visible');
      } finally {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'AUTOPSY';
      }
    }

    function makeDeepCard(title, status, statusClass, items, tags) {
      const tagHtml = tags.length ? tags.map(function(t) { return '<span class="tag">' + t + '</span>'; }).join('') : '';
      const listHtml = items.length ? '<ul>' + items.map(function(i) { return '<li>' + i + '</li>'; }).join('') + '</ul>' : '';
      return '<div class="deep-card status-' + statusClass + '"><h4>' + title + '</h4><div class="status ' + statusClass + '">' + status + '</div>' + tagHtml + listHtml + '</div>';
    }

    function makeMigrationHtml(mg) {
      const effortColor = mg.effort === 'easy' ? 'var(--green)' : mg.effort === 'medium' ? 'var(--yellow)' : 'var(--red)';
      let html = '<div class="migration-header">';
      html += '<span class="effort-badge ' + mg.effort + '">' + mg.effort + ' effort</span>';
      html += '<span class="time-badge">~' + mg.estimatedTime + '</span>';
      html += '</div>';
      
      if (mg.adapter) {
        html += '<div class="code-block"><button class="copy-btn" onclick="copyCode(this)">Copy</button><div>npm install ' + mg.adapter + '</div></div>';
      }
      
      html += '<h4 style="font-size:0.8rem;text-transform:uppercase;color:var(--text-dim);margin-bottom:16px;letter-spacing:0.1em;">Migration Steps</h4>';
      html += '<ol class="steps-list">' + mg.steps.map(function(s) { return '<li>' + s + '</li>'; }).join('') + '</ol>';
      
      if (mg.configChanges.length) {
        html += '<h4 style="font-size:0.8rem;text-transform:uppercase;color:var(--text-dim);margin:24px 0 16px;letter-spacing:0.1em;">Config Changes</h4>';
        html += mg.configChanges.map(function(c) { return '<div class="code-block"><button class="copy-btn" onclick="copyCode(this)">Copy</button>' + c + '</div>'; }).join('');
      }
      
      if (mg.gotchas.length) {
        html += '<h4 style="font-size:0.8rem;text-transform:uppercase;color:var(--text-dim);margin:24px 0 16px;letter-spacing:0.1em;">Gotchas</h4>';
        html += mg.gotchas.map(function(g) { return '<div class="gotcha-item"><span class="icon">!</span><span>' + g + '</span></div>'; }).join('');
      }
      
      html += '<div class="action-bar">';
      html += '<a class="action-btn" href="' + mg.docsUrl + '" target="_blank">Read Docs</a>';
      html += '<button class="action-btn" data-framework="' + mg.framework + '" onclick="generateConfig(this.dataset.framework)">Generate Config</button>';
      html += '</div>';
      
      return html;
    }

    function copyCode(btn) {
      const code = btn.nextElementSibling.textContent;
      navigator.clipboard.writeText(code).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 2000);
      });
    }

    async function generateConfig(framework) {
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ framework }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:30px;max-width:600px;width:100%;max-height:80vh;overflow:auto;"><h3 style="margin-bottom:16px;font-size:1.2rem;">' + data.filename + '</h3><div class="code-block" style="margin:0;"><button class="copy-btn" onclick="copyCode(this)">Copy</button><pre style="margin:0;white-space:pre-wrap;">' + data.config + '</pre></div><button class="cfg-close-btn" style="margin-top:16px;padding:10px 20px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:8px;cursor:pointer;">Close</button></div>';
        modal.classList.add('modal');
        document.body.appendChild(modal);
        modal.querySelector('.cfg-close-btn').addEventListener('click', function() { modal.remove(); });
        modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function updateSharePreview(data) {
      const preview = document.getElementById('sharePreview');
      preview.innerHTML = '<h4>REPO AUTOPSY</h4><div class="share-repo">' + data.repo + '</div><div class="share-verdict" style="color:' + data.verdictColor + '">' + data.verdictLabel + '</div><div class="share-score-circle" style="border-color:' + data.verdictColor + '"><div class="share-score-num" style="color:' + data.verdictColor + '">' + data.score + '</div><div class="share-score-label">Deployability</div></div>';
      
      const tweetText = encodeURIComponent('Just autopsied ' + data.repo + ' on Repo Autopsy. Score: ' + data.score + '/100 - ' + data.verdictLabel);
      document.getElementById('tweetBtn').href = 'https://twitter.com/intent/tweet?text=' + tweetText + '&url=' + encodeURIComponent('https://deploy-check.jnara01.workers.dev');
    }

    async function downloadShare() {
      if (!currentResult) return;
      try {
        const res = await fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: currentResult.repo,
            score: currentResult.score,
            verdict: currentResult.verdictLabel,
            color: currentResult.verdictColor,
          }),
        });
        const svg = await res.text();
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentResult.repo.replace('/', '-') + '-autopsy.svg';
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        alert('Failed to generate share card');
      }
    }

    function copyShareUrl() {
      const url = 'https://deploy-check.jnara01.workers.dev/?repo=' + encodeURIComponent(document.getElementById('repoUrl').value);
      navigator.clipboard.writeText(url).then(function() { alert('URL copied!'); });
    }
  </script>
</body>
</html>`;
