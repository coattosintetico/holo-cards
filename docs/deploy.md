# Deploy and repo workflow

## GitHub Pages (production)

- Workflow: `.github/workflows/pages.yml`: on push to `main` (or manual dispatch), `npm ci`, `npm run build`, upload `dist/`, `actions/deploy-pages`.
- Pages source is set to **GitHub Actions** in repo settings (done by the owner).
- `vite.config.ts` uses `base: './'`, so the build works under the `/holo-cards/` sub-path.
- URL: `https://coattosintetico.github.io/holo-cards/`.
- The production bundle includes a ~24 MB ORT `.wasm` emitted by Vite. It's under GitHub's limits and only fetched lazily (imgly loads its runtime files from its CDN anyway).

## claude.ai artifact test build (optional, private)

Useful for a quick private preview without merging. Limits: no network to other hosts (so **no background removal**), no `confirm()`, max 15 MB per binary file.

Steps used so far:
1. `npm run build`.
2. Copy `dist/assets` and `dist/demo` into a scratch folder; **drop the `.wasm`** (too big, unused there).
3. Turn `dist/index.html` into an artifact page: keep the `<title>`, `<script type="module">` and stylesheet `<link>`, plus the body content; drop `<!doctype>`, `<html>`, `<head>`, `<body>` and the meta tags (the artifact host wraps the page).
4. Publish with the Artifact tool, passing every asset and demo file in `files` (`.mjs` needs `contentType: text/javascript`).

Existing test artifact (owner's, private): https://claude.ai/artifact/9MVi4vTFtSkpgCDSAUA25Y (built from the first POC; republish to update).

## Git in cloud sessions

- Branches: `claude/<topic>` from `origin/main`; push, then open a PR. The owner merges.
- `gh pr create` fails (GraphQL is blocked through the proxy). Use REST:
  `gh api repos/coattosintetico/holo-cards/pulls -f base=main -f head=<branch> -f title=... -F body=@file.md`
- The repo is cloned **shallow and single-branch**, so new remote branches aren't tracked automatically and a stop hook may report "unpushed commits, no remote branch" even after a successful push. Fix:
  `git config --add remote.origin.fetch '+refs/heads/<branch>:refs/remotes/origin/<branch>' && git fetch origin && git branch -u origin/<branch>`
- Commit trailers per session instructions; never include model identifiers.
