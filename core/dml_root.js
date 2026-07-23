// Moved to common/dml_root.js, the neutral home for shared protocol code (the oracle builds the
// same tree the gateway verifies, so neither side owns it). This re-export keeps existing gateway
// imports working.
export * from "../common/dml_root.js";
