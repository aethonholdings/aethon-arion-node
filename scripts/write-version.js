// Records the node code's git commit in dist/version.txt (reported in heartbeats; the server flags outdated nodes).
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
let version = "unknown";
try {
    version = execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
    // not a git checkout
}
fs.mkdirSync(path.join(__dirname, "..", "dist"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "..", "dist", "version.txt"), version + "\n");
