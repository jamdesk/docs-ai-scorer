# docs-ai-scorer

A single-file Node.js script that measures how AI-friendly a docs site is. It powers the scoring in [Which docs platforms are actually AI-friendly?](https://www.jamdesk.com/blog/ai-friendly-docs-platforms-scored) on the Jamdesk blog.

## Run it

```bash
node score-docs.mjs <platform-name> <page-url-1> <page-url-2>
```

Outputs JSON with:
- Text-to-HTML ratio
- SSR pass (does the page server-render real content?)
- `llms.txt` / `llms-full.txt` discovery — checked at the origin root **and** every ancestor subpath of the tested URL, so `/docs/llms.txt` counts, not just `/llms.txt`. The JSON records where it was found via `llmsTxtLocation` (`root`, `subpath`, or `none`).
- `sitemap.xml` and per-page `.md`-endpoint presence
- AI-crawler robots policy (GPTBot, ClaudeBot, PerplexityBot, etc.)
- Chrome-noise ratio between two pages on the same site

No npm install needed. Just Node.js 24 (or any version with `fetch` and `AbortSignal.timeout` — Node 18+).

## Reproduce the article

```bash
./run-all.sh > results.json
```

Uses `platforms.json` to score the seven platforms covered in the article. Results land in `results.json`.

## Submit your platform's results

Run the script against your platform's docs and [open an issue](../../issues/new?template=submit-results.yml) with your numbers. If the reproduction stands up, we'll add your platform to the scorecard in the article.

## What this script doesn't do

- It doesn't follow JavaScript-rendered content (it makes plain HTTP GETs and parses HTML).
- It doesn't simulate Cursor or any specific AI coding agent.
- It doesn't grade answer quality — that's a separate manual rubric documented in the article.

## Changelog

- **v1.1** — Fixed the discovery-file probe. v1.0 checked only the bare origin root (`/llms.txt`), which produced false negatives for docs served from a subpath (e.g. `/docs/llms.txt`) even though [the llms.txt spec](https://llmstxt.org) allows subpaths. v1.1 checks the root and every ancestor segment, follows redirects, validates the body is real markdown rather than an SPA shell, and reports `llmsTxtLocation`. The story behind the fix is in the [article](https://www.jamdesk.com/blog/ai-friendly-docs-platforms-scored).

## License

MIT. © Jamdesk.
