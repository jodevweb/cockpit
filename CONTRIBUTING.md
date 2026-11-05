# Contributing to Cockpit

Thanks for taking the time. Issues and pull requests are welcome, in English or
in French.

## Before you start

- **A bug**: open an issue with the version (Settings → Version), the system,
  and what you did, saw and expected. A screenshot or the agent's output helps
  more than a description of it.
- **An idea or a larger change**: open an issue first, so we can agree on the
  shape before you spend time on the code.
- **A security vulnerability**: never in a public issue. See
  [SECURITY.md](SECURITY.md).

## Running it

The requirements are listed in the README ("Requirements"): Node 20+, pnpm,
stable Rust, plus Strawberry Perl and the Visual Studio Build Tools on Windows.

```bash
pnpm install
pnpm dev           # the app, with hot reload
pnpm vite:dev      # the interface alone, in a browser, on preview data
```

`pnpm vite:dev` needs no Rust build: every native call is answered by
`src/lib/preview.ts`. It is the quickest way to work on a screen, and it is
what the Playwright tests run against.

## Checks

The CI runs these on every pull request (macOS, Windows, Linux, and Playwright
in a browser). Run them locally before pushing:

```bash
pnpm exec tsc --noEmit             # types
node scripts/i18n-check.mjs        # translation catalogs
pnpm test:ui                       # interface (Playwright, preview data)
cd src-tauri && cargo test --lib   # Rust
```

`cargo test` also rewrites the TypeScript types derived from Rust
(`src/lib/generated`, through ts-rs). If they change, commit them with your
change: the CI refuses a pull request where they are out of date.

On Windows, if the OpenSSL build cannot find the right Perl, set
`OPENSSL_SRC_PERL=C:\Strawberry\perl\bin\perl.exe`.

## Conventions

- **One pull request per change.** `main` only moves through pull requests
  with a green CI.
- **Source code and comments are in French.** Write yours in French if you
  can; English is fine, and will be translated on the way in. Comments explain
  *why*, not what the next line does.
- **Interface texts go through the catalogs**, never hard-coded:
  `src/locales/<language>/` for the interface, `src-tauri/locales/<language>/`
  for texts produced by Rust. English is the reference. Add new keys in every
  language — a rough translation is better than a missing key, and the check
  above lists what is missing.
- **Tests**: a bug fix in Rust comes with a test that fails without it. For
  the interface, a Playwright test when the screen can be reached in preview.
- **Commit messages** say what changes for the person using Cockpit, then why.

## Releases

Publishing a version is reserved for the maintainer: see
[docs/RELEASING.md](docs/RELEASING.md).
