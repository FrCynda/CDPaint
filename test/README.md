# Tests

```
npm test              everything
npm run test:engine   source-analysis suites only (no browser needed)
npm run test:browser  the live-app suite only
npm run test:syntax   the old parse-only check
```

## Layout

| | |
|---|---|
| `engine/` | Suites that lift functions verbatim out of `paint-engine.js` and run them against stubs. No browser, fast. |
| `browser/` | Suites that drive the real app in a real browser. |
| `browser.mjs` | The driver the browser suites use. |
| `wand-algorithms.test.mjs` | Pre-existing unit tests for the wand. |

## Why two kinds

`paint-engine.js` is one very large file that is not module-wrapped, so it
cannot be imported. The `engine/` suites work around that by extracting a named
function's source with brace matching and evaluating it in a `vm` context with
stubs. That is quick and precise, but it can only see what is written in the
source.

It cannot see behaviour that emerges at runtime. A duplicated event listener,
for example, looks perfectly correct in the source and doubles the history
entries in practice — the static suites all passed while that bug was live. The
`browser/` suites exist for that class of problem: they click the actual
controls, read composited pixels back off the canvas, and round-trip real files.

## The browser driver

`browser.mjs` needs no npm packages. It finds a Chromium that Playwright has
already downloaded (or a system Chrome/Edge), serves the app over a local HTTP
server, and talks to the browser over the DevTools Protocol using Node's
built-in `WebSocket` and `fetch`.

The HTTP server is not optional: `index.html` loads a module script, and ES
modules are blocked under `file://` by CORS.

If no browser is found, `npm test` reports the browser suites as skipped rather
than failing.

```js
import { withPage } from '../browser.mjs';

await withPage(async (page) => {
    const n = await page.eval(`PaintApp.layerMgr.layers.length`);
    // page.run(body)  for statements — use `return` for the value
    // page.errors()   anything the page logged as an error
});
```

Values come back deep-copied, so return plain data, not DOM nodes.

## Mutation testing

Every `engine/` suite takes an optional source path as its first argument:

```sh
node test/engine/compositor.mjs /tmp/deliberately-broken-paint-engine.js
```

Copy `paint-engine.js`, reintroduce the bug a suite claims to catch, and run the
suite against the copy. If it still passes, it is not testing what it says it
is. Several of these suites were vacuous when first written — one bailed early
because a `getElementById` returned null — and this is how that was found.
