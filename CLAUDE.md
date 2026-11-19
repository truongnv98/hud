# Notes for AI working on this repo

## Every change that users should get: bump the version
`claude plugin update hud@hud` compares versions only. If the code changes but the
version does not, users see "already at latest" and never get the change.
Bump `version` in BOTH `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
(keep them equal) in the same PR. Patch for fixes, minor for features or changed defaults.

## Before opening a PR
- `claude plugin test .` must pass (all tests).
- Typecheck: `npx -p typescript tsc --noEmit -p .` must be clean. The SDK types in
  `.claude-plugin/types/` are gitignored; generate them with `/plugin-types` first.
- Do not commit `.claude-plugin/types/`.

## After the PR is merged: create a GitHub Release
The repo is public. Every version bump gets a GitHub Release, made after the merge:
```bash
export GH_TOKEN=$(gh auth token --user truongnv98)
SHA=$(git rev-parse origin/main)   # after `git fetch`; the merge commit
gh release create vX.Y.Z --repo truongnv98/hud --target "$SHA" --title "vX.Y.Z" --latest \
  --notes "what changed, one line each"
```
- Tag is `v` + the version in `plugin.json` (e.g. `v0.3.1`).
- `--target` must be the FULL 40-character commit SHA; a short SHA is rejected.
- Check `gh release list --repo truongnv98/hud`: the newest version must be marked Latest.
- A Release does not affect `claude plugin update`; that reads `main` and `version`. It is only the public changelog.

## Behaviour that must stay in sync
- The ⇊ button spinner (`compactFrame`) must run for ANY compaction: the pressed one
  (`compactNow`) and auto compact (`autoCompactNow`). Both use `beginSpin` / `endCompacting`.
  A new compaction path must use them too, and every exit path must call `endCompacting`.
- A failed manual compact is toasted; success is silent (the spinner going away is the feedback).
- Default auto compact % is `AT_DEFAULT` (40). Tests that depend on it must follow it.

## GitHub access
The active `gh` account may lack write access to `truongnv98/hud`. Use
`GH_TOKEN=$(gh auth token --user truongnv98)` per command; do not switch the global account.
