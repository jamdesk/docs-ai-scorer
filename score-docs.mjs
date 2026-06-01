#!/usr/bin/env node
// score-docs.mjs -- measure how AI-friendly a docs site is.
// Usage: node score-docs.mjs <name> <page1-url> <page2-url>
// Outputs: one line of JSON to stdout.
//
// v1.1 (2026-06-01): fixed the llms.txt probe. v1.0 only checked the bare
// origin root (`${origin}/llms.txt`), which produced FALSE NEGATIVES for any
// docs hosted on a subpath (e.g. example.com/docs). The llms.txt spec
// (llmstxt.org) allows the file at the root path "or, optionally, in a
// subpath", so a site is credited if the file is found at the origin root OR
// at any path segment leading to the tested page. We additionally RECORD where
// it was found (`llmsTxtLocation`: 'root' | 'subpath' | 'none') so a
// discoverability analysis can treat root-served files separately if desired.

const [, , name, url1, url2] = process.argv;
if (!name || !url1 || !url2) {
  console.error('usage: score-docs.mjs <name> <page1-url> <page2-url>');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (compatible; docs-ai-scorer/1.1; +https://jamdesk.com)';

async function fetchText(url, opts = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(15000),
      ...opts,
    });
    const text = await res.text();
    return { ok: true, status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e) };
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasContentH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return false;
  return stripHtml(m[1]).length > 3;
}

function visibleHeadingCount(html) {
  return (html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [])
    .filter((h) => stripHtml(h).length > 1).length;
}

// A discovery file (llms.txt etc.) is "present" only if it returns 2xx AND the
// body looks like text/markdown, not an SPA shell or soft-404 HTML page.
function looksLikeDiscoveryFile(text) {
  if (!text || text.length < 16) return false;
  const head = text.slice(0, 600).toLowerCase().trim();
  if (head.includes('<!doctype') || head.startsWith('<html')) return false;
  return true;
}

async function findDiscoveryFile(url1, filename) {
  // Candidate locations: origin root, then each ancestor path segment of url1.
  const u = new URL(url1);
  const segs = u.pathname.split('/').filter(Boolean);
  const bases = ['/'];
  let acc = '';
  for (const s of segs.slice(0, -1)) {
    acc += `/${s}`;
    bases.push(`${acc}/`);
  }
  for (const base of bases) {
    const candidate = `${u.origin}${base}${filename}`;
    const r = await fetchText(candidate);
    if (r.ok && r.status >= 200 && r.status < 300 && looksLikeDiscoveryFile(r.text)) {
      return { present: true, location: base === '/' ? 'root' : 'subpath', url: candidate, bytes: r.text.length };
    }
  }
  return { present: false, location: 'none', url: null, bytes: 0 };
}

function looksLikeMarkdown(text) {
  const h = text.slice(0, 400).trim();
  return /^(---|#|\*\s|\d+\.\s)/m.test(h) && !h.toLowerCase().includes('<!doctype');
}

function robotsAllows(robotsText, agent) {
  if (!robotsText) return null;
  const lines = robotsText.split(/\r?\n/);
  const groups = [];
  let currentAgents = null;
  let currentRules = null;
  let lastWasAgent = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const ua = line.match(/^user-agent:\s*(.*)$/i);
    if (ua) {
      const val = ua[1].trim().toLowerCase();
      if (!lastWasAgent || !currentAgents) {
        currentAgents = [];
        currentRules = [];
        groups.push({ agents: currentAgents, rules: currentRules });
      }
      currentAgents.push(val);
      lastWasAgent = true;
      continue;
    }
    const dis = line.match(/^disallow:\s*(.*)$/i);
    if (dis && currentRules) currentRules.push({ type: 'disallow', path: dis[1].trim() });
    lastWasAgent = false;
  }
  const target = agent.toLowerCase();
  const exact = groups.find((g) => g.agents.includes(target));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const chosen = exact || wildcard;
  if (!chosen) return true;
  return !chosen.rules.some((r) => r.type === 'disallow' && r.path === '/');
}

function noiseRatio(html1, html2) {
  const chunkSize = 200;
  const chunks = (s) => {
    const out = new Set();
    for (let i = 0; i + chunkSize <= s.length; i += chunkSize) out.add(s.slice(i, i + chunkSize));
    return out;
  };
  const a = chunks(html1);
  const b = chunks(html2);
  let shared = 0;
  for (const c of a) if (b.has(c)) shared++;
  const shareBytes = shared * chunkSize;
  return {
    page1Bytes: html1.length,
    page2Bytes: html2.length,
    sharedBytes: shareBytes,
    page1NoiseRatio: +(shareBytes / html1.length).toFixed(3),
  };
}

async function score(name, url1, url2) {
  const origin = new URL(url1).origin;

  const [main, second, llms, llmsFull, sitemap, robots] = await Promise.all([
    fetchText(url1),
    fetchText(url2),
    findDiscoveryFile(url1, 'llms.txt'),
    findDiscoveryFile(url1, 'llms-full.txt'),
    findDiscoveryFile(url1, 'sitemap.xml'),
    fetchText(`${origin}/robots.txt`),
  ]);

  const mdPath = url1.replace(/\/$/, '') + '.md';
  const mdRes = await fetchText(mdPath);
  const mdEndpoint = mdRes.ok && mdRes.status === 200 && looksLikeMarkdown(mdRes.text);

  const text = stripHtml(main.text);
  const headingCount = visibleHeadingCount(main.text);
  const ssrPass = hasContentH1(main.text) && headingCount >= 2 && text.length > 500;

  const robotsText = robots.ok ? robots.text : '';
  const aiBots = ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot'];
  const robotsByBot = Object.fromEntries(aiBots.map((b) => [b, robotsAllows(robotsText, b)]));

  const noise = main.ok && second.ok ? noiseRatio(main.text, second.text) : null;

  return {
    platform: name,
    url1,
    url2,
    httpStatus: main.status,
    bytesTotal: main.text.length,
    bytesText: text.length,
    textRatio: +(text.length / Math.max(main.text.length, 1)).toFixed(3),
    headingCount,
    ssrPass,
    llmsTxt: llms.present,
    llmsTxtLocation: llms.location, // 'root' | 'subpath' | 'none' -- for discoverability analysis
    llmsTxtUrl: llms.url,
    llmsFullTxt: llmsFull.present,
    llmsFullTxtLocation: llmsFull.location,
    sitemap: sitemap.present,
    mdEndpoint,
    mdEndpointUrl: mdEndpoint ? mdPath : null,
    robotsByBot,
    noise,
  };
}

const result = await score(name, url1, url2);
console.log(JSON.stringify(result, null, 2));
