import assert from "node:assert/strict";
import { defaultRoomPolicy } from "../bridge/harness-contracts/domain.ts";
import type { WorkerSpec, WorkerResult, WorkerRunner } from "../bridge/harness-contracts/worker.ts";

// Self-authored, dependency-free source material. Nothing here executes on the host.
export const PROJECT_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "isolated-project-catalog", private: true, type: "module", scripts: {
    build: "node tools/build.mjs", test: "node --test test/*.test.mjs && python3 tools/check_site.py",
  } }, null, 2),
  "src/model.mjs": `export const projects = [
  { title: 'Garden Monitor', status: 'ready', description: 'An offline sensor dashboard.' },
  { title: 'Reading List', status: 'draft', description: 'A personal book collection.' },
  { title: 'Budget & Notes', status: 'ready', description: 'Local planning without account access.' },
];
export function filterProjects(items, query) {
  const term = query.trim().toLowerCase();
  return items.filter(item => item.title.toLowerCase().includes(term));
}
`,
  "src/render.mjs": `export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderProjects(items) {
  return items.map(item => '<article><h2>' + escapeHtml(item.title) + '</h2><span>' + escapeHtml(item.status) + '</span><p>' + escapeHtml(item.description) + '</p></article>').join('');
}
export function renderPage(items, slug) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline Project Catalog</title><link rel="stylesheet" href="styles.css"></head><body><main data-build="' + escapeHtml(slug) + '"><h1>Offline Project Catalog</h1><p>A self-contained sandbox-built example, not live agent activity.</p><label for="search">Search projects</label><input id="search" type="search"><p id="count" role="status">' + items.length + ' projects</p><section id="projects">' + renderProjects(items) + '</section></main><script type="module" src="client.mjs"></script></body></html>';
}
`,
  "src/client.mjs": `import { projects, filterProjects } from './model.mjs';
import { renderProjects } from './render.mjs';
const input = document.querySelector('#search');
input.addEventListener('input', () => {
  const matches = filterProjects(projects, input.value);
  document.querySelector('#projects').innerHTML = renderProjects(matches);
  document.querySelector('#count').textContent = matches.length + ' projects';
});
`,
  "src/styles.css": `:root{color-scheme:dark;font:17px system-ui;background:#111827;color:#eef2ff}main{max-width:960px;margin:8vh auto;padding:24px}h1{font-size:clamp(2rem,6vw,4rem)}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:14px;background:#1f2937;color:inherit;border:1px solid #64748b;border-radius:12px}input:focus-visible{outline:3px solid #a5b4fc}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}article{background:#1f2937;padding:20px;border-radius:16px}article span{color:#a5b4fc}p{line-height:1.6}
`,
  "tools/build.mjs": `import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projects } from '../src/model.mjs';
import { renderPage } from '../src/render.mjs';
const compile = spawnSync('make', ['-C', 'native'], { encoding:'utf8' });
if (compile.status !== 0) throw new Error(compile.stderr || 'native build failed');
const helper = spawnSync('./native/slug', ['Worker Build & Test'], { encoding:'utf8' });
if (helper.status !== 0 || helper.stdout.trim() !== 'worker-build-test') throw new Error('native helper failed');
await mkdir('dist', { recursive:true });
const assets = ['model.mjs','render.mjs','client.mjs','styles.css'];
for (const asset of assets) await copyFile('src/' + asset, 'dist/' + asset);
await writeFile('dist/index.html', renderPage(projects, helper.stdout.trim()));
const hashes = {};
for (const path of ['index.html', ...assets]) hashes[path] = createHash('sha256').update(await readFile('dist/' + path)).digest('hex');
await writeFile('dist/manifest.json', JSON.stringify(hashes, null, 2));
console.log('Built static HTML, CSS, browser modules, SHA-256 manifest and native helper.');
`,
  "tools/check_site.py": `import hashlib, json
from html.parser import HTMLParser
from pathlib import Path
class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.articles = 0; self.label = False
    def handle_starttag(self, tag, attrs):
        self.articles += tag == 'article'
        self.label |= tag == 'label' and dict(attrs).get('for') == 'search'
root = Path('dist'); page = Page(); page.feed((root / 'index.html').read_text())
assert page.articles == 3 and page.label
manifest = json.loads((root / 'manifest.json').read_text())
assert set(manifest) == {'index.html','model.mjs','render.mjs','client.mjs','styles.css'}
for path, digest in manifest.items():
    assert hashlib.sha256((root / path).read_bytes()).hexdigest() == digest
print('Python verified parsed HTML, accessible label and every built asset digest.')
`,
  "test/site.test.mjs": `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { projects, filterProjects } from '../src/model.mjs';
import { renderProjects, escapeHtml } from '../src/render.mjs';
test('filter is case-insensitive, trims input, and handles empty/no matches', () => {
  assert.equal(filterProjects(projects,' GARDEN ').length,1);
  assert.equal(filterProjects(projects,'').length,3);
  assert.equal(filterProjects(projects,'missing').length,0);
});
test('render escapes untrusted source text', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.ok(renderProjects([{title:'<script>',status:'"ready"',description:'A&B'}]).includes('A&amp;B'));
  assert.ok(!renderProjects([{title:'<script>',status:'x',description:''}]).includes('<script>'));
});
test('built site serves HTML and module bytes on container-only loopback', async () => {
  const allowed = new Set(['/index.html','/client.mjs','/model.mjs','/styles.css']);
  const server = createServer(async (req,res) => {
    if (!allowed.has(req.url)) { res.writeHead(404).end(); return; }
    res.end(await readFile('dist' + req.url));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  try {
    for (const path of allowed) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + path);
      assert.equal(response.status,200);
      assert.equal(await response.text(), await readFile('dist' + path,'utf8'));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
`,
  "native/Makefile": "slug: slug.c\n\t$(CC) -std=c11 -O2 -Wall -Wextra -Werror slug.c -o slug\n",
  "native/slug.c": `#include <ctype.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2 || strlen(argv[1]) > 256) return 2;
  char output[257]; unsigned int n = 0;
  for (unsigned int i = 0; argv[1][i]; i++) {
    unsigned char c = (unsigned char)argv[1][i];
    if (isalnum(c)) output[n++] = (char)tolower(c);
    else if (n && output[n-1] != '-') output[n++] = '-';
  }
  if (n && output[n-1] == '-') n--;
  output[n] = 0; puts(output); return 0;
}
`,
};

export const BUILD_AND_TEST = "npm run build && npm test";
export function codingSpec(image: string, nodeId = "project"): WorkerSpec {
  const policy = defaultRoomPolicy(image);
  policy.runBudget.maxModelCalls = 20; policy.runBudget.maxTokens = 100_000;
  return { version: 1, ref: { roomId: "coding", runId: "run", nodeId, attemptId: "attempt" }, planDigest: "b".repeat(64),
    node: { id: nodeId, title: "Offline static project", role: "builder", instructions: "Build and test the supplied offline web project.",
      dependencies: [], inputFrom: [], outputPaths: ["dist/index.html", "dist/manifest.json"], limits: { ...policy.runBudget, maxWallTimeMs: 90_000 } },
    policy, inputs: [], checkpoint: null, answer: null };
}

export type FixtureCall = [string, Record<string, string>];
export function fixtureProvider(calls: FixtureCall[]): typeof fetch {
  let index = 0;
  return (async () => {
    assert.ok(index < calls.length, "Unexpected synthetic-provider call");
    const [name, args] = calls[index++];
    return Response.json({ usage: { prompt_tokens: 100, completion_tokens: 40 }, choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `fixture_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    } }] });
  }) as typeof fetch;
}

export function projectCalls(): FixtureCall[] {
  return [...Object.entries(PROJECT_FILES).map(([path, content]): FixtureCall => ["write_file", { path, content }]),
    ["run_check", { command: BUILD_AND_TEST }], ["final_answer", { answer: "Built/tested offline web assets and native helper." }]];
}

export async function assertProjectArtifacts(runner: WorkerRunner, result: WorkerResult): Promise<void> {
  assert.equal(result.status, "completed", JSON.stringify(result));
  if (result.status !== "completed") return;
  const manifest = result.artifacts[0];
  assert.equal(manifest.verification, "passed");
  const ref = { roomId: manifest.roomId, runId: manifest.runId, artifactId: manifest.id, digest: manifest.digest };
  const read = async (path: string) => Buffer.from((await runner.artifacts.read(ref, path, 1_000_000)).bytes);
  const hashes = JSON.parse((await read("dist/manifest.json")).toString());
  const { createHash } = await import("node:crypto");
  for (const [path, digest] of Object.entries(hashes)) assert.equal(createHash("sha256").update(await read(`dist/${path}`)).digest("hex"), digest);
  assert.match((await read("dist/index.html")).toString(), /data-build="worker-build-test"/);
  assert.match((await read("dist/index.html")).toString(), /Budget &amp; Notes/);
  assert.equal((await read("native/slug")).subarray(0, 4).toString("hex"), "7f454c46");
}
