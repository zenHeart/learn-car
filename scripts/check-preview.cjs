const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const cli = require.resolve('docsify-cli/bin/docsify');
function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-car-preview-'));
  try {
    const site = path.join(directory, 'site');
    run('init', site, '--local');
    for (const file of ['index.html', 'README.md', 'vendor/docsify.js', 'vendor/themes/core.css', 'vendor/themes/addons/vue.css'])
      assert.ok(fs.statSync(path.join(site, file)).size > 0, `Missing generated ${file}`);
    fs.writeFileSync(path.join(site, 'chapter.md'), '# Fixture chapter\n');
    run('generate', site);
    assert.match(fs.readFileSync(path.join(site, '_sidebar.md'), 'utf8'), /\[Chapter\]\(chapter\.md\)/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const { marked } = await import('marked');
  assert.match(await marked.parse('# Preview fixture'), /<h1>Preview fixture<\/h1>/);
  assert.ok(require('figlet').textSync('CLI').trim().length > 0);

  const sidebar = fs.readFileSync('_sidebar.md', 'utf8');
  const links = [...sidebar.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]).filter(link => !/^(?:https?:|#)/.test(link));
  const server = spawn(process.execPath, [cli, 'serve', '.', '--no-open', '--host', '127.0.0.1', '--port', '0', '--livereload-port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    const address = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Preview did not start:\n${output}`)), 15000);
      const receive = chunk => {
        output += chunk;
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address) { clearTimeout(timeout); resolve(address); }
      };
      server.stdout.on('data', receive);
      server.stderr.on('data', receive);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}:\n${output}`)); });
    });
    const routes = ['', 'README.md', '_sidebar.md', ...links];
    for (const route of routes) {
      const response = await fetch(new URL(route, `${address}/`), { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, `Preview route failed: ${route}`);
      const text = await response.text();
      if (route) assert.equal(text, fs.readFileSync(route, 'utf8'), `Wrong Markdown content: ${route}`);
      else assert.match(text, /window\.\$docsify/);
    }
    console.log(`Verified CLI initialization, sidebar generation, Markdown/figlet rendering and ${routes.length} local preview routes.`);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(force);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
