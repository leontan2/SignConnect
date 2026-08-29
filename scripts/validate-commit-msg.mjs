import { readFileSync } from "node:fs";

const messageFile = process.argv[2];

if (!messageFile) {
  console.error("Commit message file was not provided.");
  process.exit(1);
}

const subject = readFileSync(messageFile, "utf8").split(/\r?\n/, 1)[0].trim();
const generatedCommit = /^(Merge |Revert ")/.test(subject);
const conventionalCommit = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?!?: .{1,100}$/;

if (!generatedCommit && !conventionalCommit.test(subject)) {
  console.error(`Invalid commit message: "${subject}"`);
  console.error("Use: type(optional-scope): short description");
  console.error("Example: feat(meeting): add participant captions");
  console.error("Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert");
  process.exit(1);
}
