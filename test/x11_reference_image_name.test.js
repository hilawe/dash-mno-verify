import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveImage } from "../tools/x11-reference/image_name.mjs";

// F6 FROM THE SIXTH-ROUND REVIEW. The reference image's name folded the tag and a hash of the build
// inputs but NOT the effective DASH_COMMIT, so `DASH_COMMIT= build.sh` or a different commit at the
// same tag resolved to the same name and hit the cache instead of rebuilding. generate.mjs and
// fuzz.mjs each carried their own copy of the name logic (and had drifted before), so the fix also
// moved it into one shared module, which is what these tests exercise. The container-run scripts
// themselves stay outside `npm test` by design; this pins the pure name computation.

test("the reference image name folds in the effective DASH_COMMIT, so distinct commits get distinct images (F6)", () => {
  const pinned = resolveImage({});
  const empty = resolveImage({ DASH_COMMIT: "" });
  const alt = resolveImage({ DASH_COMMIT: "deadbeef" });

  assert.equal(new Set([pinned, empty, alt]).size, 3, "the pinned commit, the empty override, and an alternate commit each get their own image");
  assert.notEqual(empty, pinned, "the empty override is a distinct escape, not a cache hit on the pinned image");
});

test("an UNSET DASH_COMMIT falls back to the PIN, a SET-but-empty one does not", () => {
  // build.sh uses ${DASH_COMMIT-default}, where a set-but-empty value wins. The shared resolver must
  // match, or the shell and the node scripts would disagree on the name.
  assert.equal(resolveImage({}), resolveImage({ DASH_TAG: undefined }), "unset uses the PIN's commit");
  assert.notEqual(resolveImage({}), resolveImage({ DASH_COMMIT: "" }), "an empty value is used as-is, not treated as unset");
});

test("an EMPTY DASH_TAG falls back to the PIN, matching shell ${DASH_TAG:-pin}", () => {
  // A review found the tag semantics diverged: shell ${DASH_TAG:-pin} falls back on empty, but node
  // env.DASH_TAG ?? pin kept the empty string, so `DASH_TAG= fuzz.sh` built one image name and the
  // node script looked for another. DASH_TAG uses ":-" (empty falls back), unlike DASH_COMMIT's "-".
  assert.equal(resolveImage({ DASH_TAG: "" }), resolveImage({}), "an empty tag falls back to the PIN tag, as the shell does");
  assert.notEqual(resolveImage({ DASH_TAG: "vOther" }), resolveImage({}), "a real alternate tag is still honoured");
});

test("the name is deterministic for one environment, and X11REF_IMAGE overrides it entirely", () => {
  assert.equal(resolveImage({ DASH_COMMIT: "x" }), resolveImage({ DASH_COMMIT: "x" }), "same env, same name");
  assert.equal(resolveImage({ X11REF_IMAGE: "custom:tag", DASH_COMMIT: "x" }), "custom:tag", "an explicit image wins over the computed one");
  assert.match(resolveImage({}), /^x11ref:.+-[0-9a-f]{12}$/, "the computed name is tag plus a twelve-hex input+commit hash");
});

test("a changed tag changes the image, independent of the commit", () => {
  assert.notEqual(resolveImage({ DASH_TAG: "vX" }), resolveImage({ DASH_TAG: "vY" }));
});
