# docx-preview + JSZip (vendored, SFM-314)

Word files (.docx) in the Document Desk (Mini Tools plugin): the document is read and drawn in the browser -- no install,
works offline, the file stays in the browser. docx-preview needs JSZip (loaded first, as the global `JSZip`).

| File | Source (npm registry tarball) | License | SHA-256 of the file |
|---|---|---|---|
| docx-preview.min.js | docx-preview@0.4.1 `dist/` | Apache-2.0 (LICENSE-docx-preview) | c4a133c65a112799e35b143c572dfff9e923a3bf39b5fd3b07a06aa0f8f530c2 |
| jszip.min.js | jszip@3.10.2 `dist/` (pako, lie, setimmediate bundled) | MIT or GPL-3.0 -- used under MIT (LICENSE-jszip.md) | 7f839b2d4688b845c105ebf5d2f9803075f91ea0fe72bdaac176c3a04dd3d2c1 |

Downloaded 2026-11-15; each tarball's SHA-512 checked against the `integrity` the npm registry publishes
(docx-preview-0.4.1.tgz `sha512-Dv4g+LeE0swHpPvNC0lAT0YsR5Zq5pAxw7d3vHQ8EChBLgIrqqe9VPL5nVt2HBJap8bEZbXUI0TJob7kBeNU9w==`,
jszip-3.10.2.tgz `sha512-3l+rb15IOWtUhU0H5MFqES/T6Kh7abYwjosBey/vD6hDt8zoEffkSC5Ws5SGtgVw3gBx2NEbhTeSW1+kWkpyTQ==`).
The files are unchanged (docx-preview.min.js names a .map file that is not shipped -- only the browser's developer tools ask for it).

Reviewed before use (2026-11-15): pictures, fonts and embedded parts are read only from inside the .docx (no network);
**embedded HTML chunks (`altChunk`) are rendered into an unsandboxed iframe, so the Desk always passes
`renderAltChunks: false`**; hyperlink targets and style values come from the document, so the Desk cleans the result
(`document_desk.js :: cleanWord()`: only http(s) / mailto links and bookmarks, no `url()` other than data: / blob:, no
`@import`) before it is put on the page. JSZip's `new Function` sits in its setImmediate polyfill for string callbacks,
which it never passes.

Comments and tracked changes (SFM-316, 2026-11-15): the Desk passes `renderComments: true` / `renderChanges: true`
(both off by default in the library) and hides them with CSS in Final. Comment text is document content drawn by the
same renderer, so it goes through `cleanWord()` like the body; authors / dates are put in as text or `title`. The
comments use the browser's CSS Custom Highlight API (`CSS.highlights`, named `ddw<window>-comments`) -- the Desk
removes it in Final and when the window closes. docx-preview does not read `w:moveFrom` / `w:moveTo`: the Desk turns
them into `w:del` / `w:ins` in a copy of the file in memory (`movesAsChanges()`) before reading it.

To update: download the exact versions again, check the registry integrity, read the changes for the points above,
and update this table.
