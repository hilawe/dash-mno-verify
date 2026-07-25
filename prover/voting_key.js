// How the provers accept the masternode voting key.
//
// The key controls governance votes, never funds, but it is still the credential the whole proof
// rests on. Passing it as `--voting-key <WIF>` puts it in shell history and in the process list,
// where any other local user can read it for as long as the proof runs (up to about an hour for a
// registration). A file or standard input keeps it out of both.
//
// An environment variable is deliberately not offered as the recommended path: environment
// visibility differs across operating systems and process managers, so it reads as safe without
// reliably being so.
import { readFile, stat } from "node:fs/promises";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Returns the WIF string. Precedence is explicit file, then standard input, then the deprecated
// argument, so a member migrating to the safer form cannot be silently overridden by a stale flag.
export async function loadVotingKey(a, { warn = console.warn } = {}) {
  const path = a["voting-key-file"];
  if (path) {
    const raw = await readFile(path, "utf8");
    try {
      const { mode } = await stat(path);
      // Group or world access on a key file is worth saying out loud, but refusing to run would
      // strand a member mid-season over a permission bit, so this warns and continues.
      if (mode & 0o077) {
        warn(`[prover] warning: ${path} is readable by other users. Run: chmod 600 ${path}`);
      }
    } catch {
      // A filesystem without meaningful modes is not a reason to refuse the key.
    }
    const wif = raw.trim();
    if (!wif) throw new Error(`${path} is empty; it should contain the voting key in WIF form.`);
    return wif;
  }

  if (a["voting-key-stdin"] !== undefined) {
    const wif = (await readStdin()).trim();
    if (!wif) throw new Error("no voting key on standard input.");
    return wif;
  }

  if (a["voting-key"]) {
    warn(
      "[prover] warning: --voting-key puts the key in your shell history and in the process list. " +
        "Prefer --voting-key-file <path> (mode 600), or pipe the key in with --voting-key-stdin.",
    );
    return a["voting-key"];
  }

  throw new Error(
    "no voting key given. Use --voting-key-file <path> (recommended), --voting-key-stdin, or --voting-key <WIF>.",
  );
}
