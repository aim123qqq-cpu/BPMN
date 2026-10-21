// PNG-снимки диаграмм из preview.html через headless Chromium (Edge/Chrome) — для визуальной самопроверки агента.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CANDIDATES = [
  process.env.BPMN_AGENT_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
];

export function findBrowser() {
  return CANDIDATES.find((p) => p && existsSync(p));
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', fail);
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} завершился с кодом ${code}`))));
  });
}

export async function renderPreview(previewPath, outDir, { width = 1900, height = 1000 } = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('Не найден Chrome/Edge. Укажите путь в BPMN_AGENT_BROWSER');
  const html = await readFile(previewPath, 'utf8');
  const ids = [...html.matchAll(/"id":"([A-Za-z_][\w-]*)","name":/g)].map((m) => m[1]);
  await mkdir(outDir, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'bpmn-agent-'));
  const shots = [];
  try {
    for (const id of [...new Set(ids)]) {
      const file = resolve(outDir, `${id}.png`);
      const url = `${pathToFileURL(resolve(previewPath)).href}#${id}`;
      await run(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--virtual-time-budget=5000',
        `--screenshot=${file}`, url
      ]);
      shots.push(file);
    }
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  return shots;
}
