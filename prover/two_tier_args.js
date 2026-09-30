// Option parsing for prover/two_tier.js, in its own module so it can be tested without proving.
//
// It replaces a parser that read the arguments strictly in `--flag value` pairs. A flag that takes no
// value, the documented --voting-key-stdin, then swallowed the next word as its value. In the real run
// on 2026-09-26 that swallowed --secret-out, whose path was silently ignored and the secret written to
// the default name. Placed last, the same flag read as unset, because prover/voting_key.js treats an
// undefined value as absent. node:util parseArgs knows which flags take a value, and strict mode
// refuses an unknown option, a missing value, or a stray word instead of guessing, so a typo or a flag
// given to the wrong step is an error rather than something quietly dropped.
import { parseArgs } from "node:util";

const str = { type: "string" };

// Each step accepts only the options it reads, so for example a voting key passed to `prove`, which
// never uses one, is refused rather than accepted and ignored.
export const TWO_TIER_OPTIONS = {
  register: {
    gateway: str,
    platform: str,
    community: str,
    role: str,
    "secret-out": str,
    "voting-key": str,
    "voting-key-file": str,
    "voting-key-stdin": { type: "boolean" },
    "node-list": str,
  },
  prove: {
    gateway: str,
    challenge: str,
    secret: str,
    out: str,
  },
};

// argv is everything after the script name, starting with the step. Returns { sub: null } for a
// missing or unknown step, so the caller prints its usage. Throws parseArgs's own error (with a code
// such as ERR_PARSE_ARGS_UNKNOWN_OPTION) for anything malformed after a known step.
export function parseTwoTierArgs(argv) {
  const [sub, ...rest] = argv;
  if (typeof sub !== "string" || !Object.hasOwn(TWO_TIER_OPTIONS, sub)) return { sub: null, values: {} };
  const { values } = parseArgs({ args: rest, options: TWO_TIER_OPTIONS[sub], strict: true, allowPositionals: false });
  return { sub, values };
}
