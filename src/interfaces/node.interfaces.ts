import { APIProtocol } from "aethon-api-types";

export interface NodeConfig {
    /** Machine id override (default: the hardware-based machine id). The node's key is bound to it. */
    id?: string;
    /** Server host; replaced by the server the node was authorised by (see `login`). */
    host: string;
    protocol?: APIProtocol;
    port?: number;
    basePath?: string;
    verbose?: boolean;
    /** Cap on state space recording: false disables it even when a simConfig requests it (default true). */
    saveStateSpace?: boolean;
    /** Polling interval in ms (at least 100). */
    loopInterval: number;
    /** Timeout for job requests in ms (default 30000). */
    requestTimeoutMs?: number;
    /** Timeout for result posts in ms (default 120000). */
    postTimeoutMs?: number;
    /** Where simulations run: "worker" (a worker thread, keeping the node responsive during a run) or "main" (default). */
    simulationThread?: "worker" | "main";
    /** Heartbeat interval in ms (default 10000; 0 disables heartbeats). */
    heartbeatIntervalMs?: number;
}

/** Validates a node configuration and returns the list of problems found (empty when valid). */
export function validateNodeConfig(config: NodeConfig): string[] {
    const errors: string[] = [];
    if (!config || typeof config !== "object") return ["configuration must be an object"];
    if (typeof config.host !== "string" || config.host.length === 0) errors.push("host must be a non-empty string");
    if (!Number.isInteger(config.loopInterval) || config.loopInterval < 100) {
        errors.push("loopInterval must be an integer of at least 100 (ms)");
    }
    if (config.port !== undefined && !(Number.isInteger(config.port) && config.port > 0 && config.port < 65536)) {
        errors.push("port must be an integer between 1 and 65535");
    }
    for (const key of ["requestTimeoutMs", "postTimeoutMs"] as const) {
        if (config[key] !== undefined && !(Number.isInteger(config[key]) && (config[key] as number) > 0)) {
            errors.push(`${key} must be a positive integer (ms)`);
        }
    }
    if (config.heartbeatIntervalMs !== undefined && !(Number.isInteger(config.heartbeatIntervalMs) && config.heartbeatIntervalMs >= 0)) {
        errors.push("heartbeatIntervalMs must be an integer of at least 0 (ms)");
    }
    if (config.simulationThread !== undefined && !["worker", "main"].includes(config.simulationThread)) {
        errors.push('simulationThread must be "worker" or "main"');
    }
    return errors;
}
