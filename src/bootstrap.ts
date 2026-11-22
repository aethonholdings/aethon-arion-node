import fs from "fs";
import path from "path";

/**
 * The node configuration file: the explicit path (first CLI argument), else ARION_NODE_CONFIG, else
 * config/arion.config.node.json in the package root, found relative to the entry point (src/main.ts under ts-node,
 * dist/src/main.js when compiled), so the node can be started from any working directory.
 */
export function resolveConfigPath(argument: string | undefined, environment: string | undefined, entryDirectory: string): string {
    const explicit = argument || environment;
    if (explicit) return path.resolve(explicit);
    const candidates = [
        path.resolve(entryDirectory, "..", "config", "arion.config.node.json"),
        path.resolve(entryDirectory, "..", "..", "config", "arion.config.node.json")
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
