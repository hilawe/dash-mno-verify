import { spawn } from "node:child_process";

// Run a shell script for a test with a HARD deadline. execFileSync's timeout was not one. It sends a
// signal to bash, bash defers its TERM trap while it waits on a foreground child such as curl, and the
// call blocks until that child finishes on its own. Here the script runs as its own process group
// (detached), and on the deadline the whole group, bash and anything it started, is killed with signal
// 9. The result resolves on "close", after the output pipes are drained.
export function runScript(script, args = [], { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
