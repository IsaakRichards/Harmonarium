# Reading engine: foliate-js (Readest's fork)

Harmonarium reads EPUBs and PDFs with **foliate-js**, the engine inside
[Readest](https://github.com/readest/readest). These files are Readest's fork of it,
[readest/foliate-js](https://github.com/readest/foliate-js), at commit
`22a49acaa120877ede21f713679ab8ba4d1ef663`, copied unchanged except where noted below.
foliate-js is by John Factotum and the Readest contributors, under the MIT License (see `LICENSE`).

Only the modules the reader uses are kept. To update, copy the same files from a newer
checkout of readest/foliate-js and carry the local changes over.

## Local changes
- `pdf.js`: pdf.js's worker and data files are resolved from the page (`vendor/pdfjs/` next to
  `index.html`) instead of the site root. They are copied there by `scripts/copy-pdfjs.mjs`.
  `@pdfjs/…` is an alias for `pdfjs-dist/legacy/build/…` (see `vite.config.js`).
