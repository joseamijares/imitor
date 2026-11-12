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

From the repository's root (`git rev-parse --show-toplevel`), on clean `main`:

```bash
npm login
npm publish --access public
```

## Tag

```bash
git tag v<version>
git push origin v<version>
```

Then make a GitHub release from the tag. The GitHub Action is used as `joseamijares/imitor@main` in the README; tag-pinned use (`@v<version>`) works once the tag exists.
