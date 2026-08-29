import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: "ignore",
  });
  console.log("Git hooks installed from .githooks");
} catch {
  console.log("Skipping Git hook installation (not inside a Git worktree)");
}
