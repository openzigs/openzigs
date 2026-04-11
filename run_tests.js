const cp = require("child_process");
try {
  const r = cp.execSync("npx vitest run", { encoding: "utf8", timeout: 180000 });
  console.log(r);
} catch (e) {
  if (e.stdout) console.log("STDOUT:", e.stdout);
  if (e.stderr) console.log("STDERR:", e.stderr);
}
