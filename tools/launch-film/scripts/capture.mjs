// Adapted from video-shotcraft capture-template: actual UI, 2x full pages,
// per-element textures and page-space coordinates. No production API access.
import { chromium } from 'playwright-core';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = path.resolve(ROOT, '../..');
const BASE = process.env.CAPTURE_BASE || 'http://127.0.0.1:5179';
const OUTPUT = path.join(ROOT, 'public/textures');
await mkdir(OUTPUT, { recursive: true });
const payload = await (await fetch(`${BASE}/__preview/scenarios.json`)).json();
const botanica = payload.scenarios['studio-ready'].history.find(i => i.presetId === 'qwen-image-2.1');
const prompt = '画一张温室植物志海报，绿植、拱形玻璃温室，留出干净的白色边缘。';
for (const key of ['studio-ready', 'studio-empty', 'model-picker']) {
  const scene = payload.scenarios[key];
  scene.history = [botanica, ...payload.scenarios['studio-ready'].history.filter(i => i.jobId !== botanica.jobId)];
  scene.state.defaultPreset = botanica.presetId;
  scene.props = { ...scene.props, initialPrompt: prompt, workspaceMode: key === 'studio-empty' ? 'new_draft' : 'work' };
}
const chat = payload.scenarios['chat-composed'];
chat.selectedImage = botanica.images[0];
chat.selectedItem = botanica;
chat.messages = [
  { id: 1, role: 'user', text: '我想做一张温室植物志海报。绿植、玻璃温室，留白多一些。' },
  { id: 2, role: 'assistant', kind: 'intent', prompt: botanica.prompt, summary: '温室植物志海报：拱形玻璃温室与绿植，干净留白，顶部 BOTANICA 与中文标题。', ratioId: '3:4', negative: '', count: 1, lockSeed: false, clarify: null, modelHint: 'qwen-image-2.1', source: 'model' },
];
const motionSource = payload.scenarios['studio-ready'].history.find(i => i.presetId === 'anima-turbo-v1.1');
payload.scenarios['studio-video'].props = {
  ...payload.scenarios['studio-video'].props,
  initialReferences: [{ ...motionSource.images[0], name: '海边站台-首帧.webp' }],
};
// All data below are public fixture assets. Keep only necessary generated-image
// files from the documented workshop sample, never logs or run credentials.
const manifest = JSON.parse(await readFile(path.join(PRODUCT, 'docs/assets/showcase/manifest.json'), 'utf8'));
for (const item of manifest.items) await copyFile(path.join(PRODUCT, 'docs/assets/showcase', item.file), path.join(ROOT, 'public/art', item.file));
const workshopFiles = ['01-workshop-source.png', '02-cutout-birefnet.png', ...['albedo', 'normal', 'roughness', 'metallic'].map(k => `03-pbr-${k}.png`)];
for (const file of workshopFiles) await copyFile(path.join(PRODUCT, 'bench-results/gpu-live/2026-11-23T15-36-01', file), path.join(ROOT, 'public/art', file));
for (const file of ['pixel-before.webp', 'pixel-after.webp', 'sprite-sheet.webp', 'sprite-0.webp', 'vector-after.svg']) await copyFile(path.join(PRODUCT, 'web/studio/workshop/examples', file), path.join(ROOT, 'public/art', file));
const browser = await chromium.launch({ headless: true, executablePath: process.env.IMAGEN_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--disable-dev-shm-usage', '--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: 'light' });
await context.route('**/__preview/scenarios.json', route => route.fulfill({ json: payload }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
const layouts = JSON.parse(await readFile(path.join(ROOT, 'src/layout.json'), 'utf8').catch(() => '{}'));
const names = ['studio-empty', 'studio-ready', 'chat-composed', 'model-picker', 'workshop-cutout', 'workshop-pbr', 'studio-video', 'studio-gallery', 'studio-compare'];
const selectedNames = process.env.CAPTURE_ONLY ? process.env.CAPTURE_ONLY.split(',') : names;
const selectors = { panel: '.ofs-panel', stage: '.ofs-stage', filmstrip: '.ofs-filmstrip', topbar: '.ofs-topbar', model: '.ofs-model-menu', thread: '.ofs-thread-stage', workshop: '.ofs-workshop', gallery: '.ofs-gallery' };
for (const name of selectedNames) {
  await page.goto(`${BASE}/__preview?scenario=${name}&clean=1&shot=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__PREVIEW_READY__ || window.__PREVIEW_ERROR__);
  const error = await page.evaluate(() => window.__PREVIEW_ERROR__);
  if (error) throw new Error(error);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map(im => im.decode().catch(() => {}))); });
  if (['studio-ready', 'studio-empty'].includes(name)) {
    const ratio = page.getByRole('button', { name: '3:4', exact: true });
    if (await ratio.count() === 1) await ratio.click();
  }
  if (name === 'studio-video') {
    const switchVideo = page.getByRole('button', { name: '切换到 MiniMax H3', exact: true });
    if (await switchVideo.count() === 1) await switchVideo.click();
    await page.waitForTimeout(3800); // Let the native model-switch toast leave the frame.
    if ((await page.locator('body').innerText()).includes('当前模型不支持原生参考生图')) throw new Error('Video model was not selected');
    const ratio = page.getByRole('button', { name: '16:9', exact: true });
    if (await ratio.count() === 1 && await ratio.isEnabled()) await ratio.click();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
  if (name === 'studio-empty') {
    const field = page.locator('textarea').first();
    for (const [index, count] of [0, 4, 9, 14, 19, 24, 28, prompt.length].entries()) {
      await field.fill(prompt.slice(0, count));
      await page.screenshot({ path: path.join(OUTPUT, `typing-${index}.png`), fullPage: true });
    }
    await field.blur();
  }
  const text = await page.locator('body').innerText();
  if (/79121|Bearer\s+\S+|sk-[A-Za-z0-9]{15}|creator@gmail|[A-Z]:\\Users\\/i.test(text)) throw new Error(`Unsafe text in ${name}`);
  const broken = await page.locator('img').evaluateAll(images => images.filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src));
  if (broken.length) throw new Error(`Broken images in ${name}: ${broken}`);
  await page.screenshot({ path: path.join(OUTPUT, `${name}.png`), fullPage: true });
  layouts[name] = { width: 1920, pageH: 1080, dpr: 2, source: `${BASE}/__preview?scenario=${name}`, elements: {} };
  for (const [key, selector] of Object.entries(selectors)) {
    const locator = page.locator(selector).first();
    if (!await locator.count() || !await locator.isVisible()) continue;
    const box = await locator.boundingBox();
    layouts[name].elements[key] = box;
    await locator.screenshot({ path: path.join(OUTPUT, `${name}-${key}.png`), omitBackground: true });
  }
  if (name === 'chat-composed') {
    await page.locator('.ofs-intent').screenshot({ path: path.join(OUTPUT, 'assistant-proposal.png'), omitBackground: true });
  }
  await writeFile(path.join(ROOT, 'out/qa', `${name}-visible.txt`), text);
  console.log(`Captured ${name}: ${Object.keys(layouts[name].elements).join(', ')}`);
}
const hires = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 4, colorScheme: 'light' });
await hires.route('**/__preview/scenarios.json', route => route.fulfill({ json: payload }));
const hiPage = await hires.newPage();
await hiPage.goto(`${BASE}/__preview?scenario=chat-composed&clean=1&shot=1`, { waitUntil: 'networkidle' });
await hiPage.waitForFunction(() => window.__PREVIEW_READY__);
await hiPage.locator('.ofs-intent').screenshot({ path: path.join(OUTPUT, 'assistant-proposal.png'), omitBackground: true });
await hires.close();
await page.goto(`file:///${ROOT.replaceAll('\\', '/')}/styleframes.html`);
await page.screenshot({ path: path.join(ROOT, 'out/qa/styleframe-01.png') });
await page.evaluate(() => window.scrollTo(0, 1128));
await page.screenshot({ path: path.join(ROOT, 'out/qa/styleframe-02.png') });
await writeFile(path.join(ROOT, 'src/layout.json'), JSON.stringify(layouts, null, 2));
await writeFile(path.join(ROOT, 'out/qa/capture-report.json'), JSON.stringify({ errors, pages: names, lastCapturedPages: selectedNames, capturedAt: new Date().toISOString(), publicShowcase: manifest, workshopSource: 'web/studio/workshop/examples/SOURCES.md; same documented generated images at original resolution', isolated: true }, null, 2));
await browser.close();
if (errors.length) throw new Error(errors.join('\n'));
