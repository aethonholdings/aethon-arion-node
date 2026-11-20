import fs from "fs";
import path from "path";
import { NodeConfig } from "./interfaces/node.interfaces";
import { Node } from "./classes/class.node";
import { Model } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";
import { Subscription } from "rxjs";

// the configuration file: first CLI argument, else ARION_NODE_CONFIG, else config/arion.config.node.json in the
// package root (resolved from this file, so the node can be started from any working directory)
function resolveConfigPath(): string {
    const explicit = process.argv[2] || process.env.ARION_NODE_CONFIG;
    if (explicit) return path.resolve(explicit);
    const candidates = [
        path.resolve(__dirname, "..", "config", "arion.config.node.json"), // ts-node: src/main.ts
        path.resolve(__dirname, "..", "..", "config", "arion.config.node.json") // compiled: dist/src/main.js
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

let node: Node;
const configPath = resolveConfigPath();
try {
    const nodeConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as NodeConfig;
    const models: Model[] = [C1];
    node = new Node(nodeConfig, models);
} catch (error) {
    // fatal: bad or missing configuration
    console.error(`Failed to start the node with configuration ${configPath}:`, error instanceof Error ? error.message : error);
    process.exit(1);
}

const subscription: Subscription = node.start$().subscribe({
    error: (error) => {
        node.getLogger().error({
            sourceObject: "Main",
            message: "Fatal error in node execution",
            data: { error: error?.message || error }
        });
        process.exit(1);
    },
    complete: () => {
        // the job loop never completes on its own; completion is unexpected
        node.getLogger().error({ sourceObject: "Main", message: "Node job loop ended unexpectedly" });
        process.exit(1);
    }
});

const shutdown = (signal: string) => {
    node.getLogger().info({
        sourceObject: "Main",
        message: `Received ${signal}, shutting down gracefully...`
    });
    subscription.unsubscribe();
    node.getLogger().info({
        sourceObject: "Main",
        message: "Shutdown complete"
    });
    process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
