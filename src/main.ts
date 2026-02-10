import fs from "fs";
import { NodeConfig } from "./interfaces/node.interfaces";
import { Node } from "./classes/class.node";
import { Model } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";
import { Subscription } from "rxjs";

// Load configuration with error handling
let nodeConfig: NodeConfig;
try {
    nodeConfig = JSON.parse(fs.readFileSync("./config/arion.config.node.json", "utf-8")) as NodeConfig;
} catch (error) {
    console.error("Failed to load configuration file:", error instanceof Error ? error.message : error);
    console.error("Please ensure ./config/arion.config.node.json exists and contains valid JSON");
    process.exit(1);
}

const models: Model[] = [C1];
const node = new Node(nodeConfig, models);

// Subscribe with error and complete handlers to prevent unhandled rejections
const subscription: Subscription = node.start$().subscribe({
    next: () => {
        // Node is processing jobs
    },
    error: (error) => {
        node.getLogger().error({
            sourceObject: "Main",
            message: "Fatal error in node execution",
            data: { error: error?.message || error }
        });
        process.exit(1);
    },
    complete: () => {
        node.getLogger().info({
            sourceObject: "Main",
            message: "Node execution completed"
        });
        process.exit(0);
    }
});

// Graceful shutdown handling
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
