// The reference image's name, in ONE place. generate.mjs and fuzz.mjs both import this, and build.sh
// computes the same string in shell, so all three resolve the same image and none drifts from the
// others. An earlier finding was exactly that drift: the two scripts disagreed on the tag.
//
// The name folds three things into its identity, and a change to any of them yields a different image
// rather than a stale cache hit:
//   - the TAG (how the upstream source is found),
//   - a hash of the BUILD INPUTS (Dockerfile, harness.cpp, PIN), so an edited harness cannot reuse an
//     image built from the old one, and
//   - the effective DASH_COMMIT (F6). The tag is mutable, so DASH_COMMIT is the documented escape for
//     inspecting a moved tag, and an empty DASH_COMMIT is a distinct escape of its own. Without the
//     commit in the identity, `DASH_COMMIT= build.sh` or a different commit at the same tag resolved
//     to the same name and hit the cache instead of rebuilding.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function resolveImage(env = process.env, here = fileURLToPath(new URL(".", import.meta.url))) {
  if (env.X11REF_IMAGE) return env.X11REF_IMAGE;
  const pin = readFileSync(join(here, "PIN"), "utf8").trim().split(/\s+/);
  const tag = env.DASH_TAG || pin[0]; // || not ??: matches shell ${DASH_TAG:-pin}, where an EMPTY tag also falls back
  // `-` semantics, matching build.sh's `${DASH_COMMIT-default}`: a SET DASH_COMMIT wins even when it
  // is empty; only an UNSET one falls back to the PIN's commit.
  const commit = env.DASH_COMMIT !== undefined ? env.DASH_COMMIT : pin[1];
  const inputs = ["Dockerfile", "harness.cpp", "PIN"].map((f) => readFileSync(join(here, f))).join("");
  const hash = createHash("sha256").update(inputs).update(`\nDASH_COMMIT=${commit}\n`).digest("hex").slice(0, 12);
  return `x11ref:${tag}-${hash}`;
}
