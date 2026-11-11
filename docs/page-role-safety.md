# Page-role retention contract

The shape classifier returns a geometric candidate, not a document boundary.
The app scans physical page positions backwards from the end of the document.
Only a contiguous suffix of shape candidates or independently classified non-question
pages is eligible. Missing pages, ordinary pages, and user-restored pages stop it.
No oracle, user-selected boundary, question-number order, or answer matching is used.
Cover and contents pages use the same retention mechanism independently of the suffix.

Sentence evidence inside a detected region vetoes the shape. Numbers are not body text.
OCR text absence is not evidence of safety. Dense formula-only exercises can still be
mistaken for tables, including the final exercise immediately before the answer table.
Multi-page items are not split for page-role exclusion.

Excluded detections live in pageInfo[index].exclusion.items, outside doc.items.
The page-review restore button returns all retained detections and marks the page
restored. Full analysis and single-page deep analysis preserve existing exclusions
and restored detections, including user edits. Excluded pages have no review flags.
Old books without exclusion metadata need no migration.

Synthetic array tests cover boundary, sentence veto, persistence, restoration and
legacy data. test/e2e/page-exclusions.mjs renders an invented PDF, runs the actual
analyzer and editor, restores the false-excluded dense page with one click, and
checks full and single-page reanalysis. This does not replace real-book measurement.
