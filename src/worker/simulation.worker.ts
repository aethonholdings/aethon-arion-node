import { parentPort } from "worker_threads";
import { lastValueFrom } from "rxjs";
import { Logger, LogLine, RandomStreamFactory, SimConfigDTO } from "aethon-arion-pipeline";
import { models } from "../models";
import { RunMessage, WorkerMessage } from "./simulation.protocol";

/**
 * Simulation worker: runs one simulation at a time for the node's main thread, which stays free to talk to the server
 * (heartbeats, commands) while a run's CPU-bound loop blocks this thread. Cancelling a run terminates the worker.
 */
const post = (message: WorkerMessage) => parentPort?.postMessage(message);
let verbose = false;
const logger = new Logger();
logger.getObservable$().subscribe((line: LogLine) => {
    const level = String(line.type);
    if (verbose || level === "warn" || level === "error" || level === "fatal") {
        post({ type: "log", level, sourceObject: line.message?.sourceObject, message: line.message?.message, data: line.message?.data });
    }
});

/** The random streams of a run: the same rule as the node's in-process simulation (server-issued seed keys). */
function streams(job: SimConfigDTO): RandomStreamFactory {
    if (Array.isArray(job.seedKeys) && job.seedKeys.length > 0) return RandomStreamFactory.seeded(...job.seedKeys);
    if (job.randomStreamType === "static" && job.id !== undefined && Number.isInteger(job.runIndex)) {
        return RandomStreamFactory.seeded(job.id, job.runIndex as number);
    }
    return new RandomStreamFactory();
}

async function run(message: RunMessage): Promise<void> {
    verbose = message.verbose;
    const model = models.find((m) => m.name === message.job.orgConfig?.type);
    if (!model) {
        post({ type: "result", id: message.id, result: null });
        return;
    }
    let last = 0;
    const onStep = (clockTick: number, totalClockTicks: number) => {
        const now = Date.now();
        if (now - last >= 250 || clockTick === totalClockTicks - 1) {
            last = now;
            post({ type: "progress", id: message.id, clockTick: clockTick + 1, totalClockTicks });
        }
    };
    try {
        const result = await lastValueFrom(model.run$(message.job, streams(message.job), logger, message.nodeId, message.saveStateSpace, onStep));
        post({ type: "result", id: message.id, result: JSON.parse(JSON.stringify(result)) });
    } catch (error) {
        post({ type: "error", id: message.id, message: (error as Error)?.message ?? String(error) });
    }
}

parentPort?.on("message", (message: RunMessage) => {
    if (message?.type === "run") void run(message);
});
post({ type: "ready" });
