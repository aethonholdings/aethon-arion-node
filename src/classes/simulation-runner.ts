import path from "path";
import { Worker } from "worker_threads";
import { Observable, Subscriber } from "rxjs";
import { ResultDTO, SimConfigDTO } from "aethon-arion-pipeline";
import { RunMessage, WorkerMessage } from "../worker/simulation.protocol";

/** Progress of a run, then its result (null when the node has no model for the job). */
export type RunEvent =
    | { type: "progress"; clockTick: number; totalClockTicks: number }
    | { type: "result"; result: ResultDTO | null };

/** Thrown into a run's stream when the run is cancelled. */
export class RunCancelledError extends Error {
    constructor(message: string = "Run cancelled") {
        super(message);
        this.name = "RunCancelledError";
    }
}

type Pending = { id: number; subscriber: Subscriber<RunEvent> };

/**
 * Runs simulations in a worker thread, one at a time, so that the node's main thread stays responsive while a run's
 * CPU-bound loop executes. The worker is started on first use and kept for later runs; cancelling a run terminates
 * it (a running simulation cannot be interrupted otherwise) and the next run starts a new one. A worker that crashes
 * fails the run in progress.
 */
export class WorkerSimulationRunner {
    private _worker: Worker | null = null;
    private _pending: Pending | null = null;
    private _nextId: number = 1;

    constructor(private _onLog: (level: string, sourceObject: string, message: string, data?: any) => void = () => undefined) {}

    /** True while a run is in progress. */
    get busy(): boolean {
        return this._pending !== null;
    }

    run$(job: SimConfigDTO, nodeId: string, saveStateSpace: boolean, verbose: boolean = false): Observable<RunEvent> {
        return new Observable<RunEvent>((subscriber) => {
            if (this._pending) {
                subscriber.error(new Error("A run is already in progress"));
                return;
            }
            const id = this._nextId++;
            this._pending = { id, subscriber };
            const message: RunMessage = { type: "run", id, job, nodeId, saveStateSpace, verbose };
            try {
                this._ensureWorker().postMessage(message);
            } catch (error) {
                this._pending = null;
                subscriber.error(error);
            }
            // unsubscribing mid-run (e.g. shutdown) stops the simulation
            return () => {
                if (this._pending?.id === id) {
                    this._pending = null;
                    void this._terminate();
                }
            };
        });
    }

    /** Cancels the run in progress, if any; its stream errors with RunCancelledError. */
    async cancel(reason?: string): Promise<boolean> {
        const pending = this._pending;
        if (!pending) return false;
        this._pending = null;
        await this._terminate();
        pending.subscriber.error(new RunCancelledError(reason ? `Run cancelled: ${reason}` : undefined));
        return true;
    }

    /** Stops the worker. */
    async close(): Promise<void> {
        await this.cancel("node stopping");
        await this._terminate();
    }

    private _ensureWorker(): Worker {
        if (this._worker) return this._worker;
        // compiled: dist/src/worker/simulation.worker.js; under ts-node (tests, development): the .ts source
        const typescript = __filename.endsWith(".ts");
        const file = path.join(__dirname, "..", "worker", `simulation.worker.${typescript ? "ts" : "js"}`);
        const worker = new Worker(file, typescript ? { execArgv: ["-r", "ts-node/register/transpile-only"] } : {});
        worker.on("message", (message: WorkerMessage) => this._onMessage(message));
        worker.on("error", (error) => this._fail(`Simulation worker error: ${error?.message ?? error}`));
        worker.on("exit", (code) => {
            if (this._worker === worker) this._worker = null;
            if (code !== 0) this._fail(`Simulation worker stopped (exit code ${code})`);
        });
        this._worker = worker;
        return worker;
    }

    private _onMessage(message: WorkerMessage): void {
        if (message.type === "log") {
            this._onLog(message.level, message.sourceObject, message.message, message.data);
            return;
        }
        if (message.type === "ready") return;
        const pending = this._pending;
        if (!pending || pending.id !== message.id) return; // a cancelled run's late message
        if (message.type === "progress") {
            pending.subscriber.next({ type: "progress", clockTick: message.clockTick, totalClockTicks: message.totalClockTicks });
        } else if (message.type === "result") {
            this._pending = null;
            pending.subscriber.next({ type: "result", result: message.result });
            pending.subscriber.complete();
        } else if (message.type === "error") {
            this._pending = null;
            pending.subscriber.error(new Error(message.message));
        }
    }

    private _fail(reason: string): void {
        const pending = this._pending;
        if (!pending) return;
        this._pending = null;
        pending.subscriber.error(new Error(reason));
    }

    private async _terminate(): Promise<void> {
        const worker = this._worker;
        this._worker = null;
        if (worker) await worker.terminate();
    }
}
