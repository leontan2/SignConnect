import { execFileSync } from "node:child_process";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
];
const allowedModelBinaries = new Set([
  "backend/sign-inference-service/src/main/resources/models/deterministic-sign-v1.onnx",
]);
const privateTrainingPathPatterns = [
  /^ml\/sign-recognition\/(?:data|captures|consent|runs|artifacts|checkpoints)\//i,
  /^ml\/sign-recognition\/fixtures\/NON_PRODUCTION_SYNTHETIC\/generated\//i,
];
const generatedModelExtension = /\.(?:ckpt|npy|npz|onnx|pt|pth)$/i;

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options });
}

const errors = [];
const stagedFiles = git([
  "diff",
  "--cached",
  "--name-only",
  "--diff-filter=ACMR",
  "-z",
])
  .split("\0")
  .filter(Boolean);

try {
  git(["diff", "--cached", "--check"]);
} catch (error) {
  errors.push(`Whitespace errors:\n${error.stdout || error.message}`);
}

for (const file of stagedFiles) {
  if (privateTrainingPathPatterns.some((pattern) => pattern.test(file))) {
    errors.push(`${file}: private training/capture artifacts must remain outside Git`);
    continue;
  }
  if (generatedModelExtension.test(file) && !allowedModelBinaries.has(file)) {
    errors.push(`${file}: generated model or tensor artifacts require an explicit reviewed allowlist entry`);
    continue;
  }

  let content;

  try {
    content = execFileSync("git", ["show", `:${file}`]);
  } catch {
    continue;
  }

  if (content.length > MAX_FILE_SIZE) {
    errors.push(`${file}: staged file exceeds 5 MiB`);
    continue;
  }

  if (content.includes(0)) {
    continue;
  }

  const text = content.toString("utf8");

  if (/^(?:<<<<<<<|>>>>>>>)(?: .*)?$/m.test(text)) {
    errors.push(`${file}: unresolved merge-conflict marker detected`);
  }

  for (const [name, pattern] of secretPatterns) {
    if (pattern.test(text)) {
      errors.push(`${file}: possible ${name} detected`);
    }
  }
}

if (errors.length > 0) {
  console.error("Staged-file checks failed:\n");
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Staged-file checks passed (${stagedFiles.length} file(s)).`);
