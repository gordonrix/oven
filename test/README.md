# Tests

## Unit

```sh
npm test          # node --test 'test/unit/*.test.js'
```

No test framework and no install required — Node's built-in runner.

`inventory.test.js` has one test that reads the maintainer's real
`Primers Inventory.xlsx`. That workbook is deliberately not committed, so the
test skips itself when the file is absent.

### Regenerating `fixtures/tm-oracle.json`

`src/tm.js` is a port of `tm_neb_q5()` from `gibson_planner.py`, and the oracle
pins it to that function's output. If the Python ever changes, regenerate with:

```sh
python3 - > test/fixtures/tm-oracle.json <<'PY'
import json, math, random
# ... paste _NN_R, _NN_TERM_DS/DH, _NN_DS/DH and tm_neb_q5 from gibson_planner.py ...
random.seed(20260809)
cases = [{'seq': s, 'tm': tm_neb_q5(s)} for s in
         ['AT','GC','ATGC','GGGGCCCC','ATATATATAT',
          'ACGTACGTACGTACGTACGTA','GGGGCCTCTCTTACTGTGT','GGGGCCCCTTTTAAAACCCC',
          'ggggccccttttaaaaGGGGCCCCTTTTAAAACCCCGGGG'] +
         [''.join(random.choice('ACGT') for _ in range(random.randint(15, 45))) for _ in range(15)]]
print(json.dumps(cases, indent=1))
PY
```

The sequences are synthetic on purpose — no real primer data belongs in a
public repo.

## Browser

Exercises the editor-side flow (the Create menu, the cart picker, and
`beforeAnnotationCreate`) against the real 7.4 MB OVE bundle, with no VS Code
involved. `media/CartDemo.html` stubs `acquireVsCodeApi()`.

```sh
python3 -m http.server 8742 --bind 127.0.0.1 &
node <browser-automation-skill>/browser.mjs \
  http://127.0.0.1:8742/media/CartDemo.html --script test/browser/cartDemo.mjs
```

The script returns `PASS` plus a `FAILURES` array. It guards, among other
things, that the **Create** submenu is populated — it rendered completely empty
before the `readOnly` fix — and that `beforeAnnotationCreate` adds to the cart
*without* aborting the annotation.

Note that Playwright's `page.evaluate` runs in an isolated world and cannot see
the page's JS globals. `CartDemo.html` therefore mirrors everything the test
needs into DOM nodes (`#posted`, `#probe`, `body[data-ready]`), which both
worlds share. Reaching for `window.__oveEditor` directly from a test will
silently get `undefined`.

## Manual, in an Extension Development Host

Press <kbd>F5</kbd>, then:

1. Open a `.gb`, add primers, open a **second** `.gb`, add more — the sidebar
   should show all of them with both source plasmids.
2. Reload the window; the cart survives. Then close the folder entirely and
   open a single `.gb` from Finder — it still survives. (This is the case
   `workspaceState` would fail.)
3. Copy TSV, paste into Excel: nine clean columns, `°` intact.
4. Point `oveCart.inventoryPath` at a real inventory; known primers go green,
   new ones orange. Rename the file away and every badge must go grey
   **"unknown"**, never orange.
