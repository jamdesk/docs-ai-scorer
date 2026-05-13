#!/usr/bin/env node
// score-docs.mjs -- measure how AI-friendly a docs site is.
// Usage: node score-docs.mjs <name> <page1-url> <page2-url>
// Outputs: one line of JSON to stdout.

const [, , name, url1, url2] = process.argv;
if (!name || !url1 || !url2) {
  console.error('usage: score-docs.mjs <name> <page1-url> <page2-url>');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (compatible; docs-ai-scorer/1.0; +https://jamdesk.com)';

async function fetchText(url, opts = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
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
    .filter(h => stripHtml(h).length > 1).length;
}

async function head(url) {
  const r = await fetchText(url);
  return { url, present: r.ok && r.status >= 200 && r.status < 300, status: r.status, bytes: r.text.length };
}

function looksLikeMarkdown(text) {
  const head = text.slice(0, 400).trim();
  return /^(---|#|\*\s|\d+\.\s)/m.test(head) && !head.toLowerCase().includes('<!doctype');
}

function robotsAllows(robotsText, agent) {
  if (!robotsText) return null;
  const lines = robotsText.split(/\r?\n/);
  // Parse into groups: a group is one or more contiguous User-agent lines
  // followed by their rules, until the next User-agent line starts a new group.
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
    if (dis && currentRules) {
      currentRules.push({ type: 'disallow', path: dis[1].trim() });
    }
    lastWasAgent = false;
  }
  const target = agent.toLowerCase();
  const exact = groups.find(g => g.agents.includes(target));
  const wildcard = groups.find(g => g.agents.includes('*'));
  const chosen = exact || wildcard;
  if (!chosen) return true;
  const hasDisallowRoot = chosen.rules.some(r => r.type === 'disallow' && r.path === '/');
  return !hasDisallowRoot;
}

function noiseRatio(html1, html2) {
  const chunkSize = 200;
  const chunks = s => {
    const out = new Set();
    for (let i = 0; i + chunkSize <= s.length; i += chunkSize) {
      out.add(s.slice(i, i + chunkSize));
    }
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
  const u = new URL(url1);
  const origin = u.origin;

  const [main, second, llms, llmsFull, sitemap, robots] = await Promise.all([
    fetchText(url1),
    fetchText(url2),
    head(`${origin}/llms.txt`),
    head(`${origin}/llms-full.txt`),
    head(`${origin}/sitemap.xml`),
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
  const robotsByBot = Object.fromEntries(aiBots.map(b => [b, robotsAllows(robotsText, b)]));

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
    llmsFullTxt: llmsFull.present,
    sitemap: sitemap.present,
    mdEndpoint,
    mdEndpointUrl: mdEndpoint ? mdPath : null,
    robotsByBot,
    noise,
  };
}

const result = await score(name, url1, url2);
console.log(JSON.stringify(result, null, 2));
