import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveConfigPath } from "../src/bootstrap";

const root = path.resolve(__dirname, "..");
const runMain = (args: string[], env: { [key: string]: string } = {}) =>
    spawnSync(process.execPath, ["-r", require.resolve("ts-node/register/transpile-only", { paths: [root] }), path.join(root, "src", "main.ts"), ...args], {
        cwd: os.tmpdir(), // the node must not depend on the working directory
        env: { ...process.env, TS_NODE_PROJECT: path.join(root, "tsconfig.json"), ...env },
        encoding: "utf-8",
        timeout: 60000
    });

describe("Node entry point", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-node-"));

    it("resolves the configuration path from the argument, the environment, or the package root", () => {
        expect(resolveConfigPath("a.json", "b.json", "/x/src")).toBe(path.resolve("a.json"));
        expect(resolveConfigPath(undefined, "b.json", "/x/src")).toBe(path.resolve("b.json"));
        expect(resolveConfigPath(undefined, undefined, path.join(root, "src"))).toBe(path.join(root, "config", "arion.config.node.json"));
        expect(resolveConfigPath(undefined, undefined, path.join(root, "dist", "src"))).toBe(path.join(root, "config", "arion.config.node.json"));
    });

    it("exits with code 1 on a missing, malformed or invalid configuration", () => {
        const malformed = path.join(dir, "malformed.json");
        fs.writeFileSync(malformed, "{ not json");
        const invalid = path.join(dir, "invalid.json");
        fs.writeFileSync(invalid, JSON.stringify({ host: "", loopInterval: 0 }));
        for (const file of [path.join(dir, "missing.json"), malformed, invalid]) {
            const result = runMain([file], { ARION_SERVER_URL: "http://127.0.0.1:1", ARION_NODE_KEY: "k" });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Failed to start the node");
        }
    }, 120000);
});
