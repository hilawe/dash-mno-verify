// Write a file so that it appears only once it is complete (2026-09-30). A member watching their folder
// for proof.json could attach it while it was still being written. The content goes to a hidden
// temporary name beside the target and is then renamed into place, which on one filesystem swaps the
// name in a single step, so the target is either absent, the old file, or the whole new one.
//
// The temporary name is unique per call and created exclusively, so two writes never share one. When
// the target already exists its permission bits are carried over, because a rename replaces the file
// and would otherwise reset a file its owner had made private to the process's default.
import * as nodeFs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";

export async function writeFileWhole(path, data, { fs = nodeFs, suffix = randomBytes(6).toString("hex") } = {}) {
  let mode;
  try {
    mode = (await fs.stat(path)).mode & 0o777;
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${suffix}.partial`);
  // Cleaned up only once this call has created it. An exclusive create that fails because the name is
  // taken leaves that file alone, since it belongs to another write.
  let created = false;
  try {
    await fs.writeFile(tmp, data, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    created = true;
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, path);
  } catch (e) {
    if (created) await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
