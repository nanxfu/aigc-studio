import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const RAW_DIR = join(__dirname, '.raw');
const CLIPS_DIR = join(__dirname, 'clips');
const FRAMES_DIR = join(__dirname, 'public/frames');
const SHOWCASE_SRC = join(ROOT, 'docs/assets/showcase');
const SHOWCASE_DST = join(__dirname, 'public/showcase');
const PREVIEW_PORT = Number(process.env.AIGC_PROMO_PORT || 5188);
const BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`;

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserExecutable() {
  const fromEnv = [process.env.IMAGEN_BROWSER, process.env.EDGE_PATH].filter(Boolean);
  for (const c of fromEnv) {
    if (await fileExists(c)) return c;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const local = process.env.LOCALAPPDATA;
    candidates.push(
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...(local ? [join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  }
  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }
  throw new Error('未找到本地 Edge 或 Chrome，请设置 IMAGEN_BROWSER 环境变量');
}

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/__preview/scenarios.json`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`预览服务启动超时: ${url}`);
}

function startPreviewServer() {
  return spawn(process.execPath, [join(ROOT, 'tools/preview.mjs')], {
    cwd: ROOT,
    env: { ...process.env, AIGC_PREVIEW_PORT: String(PREVIEW_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** 极简工作室指针与点击波纹（随 UI 实时同步，无需后期手绘光标）。 */
const CURSOR_INIT_SCRIPT = () => {
  const install = () => {
    if (document.getElementById('__promo_cursor__')) return;
    const style = document.createElement('style');
    style.textContent = `
      #__promo_cursor__ {
        position: fixed;
        top: 0; left: 0;
        width: 14px; height: 14px;
        margin: -7px 0 0 -7px;
        border-radius: 999px;
        background: rgba(17, 17, 20, 0.56);
        border: 2px solid rgba(255, 255, 255, 0.92);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
        pointer-events: none;
        z-index: 2147483647;
        transform: translate3d(-100px, -100px, 0) scale(1);
        transition: transform 80ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      #__promo_cursor__.is-down {
        transform: translate3d(var(--cx, -100px), var(--cy, -100px), 0) scale(0.72);
      }
      .__promo_ripple__ {
        position: fixed;
        width: 40px; height: 40px;
        margin: -20px 0 0 -20px;
        border-radius: 999px;
        border: 2.5px solid rgba(17, 17, 20, 0.65);
        pointer-events: none;
        z-index: 2147483646;
        animation: __promo_ripple_kf__ 380ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      @keyframes __promo_ripple_kf__ {
        0% { transform: scale(0.35); opacity: 0.95; }
        100% { transform: scale(1.75); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
    const dot = document.createElement('div');
    dot.id = '__promo_cursor__';
    document.body.appendChild(dot);

    let cx = -100;
    let cy = -100;
    window.addEventListener('mousemove', (e) => {
      cx = e.clientX;
      cy = e.clientY;
      dot.style.setProperty('--cx', `${cx}px`);
      dot.style.setProperty('--cy', `${cy}px`);
      dot.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(1)`;
    }, true);
    window.addEventListener('mousedown', (e) => {
      cx = e.clientX;
      cy = e.clientY;
      dot.style.setProperty('--cx', `${cx}px`);
      dot.style.setProperty('--cy', `${cy}px`);
      dot.classList.add('is-down');
      const r = document.createElement('div');
      r.className = '__promo_ripple__';
      r.style.left = `${cx}px`;
      r.style.top = `${cy}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 420);
    }, true);
    window.addEventListener('mouseup', () => {
      dot.classList.remove('is-down');
      dot.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(1)`;
    }, true);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
};

async function moveToLocator(page, locator, { steps = 18, rx = 0.5, ry = 0.5 } = {}) {
  const box = await locator.boundingBox();
  if (!box) return null;
  const x = box.x + box.width * rx;
  const y = box.y + box.height * ry;
  await page.mouse.move(x, y, { steps });
  return { x, y, box };
}

async function clickSmooth(page, locator, { pauseAfter = 350, steps = 16, rx = 0.5, ry = 0.5 } = {}) {
  const info = await moveToLocator(page, locator, { steps, rx, ry });
  if (!info) return null;
  await page.waitForTimeout(70);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(pauseAfter);
  return info;
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__PREVIEW_READY__ === true, { timeout: 15000 });
  await page.waitForTimeout(180);
}

function transcodeToMp4(rawWebm, outMp4, trimStartSec = 0.3) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-ss', String(trimStartSec),
      '-i', rawWebm,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '15',
      '-pix_fmt', 'yuv420p',
      '-g', '5',
      '-r', '30',
      '-movflags', '+faststart',
      outMp4,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg 转码失败 (${outMp4}):\n${res.stderr}`);
  }
}

function extractFrames(mp4Path, outDir, { trimStartSec = 0, speed = 1.0, maxFrames = 90 } = {}) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-ss', String(trimStartSec),
      '-i', mp4Path,
      '-vf', `setpts=PTS/${speed},fps=30`,
      '-frames:v', String(maxFrames),
      '-q:v', '2',
      join(outDir, '%04d.jpg'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg 抽帧失败 (${outDir}):\n${res.stderr}`);
  }
}

function probeDurationSec(mp4Path) {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', mp4Path],
    { encoding: 'utf8', windowsHide: true },
  );
  return Number.parseFloat((res.stdout || '').trim()) || 0;
}

async function copyShowcaseAssets() {
  await mkdir(SHOWCASE_DST, { recursive: true });
  const files = await readdir(SHOWCASE_SRC);
  for (const f of files) {
    if (f.endsWith('.webp') || f.endsWith('.png')) {
      await copyFile(join(SHOWCASE_SRC, f), join(SHOWCASE_DST, f));
    }
  }
}

async function recordClip(browser, name, frameKey, { speed = 1.0, maxFrames = 90 } = {}, fn) {
  const clipRawDir = join(RAW_DIR, name);
  const frameOutDir = join(FRAMES_DIR, frameKey);
  await mkdir(clipRawDir, { recursive: true });
  await mkdir(frameOutDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: clipRawDir, size: { width: 1440, height: 900 } },
  });
  await context.addInitScript(CURSOR_INIT_SCRIPT);
  const page = await context.newPage();
  const startedAt = Date.now();
  const trimStartSec = (await fn(page, startedAt)) ?? 0.3;
  const video = page.video();
  await page.close();
  await context.close();
  const rawPath = await video.path();
  const outMp4 = join(CLIPS_DIR, `${name}.mp4`);
  transcodeToMp4(rawPath, outMp4, trimStartSec);
  extractFrames(outMp4, frameOutDir, { trimStartSec: 0, speed, maxFrames });
  const frameCount = (await readdir(frameOutDir)).filter((f) => f.endsWith('.jpg')).length;
  const durationSec = probeDurationSec(outMp4);
  console.log(`已录制: clips/${name}.mp4 (${durationSec.toFixed(2)}s, frames=${frameCount}) -> public/frames/${frameKey}/`);
  return { name, frameKey, frameCount, durationSec };
}

async function main() {
  await rm(RAW_DIR, { recursive: true, force: true });
  await rm(FRAMES_DIR, { recursive: true, force: true });
  await mkdir(CLIPS_DIR, { recursive: true });
  await mkdir(FRAMES_DIR, { recursive: true });
  await copyShowcaseAssets();

  const executablePath = await resolveBrowserExecutable();
  const previewProc = startPreviewServer();

  try {
    await waitForServer(BASE_URL);
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--force-device-scale-factor=1'],
    });

    try {
      const clips = [];

      // 1. 选模型（1.5s / 45帧）：展开模型菜单 -> 选中模型
      clips.push(
        await recordClip(
          browser,
          'clip-model',
          'model',
          { speed: 1.5, maxFrames: 45 },
          async (page, startedAt) => {
            await page.goto(`${BASE_URL}/__preview?scenario=studio-ready&clean=1`, { waitUntil: 'networkidle' });
            await waitReady(page);
            const readySec = (Date.now() - startedAt) / 1000;
            await page.mouse.move(1180, 120, { steps: 6 });

            const modelBtn = page.locator('button.ofs-model').first();
            await clickSmooth(page, modelBtn, { pauseAfter: 550, steps: 14 });
            const options = page.locator('.ofs-model-option:not([aria-disabled="true"])');
            if ((await options.count()) > 1) {
              await clickSmooth(page, options.nth(1), { pauseAfter: 450, steps: 14 });
            }
            return Math.max(0.2, readySec);
          },
        ),
      );

      // 2. 写句人话 + 点生成（1.5s / 45帧）
      clips.push(
        await recordClip(
          browser,
          'clip-generate',
          'generate',
          { speed: 1.45, maxFrames: 45 },
          async (page, startedAt) => {
            await page.goto(`${BASE_URL}/__preview?scenario=studio-ready&clean=1`, { waitUntil: 'networkidle' });
            await waitReady(page);
            const textarea = page.locator('textarea').first();
            if (await textarea.count()) {
              await textarea.click();
              await textarea.fill('');
            }
            const readySec = (Date.now() - startedAt) / 1000;
            await page.mouse.move(160, 180, { steps: 6 });
            if (await textarea.count()) {
              await clickSmooth(page, textarea, { pauseAfter: 40, steps: 6 });
              await page.keyboard.type('京都红鸟居海报', { delay: 10 });
            }
            const genBtn = page.locator('button.ofs-generate').first();
            if (await genBtn.count()) {
              await clickSmooth(page, genBtn, { pauseAfter: 900, steps: 6, rx: 0.82, ry: 0.55 });
            }
            return Math.max(0.2, readySec);
          },
        ),
      );

      // 3. 蓄力流水线（1.0s / 30帧）：真实顶部生图流水线运行态
      clips.push(
        await recordClip(
          browser,
          'clip-pending',
          'pending',
          { speed: 1.0, maxFrames: 30 },
          async (page, startedAt) => {
            await page.goto(`${BASE_URL}/__preview?scenario=studio-pending&clean=1`, { waitUntil: 'networkidle' });
            await waitReady(page);
            const readySec = (Date.now() - startedAt) / 1000;
            await page.waitForTimeout(1300);
            return Math.max(0.2, readySec);
          },
        ),
      );

      // 4. 瞬间出图落舞台（1.5s / 45帧）：展示出图结果与耗时参数
      clips.push(
        await recordClip(
          browser,
          'clip-result',
          'result',
          { speed: 1.2, maxFrames: 45 },
          async (page, startedAt) => {
            await page.goto(`${BASE_URL}/__preview?scenario=studio-ready&clean=1`, { waitUntil: 'networkidle' });
            await waitReady(page);
            const thumbs = page.locator('button.ofs-thumb');
            if ((await thumbs.count()) > 0) {
              await thumbs.first().click();
              await page.waitForTimeout(300);
            }
            const readySec = (Date.now() - startedAt) / 1000;
            await page.mouse.move(820, 440, { steps: 10 });
            await page.waitForTimeout(1600);
            return Math.max(0.2, readySec);
          },
        ),
      );

      // 5. 顺手后处理（2.0s / 60帧）：工坊一键转 SVG / 抹除背景
      clips.push(
        await recordClip(
          browser,
          'clip-workshop',
          'workshop',
          { speed: 1.35, maxFrames: 60 },
          async (page, startedAt) => {
            await page.goto(`${BASE_URL}/__preview?scenario=workshop-tools&clean=1`, { waitUntil: 'networkidle' });
            await waitReady(page);
            const readySec = (Date.now() - startedAt) / 1000;
            await page.mouse.move(280, 100, { steps: 8 });
            for (const toolId of ['vectorize', 'cutout']) {
              const btn = page.locator(`.ofs-workshop-tool[data-tool="${toolId}"]`).first();
              if (await btn.count()) {
                await clickSmooth(page, btn, { pauseAfter: 160, steps: 10, rx: 0.5, ry: 0.5 });
                await page.mouse.move(920, 480, { steps: 10 });
                await page.waitForTimeout(550);
              }
            }
            return Math.max(0.2, readySec);
          },
        ),
      );

      const frameManifest = Object.fromEntries(clips.map((c) => [c.frameKey, c.frameCount]));
      await writeFile(
        join(__dirname, 'src/recorded-manifest.json'),
        JSON.stringify(frameManifest, null, 2) + '\n',
        'utf8',
      );
      await writeFile(
        join(CLIPS_DIR, 'manifest.json'),
        JSON.stringify({ recordedAt: new Date().toISOString(), clips }, null, 2),
        'utf8',
      );
      console.log('录屏完成，已刷新 src/recorded-manifest.json');
    } finally {
      await browser.close();
    }
  } finally {
    if (process.platform === 'win32' && previewProc.pid) {
      spawnSync('taskkill', ['/pid', String(previewProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      previewProc.kill('SIGTERM');
    }
    previewProc.stdout?.destroy();
    previewProc.stderr?.destroy();
    await rm(RAW_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
