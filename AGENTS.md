# Local workspace conventions

## Shell

- Use the installed PowerShell 7 (`pwsh`) and pass an explicit working directory. The project root is `D:\document\development\aigc-studio`; the site package is `D:\document\development\aigc-studio\site`.
- Disable login profile loading for shell tools unless profile-specific behavior is required. The local profile invokes `fnm` through a sandboxed symlink and can fail with access denied.
- When the working directory is already `site`, use `npm run ...`, not `site/npm` or paths beginning with `site/`.
- Keep paths explicit in tool calls. Do not infer the current directory from the previous command.

## Verification scripts

- For multi-step Node or Playwright checks, write the script to a temporary `.cjs` or `.mjs` file, run `node --check` on it, then execute it.
- Read selectors from the current source before using them in a browser check. Do not reuse a selector from an older page version.
- Treat an assertion failure as a finding to investigate or fix. Treat syntax, path, and missing-selector failures as harness defects and correct the check before drawing conclusions.
- Use the installed `playwright-core` from `tools/promo/package.json`; do not install a duplicate browser stack.

## Change safety

- Preserve unrelated dirty work and concurrent edits. Check the relevant source before applying a patch.
- Build from `site` with `npm run build` after changing the website.
