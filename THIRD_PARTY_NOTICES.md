# Third-party notices

## cloudflared 2026.8.2

The packaged Apple Silicon `cloudflared` sidecar is distributed by Cloudflare,
Inc. under the [Apache License 2.0](https://github.com/cloudflare/cloudflared/blob/2026.8.2/LICENSE).
It is sourced from the [official 2026.8.2 Darwin ARM64 release asset](https://github.com/cloudflare/cloudflared/releases/download/2026.8.2/cloudflared-darwin-arm64.tgz).
SPDX license identifier: `Apache-2.0`.

Cloudflare, Inc. retains all rights to its trademarks.

## Node.js 22.23.2

The packaged Node.js runtime is distributed under the [MIT License](https://github.com/nodejs/node/blob/v22.23.2/LICENSE).

## Marked 18.0.10

The mobile Markdown parser is distributed under the
[MIT License](https://github.com/markedjs/marked/blob/v18.0.10/LICENSE.md).

## DOMPurify 3.4.13

The browser HTML sanitizer is distributed under the
[Mozilla Public License 2.0 or Apache License 2.0](https://github.com/cure53/DOMPurify/blob/3.4.13/LICENSE).

## Packaging note

`@yao-pkg/pkg` is retained as a development dependency and configured for the
Node 22 Apple Silicon ESM build, but it is not used for the production sidecar.
Its snapshot executable started this application and loaded `node:sqlite`, yet
failed the real PTY smoke test because `node-pty`'s `spawn-helper` cannot be
executed reliably from pkg's virtual filesystem (`posix_spawnp failed`). The
production sidecar instead launches this bundled Node.js runtime from a native
Apple Silicon launcher, keeping the helper as an executable packaged resource.
