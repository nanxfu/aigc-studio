/** Browser regression: node test/check-client-lightbox.mjs (uses installed Electron). */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = await mkdtemp(join(tmpdir(), 'aigc-lightbox-'))
try {
  await build({
    stdin: {
      resolveDir: root, loader: 'jsx', contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { Stage } from './web/studio/Stage.jsx'
        import { fallbackTranslate } from './web/i18n.js'
        import './web/styles/tokens.css'
        import './web/styles/base.css'
        import './web/styles/shell.css'
        import './web/styles/stage.css'
        import './web/styles/import.css'
        const image = { url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="4096"><rect width="2048" height="4096" fill="teal"/><rect x="8" y="8" width="2032" height="4080" fill="none" stroke="white" stroke-width="16"/></svg>'), width: 2048, height: 4096, file: 'tall.svg' }
        function App() {
          const [zoom, setZoom] = React.useState(false)
          const [selectedImage, setSelectedImage] = React.useState(image)
          window.setPreviewSize = (width, height) => setSelectedImage({ ...image, width, height, url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="teal"/></svg>') })
          return <div className="ofs-root"><div className="ofs-app"><div className="ofs-body">
            <aside style={{width: 320, flexShrink: 0}} />
            <div className="ofs-main"><Stage t={fallbackTranslate('zh')}
              ui={{zoom, setZoom, copyPath() {}}} compute={{activeJob: null}} form={{useInspiration() {}}}
              library={{selected: {image: selectedImage}, isFavorite() {return false}, toggleFavorite() {}}}
              actions={{reroll() {}, openImageTool() {}}} /></div>
          </div></div></div>
        }
        createRoot(document.getElementById('root')).render(<App />)
      `,
    },
    bundle: true, outfile: join(directory, 'app.js'), jsx: 'automatic', loader: { '.svg': 'dataurl', '.webp': 'dataurl' },
  })
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="app.css"><style>html,body,#root,.ofs-root{height:100%;margin:0}.ofs-root{display:flex}</style></head><body><div id="root"></div><script src="app.js"></script></body></html>')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const binary = join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron')
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(binary, [join(root, 'test/helpers/lightbox-browser.cjs'), join(directory, 'index.html')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    const timer = setTimeout(() => { child.kill(); reject(new Error('Lightbox browser test timed out')) }, 30_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (status) => { clearTimeout(timer); resolveExit(status) })
  })
  assert.equal(code, 0, 'Lightbox browser regression must pass')
} finally {
  // Validate the exact temporary directory before recursive cleanup on Windows.
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && dirname(directory) === resolve(tmpdir()))
  await rm(directory, { recursive: true, force: true })
}
