# Releasing

How to publish `imitor` to npm. Only the owner publishes.

## Check first

1. `main` is green and checked out clean: `git status` shows nothing, `npm test` passes.
2. The name is still free (first release only): `npm view imitor` should answer 404.
3. The version in `package.json` (and `package-lock.json`) is the one you mean to publish. Never reuse a version: npm refuses it even after an unpublish.
4. The package holds what it needs and nothing else:

   ```bash
   npm pack --dry-run
   ```

   Expect `bin/`, `src/` (with `src/app/`, `src/shims/`, `src/live-driver.js`, `src/standins.json`), `README.md`, `LICENSE` and `package.json`, about 46 files and 380 kB unpacked. Not `demo/`, `site/`, `design/`, `test/`, `.claude/`, `.impeccable/` or `action.yml`.

5. The tarball works when installed:

   ```bash
   mkdir -p /tmp/imitor-pack && npm pack --pack-destination /tmp/imitor-pack
   rm -rf /tmp/imitor-try && mkdir -p /tmp/imitor-try
   (
     cd /tmp/imitor-try && npm init -y && npm i /tmp/imitor-pack/imitor-<version>.tgz &&
     npx imitor --help &&
     node -e 'require("imitor/metro").withImitor'
   )
   ```

   The parentheses run the try-out in a subshell, so your shell stays in the repository for the publish and tag below.

   Then run `npx imitor init --dry-run` in a copy of an Expo app.

## Publish

There are two ways. Both publish the same thing.

### From GitHub Actions (preferred)

`.github/workflows/publish.yml` publishes when a version tag is pushed. It checks that the tag matches `package.json`, that the version is not on npm yet, runs the full test suite including the browser tests, and publishes with a provenance statement.

One-time set-up: give the repository an npm token as the `NPM_TOKEN` Actions secret. The token must be able to publish a new package (an automation token, or a granular token with read and write access to all packages or to `imitor`) and must not ask for a one-time code. To copy it from 1Password without it touching the clipboard or a file:

```bash
op read "op://<vault>/<item>/credential" | gh secret set NPM_TOKEN --repo joseamijares/imitor
```

Rehearse first: run the workflow by hand from the Actions tab. A manual run is a dry run: it does everything except upload, and needs no token.

Then tag the commit on `main` whose `package.json` has the version to publish:

```bash
git tag v<version>
git push origin v<version>
```

### From your own machine

From the repository's root (`git rev-parse --show-toplevel`), on clean `main`:

```bash
npm login
npm publish --access public
```

Then tag it:

```bash
git tag v<version>
git push origin v<version>
```

Pushing the tag starts the workflow, which will stop at "This version is not on npm yet" because you already published it. That failure is expected in this case.

Then make a GitHub release from the tag. The GitHub Action is used as `joseamijares/imitor@main` in the README; tag-pinned use (`@v<version>`) works once the tag exists.

## After the first publish

- In `README.md`, under Set up, remove the line marked **Not on npm yet**.
- In `src/init.mjs`, remove `UNPUBLISHED_NOTE` and its one use in `formatInit`.
- On the landing page (`site/index.html`), change the install command to `npm i -D imitor playwright`.
