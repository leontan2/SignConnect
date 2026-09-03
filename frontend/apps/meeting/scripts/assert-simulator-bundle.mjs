import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const expectedArgument = process.argv.find((argument) => argument.startsWith("--expected="));
const expected = expectedArgument?.slice("--expected=".length);
if (expected !== "absent" && expected !== "present") {
  throw new Error("Use --expected=absent or --expected=present.");
}

const meetingRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distributionRoot = join(meetingRoot, "dist");
// This marker belongs only to the simulator component. Ordinary product copy,
// such as a supported phrase, is not strong evidence that simulator code leaked.
const sentinels = ["signconnect-recognition-simulator-v1"];

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return extname(entry.name) === ".js" ? [path] : [];
  });
}

const bundleText = javascriptFiles(distributionRoot)
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const matches = sentinels.filter((sentinel) => bundleText.includes(sentinel));

if (expected === "absent" && matches.length > 0) {
  throw new Error(`Default bundle leaked simulator sentinels: ${matches.join(", ")}`);
}
if (expected === "present" && matches.length !== sentinels.length) {
  const missing = sentinels.filter((sentinel) => !matches.includes(sentinel));
  throw new Error(`Simulator-enabled bundle is missing sentinels: ${missing.join(", ")}`);
}

console.log(`Simulator bundle assertion passed (${expected}).`);
