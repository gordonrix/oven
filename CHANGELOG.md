# Change Log

All notable changes to the "openvectoreditor" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 1.1.0

- 250629
- Change save button css.
- Change initial state `preview mode` to `normal mode`
- Use umd version bioparser
    - Change fasta name from `jsonToFasta` function
    ``` code
    name||length||description > name
    ```
- **Update ove-webview panel**
    - background color is always white
    - height is always 100%
- **Support .dna format**
    - Edit bio-parser script
    ``` code
    // const arrayBuffer = yield getArrayBufferFromFile(fileObj);
    const arrayBuffer = fileObj;
    ```
    - Change `CustomTextEditorProvider` to `CustomEditorProvider` (can read binary)
    - disabled save button.
- Update README to 1.1.0

### 1.1.1

- Update README in vsix
- Update `package.json` tag, category

### 1.1.2

- tabmenu name .OVE to .show
- Add `retainContextWhenHidden: true` option in tabmenu editor
- code refactoring

### 1.1.3

- Add setting `openvectoreditor.viewType` to adjust initial view type (sequence only, circular map only, split)

### 1.1.4

- issue#2 accepted.
- added Ape color support

``` js
if (feat.notes.ApEinfo_fwdcolor && feat.notes.ApEinfo_fwdcolor[0]) {
  feat.color = feat.notes.ApEinfo_fwdcolor[0];
} else if (feat.notes.ApEinfo_revcolor && feat.notes.ApEinfo_revcolor[0]) {
  feat.color = feat.notes.ApEinfo_revcolor[0];
}
```

### 1.1.5

- add '.fa', '.gbk' extension
- Issue#3

## 1.2.0

- 260620
- **SnapGene .dna file writing support**
    - Replaced `bioparser.umd.js` with upgraded `bioparser2.umd.js`
    - Added `jsonToSnapgene()` to `bioparser2.umd.js`
        - Writes SnapGene binary format (.dna) from sequence JSON
        - Preserves all original TLV blocks (Primers, Features, Notes, History, etc.) via `_snapgeneRawBlocks`
        - Always reconstructs block 0 (sequence) and block 10 (features) to reflect edits
    - `snapgeneToJson()` now parses block 5 primers and stores raw blocks for lossless roundtrip
- **Save button enabled for .dna files**
    - Removed `disabled = true` restriction on Save button for `.dna` format
    - Extension stores `_snapgeneRawBlocks` in closure on open; merges back on save
- **Known Limitation**
    - `.dna` format: Primers from block 5 are displayed in OVE and preserved on save, but **adding new primers via OVE UI is not supported** — new primers will not be written to the file
