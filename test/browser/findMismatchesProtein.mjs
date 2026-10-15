/*
 * The same Find checks, on a protein: amino-acid search with mismatches.
 *
 *   node <browser-automation>/browser.mjs \
 *     http://127.0.0.1:8742/media/EditorDemo.html?protein --script test/browser/findMismatchesProtein.mjs
 *
 * findMismatches.mjs runs its protein branch when the page is ?protein; this
 * file exists so the suite runner, which takes each script's page from its
 * header, runs that branch too.
 */
export { default } from './findMismatches.mjs';
