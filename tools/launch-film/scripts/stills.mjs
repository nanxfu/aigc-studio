import { bundle } from '@remotion/bundler';
import { getCompositions, openBrowser, renderStill } from '@remotion/renderer';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('out/qa', { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts'), publicDir: path.resolve('public') });
const browser = await openBrowser('chrome');
const comps = await getCompositions(serveUrl, { puppeteerInstance: browser });
const main = comps.find((c) => c.id === 'LaunchFilm');
const shots = comps.filter((c) => c.id.startsWith('Shot-'));

let offset = 0;
const frames = [];
for (const shot of shots) {
  const dur = shot.durationInFrames;
  const picks = [
    Math.min(Math.round(dur * 0.25), dur - 1),
    Math.min(Math.round(dur * 0.68), dur - 1),
  ];
  for (const local of picks) {
    const frame = offset + local;
    const output = path.resolve(`out/qa/f${String(frame).padStart(4, '0')}-${shot.id}.png`);
    await renderStill({
      serveUrl,
      composition: main,
      output,
      frame,
      puppeteerInstance: browser,
      imageFormat: 'png',
      logLevel: 'error',
    });
    frames.push({ shot: shot.id, local, frame, file: output });
    console.log(`${shot.id} f${frame}`);
  }
  offset += dur;
}
await writeFile('out/qa/stills.json', JSON.stringify(frames, null, 2));
await browser.close({ silent: true });
