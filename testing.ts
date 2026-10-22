// Testing entry — the "./testing" subpath of siyuan-kernel-primitives. The
// SQL routing classifier, deliberately off the ./write and read barrels:
// those surfaces are the write verdicts with their evidence and the read
// primitives. A SQL-routed test stub routes on `statementKind` instead
// of matching statement text.
export { statementKind, type StatementKind } from "./stmtKind.js";
