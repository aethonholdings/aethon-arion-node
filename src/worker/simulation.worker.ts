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
// A model can warn on every clock tick (e.g. priority tensor saturation). Forwarding each one floods the main
// thread, which then cannot send heartbeats, take commands or see a Spot notice: a warning is forwarded once per
// run, and the repeats are reported as a count when the run ends.
const repeats = new Map<string, { level: string; sourceObject?: string; message?: string; count: number }>();
const logger = new Logger();
logger.getObservable$().subscribe((line: LogLine) => {
    const level = String(line.type);
    if (!(verbose || level === "warn" || level === "error" || level === "fatal")) return;
    const sourceObject = line.message?.sourceObject;
    const text = line.message?.message;
    if (level === "warn") {
        const key = `${sourceObject}\u0000${text}`;
        const seen = repeats.get(key);
        if (seen) {
            seen.count++;
            return;
        }
        repeats.set(key, { level, sourceObject, message: text, count: 0 });
    }
    post({ type: "log", level, sourceObject, message: text, data: line.message?.data });
});

function reportRepeats(): void {
    for (const r of repeats.values()) {
        if (r.count > 0) post({ type: "log", level: r.level, sourceObject: r.sourceObject ?? "Worker", message: `${r.message} (repeated ${r.count} more times in this run)` });
    }
    repeats.clear();
}

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
    repeats.clear();
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
        reportRepeats();
        post({ type: "result", id: message.id, result: JSON.parse(JSON.stringify(result)) });
    } catch (error) {
        reportRepeats();
        post({ type: "error", id: message.id, message: (error as Error)?.message ?? String(error) });
    }
}

parentPort?.on("message", (message: RunMessage) => {
    if (message?.type === "run") void run(message);
});
post({ type: "ready" });
