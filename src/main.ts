import fs from "fs";
import { NodeConfig } from "./interfaces/node.interfaces";
import { Node } from "./classes/class.node";
import { models } from "./models";
import { Subscription } from "rxjs";
import { resolveConfigPath } from "./bootstrap";
import { credentialsPath, loadCredentials, NodeCredentials, saveCredentials, withServer } from "./auth/credentials";
import { login } from "./auth/login";
import { prompt } from "./auth/prompt";

/**
 * Usage:
 *   main.js [config]                        run the node (it must have been authorised with `login`)
 *   main.js login [config] [--allow-http]   authorise the node with the server and save its key; does not start it
 *
 * The key is kept in ~/.arion/node-credentials.json (ARION_NODE_CREDENTIALS), or given as ARION_NODE_KEY together
 * with ARION_SERVER_URL.
 */
const args = process.argv.slice(2);
const command = args[0] === "login" ? "login" : "start";
const positional = args.filter((arg, i) => !(command === "login" && i === 0) && !arg.startsWith("--"));
const allowHttp = args.includes("--allow-http");

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

async function authorise(config: Partial<NodeConfig>, file: string): Promise<NodeCredentials> {
    const credentials = await login({ machineId: Node.machineId(config), basePath: config.basePath, allowHttp, prompt });
    saveCredentials(file, credentials);
    console.log(`Key saved to ${file}`);
    return credentials;
}

async function main(): Promise<void> {
    const configPath = resolveConfigPath(positional[0], process.env.ARION_NODE_CONFIG, __dirname);
    let config: NodeConfig;
    try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as NodeConfig;
    } catch (error) {
        fail(`Failed to start the node with configuration ${configPath}: ${error instanceof Error ? error.message : error}`);
    }
    const file = credentialsPath();

    if (command === "login") {
        await authorise(config, file);
        process.exit(0);
    }

    // starting never authorises: authorisation is the separate `login` command
    const credentials: NodeCredentials | null = loadCredentials(file);
    if (!credentials) fail(`This node is not authorised (no ${file}): run \`login\` first, or set ARION_SERVER_URL and ARION_NODE_KEY`);

    let node: Node;
    try {
        // simulations run in a worker thread unless the configuration says otherwise
        node = new Node({ simulationThread: "worker", ...withServer(config, credentials.serverUrl) }, models, { key: credentials.key });
    } catch (error) {
        // fatal: bad configuration
        fail(`Failed to start the node with configuration ${configPath}: ${error instanceof Error ? error.message : error}`);
    }

    const subscription: Subscription = node.start$().subscribe({
        error: (error) => {
            node.getLogger().error({ sourceObject: "Main", message: "Fatal error in node execution", data: { error: error?.message || error } });
            process.exit(1);
        },
        complete: () => {
            // the job loop completes only when the node drains (e.g. a Spot interruption notice)
            if (node.draining) {
                node.getLogger().info({ sourceObject: "Main", message: "Drained", data: { reason: node.draining } });
                void node.close().finally(() => process.exit(0));
                return;
            }
            node.getLogger().error({ sourceObject: "Main", message: "Node job loop ended unexpectedly" });
            process.exit(1);
        }
    });

    const shutdown = (signal: string) => {
        node.getLogger().info({ sourceObject: "Main", message: `Received ${signal}, shutting down gracefully...` });
        subscription.unsubscribe();
        void node.close().finally(() => {
            node.getLogger().info({ sourceObject: "Main", message: "Shutdown complete" });
            process.exit(0);
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
