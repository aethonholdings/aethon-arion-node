import { Logger, RandomStreamFactory, LogLine, Api, ResultDTO, SimConfigDTO, Model } from "aethon-arion-pipeline";
import { EMPTY, Observable, Subject, catchError, concatMap, defaultIfEmpty, defer, exhaustMap, filter, finalize, from, ignoreElements, map, merge, of, repeat, take, takeUntil, tap, throwError, retry, timer, timeout } from "rxjs";
import { NodeConfig, validateNodeConfig } from "../interfaces/node.interfaces";
import { Logger as TSLogger } from "tslog";
import { machineIdSync } from "node-machine-id";
import os from "os";
import fs from "fs";
import path from "path";
import { API, APIRequestOptions } from "aethon-api-types";
import openApi from "../../swagger/swagger.json";
import { RunCancelledError, RunEvent, WorkerSimulationRunner } from "./simulation-runner";
import { spotInterruptionNotice } from "./spot-watch";
import { ResultBuffer, defaultResultBufferDir } from "./result-buffer";

/** What a node process is doing (reported to the server by heartbeats). */
export type NodeState = "idle" | "requesting" | "simulating" | "posting" | "backing-off" | "draining";

/** A node process's activity: its state, the run in progress and counters since it started. */
export interface NodeStatus {
    nodeId: string;
    state: NodeState;
    run: { runId?: number; simConfigId?: number; clockTick: number; totalClockTicks: number; startedAt: string } | null;
    completedRuns: number;
    failedRuns: number;
    averageRunMs: number | null;
    lastError: string | null;
    startedAt: string;
}

/**
 * Distributed simulation node for executing multi-agent organizational simulations.
 *
 * @remarks
 * The Node class implements a worker-style architecture that:
 * - Connects to a central server to fetch simulation jobs
 * - Executes simulations using registered model implementations
 * - Posts results back to the server for analysis
 * - Operates in a continuous loop processing jobs as they become available
 *
 * **Architecture:**
 *
 * The node follows a request-execute-post cycle:
 * ```
 * 1. Initialize: Setup random stream factory for deterministic randomness
 * 2. Loop: Poll server for available simulation configurations
 * 3. Execute: Run simulation using appropriate model
 * 4. Report: Post results back to server
 * 5. Repeat: Continue loop until shutdown
 * ```
 *
 * **Randomness Management:**
 *
 * Uses {@link RandomStreamFactory} for reproducible simulations:
 * - Seeds fetched from server ensure consistency across runs
 * - Multiple parallel nodes can run different simulations with independent random streams
 * - Enables comparison and validation of simulation results
 *
 * **Error Handling:**
 *
 * Robust error recovery with retry logic:
 * - Random stream initialization: 3 retries with 5-second delays
 * - Job processing errors: Logged and continue to next job
 * - Network failures: Automatic retry on next loop iteration
 *
 * **Job Queue Model:**
 *
 * Nodes operate as workers pulling from a shared queue:
 * - Server maintains queue of pending simulations
 * - Nodes request jobs when ready (pull model, not push)
 * - Load balancing happens naturally as idle nodes request work
 * - No job starvation as long as queue has work
 *
 * **Model Registry:**
 *
 * Nodes can execute multiple simulation model types:
 * - Models registered at construction time
 * - Job's orgConfig.type determines which model to use
 * - Enables heterogeneous workloads (C1, C2, etc.) on same infrastructure
 *
 * **Logging:**
 *
 * Dual logging system:
 * - Structured logging via {@link Logger} for programmatic analysis
 * - Console logging via TSLogger for human monitoring
 * - Progress indicators (dots) in non-verbose mode
 * - Full trace logging available in verbose mode
 *
 * **Lifecycle:**
 *
 * 1. Construction: Parse config, initialize API client, setup logger
 * 2. Initialization: Fetch seeds and create random stream factory
 * 3. Operation: Continuous loop requesting and executing jobs
 * 4. Shutdown: Graceful unsubscribe on SIGTERM/SIGINT
 *
 * **Performance:**
 *
 * - Single-threaded execution (one job at a time per node)
 * - Uses RxJS exhaustMap to prevent job overlap
 * - Progress feedback every 1000 clock ticks
 * - Memory-efficient: Streams results, doesn't accumulate history
 *
 * **Bug Fixes (v0.3.0):**
 *
 * - Fixed CRITICAL unhandled subscription without error handlers
 * - Fixed HIGH infinite retry loops (3 locations) with proper retry logic
 * - Fixed HIGH unsafe type casting and payload access
 * - Fixed MEDIUM JSON.parse without error handling
 * - Fixed MEDIUM null pointer in console logging
 * - Fixed MEDIUM division by zero risk in progress indicator
 * - Improved conditional logic and error message handling
 *
 * @example
 * ```typescript
 * import { Node } from "./classes/class.node";
 * import { C1 } from "aethon-arion-c1";
 * import { NodeConfig } from "./interfaces/node.interfaces";
 *
 * // Configure node connection
 * const config: NodeConfig = {
 *   protocol: "http",
 *   host: "localhost",
 *   port: 3000,
 *   basePath: "/api/v1",
 *   loopInterval: 2000,  // Poll every 2 seconds
 *   verbose: false,       // Quiet mode with progress dots
 *   saveStateSpace: false // Don't save full trajectory
 * };
 *
 * // Create node with C1 model support
 * const node = new Node(config, [C1]);
 *
 * // Start processing jobs
 * const subscription = node.start$().subscribe({
 *   next: () => console.log("Job processed"),
 *   error: (error) => {
 *     console.error("Node error:", error);
 *     process.exit(1);
 *   },
 *   complete: () => console.log("Node shutting down")
 * });
 *
 * // Graceful shutdown
 * process.on("SIGTERM", () => {
 *   subscription.unsubscribe();
 *   process.exit(0);
 * });
 * ```
 *
 * @public
 */
export class Node {
    private _name: string = "Node";
    private _id: string;
    private _machineId: string;
    private _instanceId: string;
    private _api: Api;
    private _saveStateSpace: boolean;
    private _requestTimeoutMs: number;
    private _postTimeoutMs: number;
    private _backoffBaseMs: number;
    private _backoffMaxMs: number;
    private _consecutiveErrors: number = 0;
    private _lastRecorded: boolean = false;
    private _loopInterval: number;
    private _logger: Logger;
    private _verbose: boolean;
    private _newline: boolean = false;
    private _tsLogger = new TSLogger();
    private _counter: number = 0;
    private _counterDiv: number = 1000;
    private _models: Model[];
    private _runner: WorkerSimulationRunner | null;
    private _state: NodeState = "idle";
    private _run: NodeStatus["run"] = null;
    private _completedRuns: number = 0;
    private _failedRuns: number = 0;
    private _cancelledRuns: number = 0;
    private _draining: string | null = null;
    private _stopped$ = new Subject<void>();
    private _spotCheckMs: number;
    private _buffer: ResultBuffer | null;
    private _recycle: string | null = null;
    private _consecutiveFailures: number = 0;
    private _maxConsecutiveFailures: number;
    private _maxRssMb: number;
    private _totalRunMs: number = 0;
    private _lastError: string | null = null;
    private _startedAt: string = new Date().toISOString();
    private _heartbeatIntervalMs: number;
    private _expectedVersion: string | null = null;
    private _version: string = Node.codeVersion();

    /**
     * Creates a new distributed simulation node.
     *
     * @remarks
     * The constructor performs comprehensive initialization:
     *
     * **Identity Generation:**
     * - Machine ID: Either from config or hardware-based via `machineIdSync()`
     * - Instance ID: Random 6-digit number (100000-999999)
     * - Node ID: `machineId:instance:processIndex` (see {@link Node.processSuffix}), unique per process
     *
     * **API Client Setup:**
     * - Constructs API client with protocol, host, port, basePath
     * - Defaults to HTTP if protocol not specified
     * - Attaches logger for request/response tracing
     *
     * **Logging Configuration:**
     * - Creates structured {@link Logger} for programmatic analysis
     * - Subscribes to log stream and routes to console via `_console()`
     * - Verbose mode shows full trace logs, quiet mode shows progress dots
     *
     * **Model Registry:**
     * - Stores array of model classes (e.g., C1, C2)
     * - Models must implement {@link Model} interface
     * - Job execution routes to model based on `orgConfig.type`
     *
     * **Loop Configuration:**
     * - Creates RxJS interval observable at specified loop interval
     * - Each tick triggers job request-execute-post cycle
     * - Typical interval: 2000ms (2 seconds)
     *
     * **State Space Persistence:**
     * - `saveStateSpace` flag controls whether full trajectory is saved
     * - When false: Only final results posted (memory efficient)
     * - When true: Complete state history saved for analysis
     *
     * @param config - Node configuration object
     * @param config.protocol - API protocol ("http" or "https"), defaults to "http"
     * @param config.host - Server hostname or IP address
     * @param config.port - Server port number
     * @param config.basePath - API base path (e.g., "/api/v1")
     * @param config.loopInterval - Milliseconds between job requests
     * @param config.verbose - Enable full trace logging vs progress dots
     * @param config.saveStateSpace - Save complete state trajectory vs final results only
     * @param config.id - Optional machine ID override (defaults to hardware ID)
     * @param models - Array of model classes supporting different simulation types
     * @param auth - The node's key from `login` (sent as `Authorization: Bearer <key>` with every request)
     *
     * @example
     * ```typescript
     * import { Node } from "./classes/class.node";
     * import { C1 } from "aethon-arion-c1";
     *
     * const config = {
     *   protocol: "https",
     *   host: "arion.example.com",
     *   port: 443,
     *   basePath: "/api/v1",
     *   loopInterval: 5000,     // Poll every 5 seconds
     *   verbose: true,          // Full logging
     *   saveStateSpace: true    // Save complete trajectories
     * };
     *
     * const node = new Node(config, [C1]);
     * ```
     *
     * @public
     */
    constructor(config: NodeConfig, models: Model[], auth?: { key?: string }) {
        const errors = validateNodeConfig(config);
        if (errors.length > 0) throw new Error(`Invalid node configuration: ${errors.join("; ")}`);
        this._verbose = config?.verbose ? true : false;
        this._logger = new Logger();
        this._logger.getObservable$().subscribe((logLine: LogLine) => {
            this._console(logLine);
        });
        this._api = new Api(
            new API(config.protocol || "http", config.host, openApi, config.port, config.basePath),
            this._logger
        );
        if (auth?.key) this._api.setHeader("Authorization", `Bearer ${auth.key}`);
        this._machineId = Node.machineId(config);
        this._models = models;
        this._instanceId = Node.processSuffix();
        this._id = this._machineId + ":" + this._instanceId;
        this._log("Initialising node", { nodeId: this._id });
        // a cap: false disables state space recording even when a simConfig asks for it
        this._saveStateSpace = config.saveStateSpace !== false;
        this._requestTimeoutMs = config.requestTimeoutMs ?? 30000;
        this._postTimeoutMs = config.postTimeoutMs ?? 120000;
        this._loopInterval = config.loopInterval;
        this._heartbeatIntervalMs = config.heartbeatIntervalMs ?? 10000;
        // Spot interruption checks: on by default on EC2 (the instance id is set by deploy/aws/node-setup.sh)
        const onEc2 = String(process.env.ARION_NODE_INSTANCE ?? "").startsWith("i-");
        this._spotCheckMs = config.spotCheckIntervalMs ?? (onEc2 ? 5000 : 0);
        // simulations run in a worker thread unless the configuration asks for the main thread
        this._runner =
            config.simulationThread === "worker"
                ? new WorkerSimulationRunner((level, sourceObject, message, data) => this._workerLog(level, sourceObject, message, data))
                : null;
        // results that cannot be posted are kept on disk and posted before new work is taken
        this._buffer = config.resultBufferDir === false ? null : new ResultBuffer(config.resultBufferDir ?? defaultResultBufferDir());
        this._maxConsecutiveFailures = config.maxConsecutiveFailures ?? 5;
        this._maxRssMb = config.maxRssMb ?? 0;
        this._backoffBaseMs = config.backoffBaseMs ?? 2000;
        this._backoffMaxMs = config.backoffMaxMs ?? 60000;
        this._log("Node initialised");
    }

    /**
     * Starts the polling loop: every `loopInterval` ms, if no job is in progress, request a job, simulate it and
     * post the result.
     *
     * @remarks
     * The loop does not end on errors: a failed request, simulation or post is logged and the next tick tries
     * again, so a node started before the server simply waits for it. The observable only errors on a fatal
     * programming error and never completes on its own.
     */
    start$(): Observable<boolean> {
        this._log("Starting job loop", { loopInterval: this._loopInterval, heartbeatIntervalMs: this._heartbeatIntervalMs, spotCheckIntervalMs: this._spotCheckMs });
        // one job at a time: the next request follows at once after a recorded result, after loopInterval when there
        // was no work, and after an exponential backoff with jitter after errors (so that many processes do not
        // retry in step against a struggling server). A draining node stops asking (the loop completes).
        const loop$ = defer(() => (this._draining ? EMPTY : this.runOnce$())).pipe(
            repeat({
                delay: () => {
                    if (this._draining) return EMPTY;
                    const problem = this.selfCheck();
                    if (problem) {
                        // recycle: stop here and let the process manager start a fresh process
                        this._recycle = problem;
                        this._draining = `Self-check: ${problem}`;
                        this._logger.error({ sourceObject: this._name, message: "Self-check failed; stopping for a restart", data: { problem } });
                        return EMPTY;
                    }
                    const delay = this.nextDelay();
                    if (this._consecutiveErrors > 0) this._state = "backing-off";
                    return timer(delay).pipe(takeUntil(this._stopped$));
                }
            }),
            finalize(() => this._stopped$.next())
        );
        const side$: Observable<never>[] = [];
        // heartbeats run beside the job loop (the main thread is free while a worker thread simulates)
        if (this._heartbeatIntervalMs > 0) side$.push(timer(0, this._heartbeatIntervalMs).pipe(exhaustMap(() => this.heartbeat$()), ignoreElements()));
        if (this._spotCheckMs > 0) {
            side$.push(
                timer(0, this._spotCheckMs).pipe(
                    exhaustMap(() => from(spotInterruptionNotice())),
                    filter((notice): notice is string => notice !== null),
                    take(1),
                    tap((notice) => void this.drain(`Spot interruption notice: ${notice}`)),
                    ignoreElements()
                )
            );
        }
        return merge(loop$, ...side$.map((s$) => s$.pipe(takeUntil(this._stopped$))));
    }

    /**
     * Stops the node: no further jobs, the run in progress is cancelled and its lease released (so that the server
     * hands it out again at once), and start$ completes. Used on a Spot interruption notice.
     */
    async drain(reason: string): Promise<void> {
        if (this._draining) return;
        this._draining = reason;
        this._state = "draining";
        this._logger.warning({ sourceObject: this._name, message: "Draining", data: { reason } });
        const runId = this._run?.runId;
        if (await this.cancelRun(reason)) this._log("Run cancelled for draining", { runId });
        if (runId !== undefined) {
            try {
                await new Promise((resolve) =>
                    this._api
                        .request$("RunController_release", { params: { id: runId }, body: { nodeId: this._id } } as APIRequestOptions)
                        .pipe(timeout({ first: 10000 }))
                        .subscribe({ next: resolve, error: resolve, complete: () => resolve(null) })
                );
                this._log("Run released", { runId });
            } catch {
                // best effort: the lease expires anyway
            }
        }
    }

    /**
     * The self-check after each job: a reason to recycle the process, or null. Counts consecutive runs that failed on
     * this machine (not server errors) and the resident memory.
     */
    selfCheck(rssBytes: number = process.memoryUsage().rss): string | null {
        if (this._maxConsecutiveFailures > 0 && this._consecutiveFailures >= this._maxConsecutiveFailures) {
            return `${this._consecutiveFailures} consecutive failed runs`;
        }
        const rssMb = Math.round(rssBytes / (1024 * 1024));
        if (this._maxRssMb > 0 && rssMb > this._maxRssMb) return `resident memory ${rssMb} MB above ${this._maxRssMb} MB`;
        return null;
    }

    /** Why the self-check stopped the node (the process should exit with code 1 and be restarted), or null. */
    get recycle(): string | null {
        return this._recycle;
    }

    /** Why the node is draining, or null. */
    get draining(): string | null {
        return this._draining;
    }

    /**
     * Sends one heartbeat: the process's status, memory and code version. Never errors (a failed heartbeat is only
     * logged); emits the server's reply, or null.
     */
    heartbeat$(): Observable<any> {
        const status = this.getStatus();
        const body = {
            nodeId: status.nodeId,
            state: status.state,
            run: status.run
                ? {
                      ...(status.run.runId !== undefined ? { runId: status.run.runId } : {}),
                      ...(status.run.simConfigId !== undefined ? { simConfigId: status.run.simConfigId } : {}),
                      clockTick: status.run.clockTick,
                      totalClockTicks: status.run.totalClockTicks,
                      startedAt: status.run.startedAt
                  }
                : null,
            completedRuns: status.completedRuns,
            failedRuns: status.failedRuns,
            averageRunMs: status.averageRunMs,
            lastError: status.lastError,
            memoryMb: Math.round(process.memoryUsage().rss / 1048576),
            version: this._version,
            startedAt: status.startedAt
        };
        return defer(() => this._api.request$("NodeController_heartbeat", { body } as APIRequestOptions)).pipe(
            timeout({ first: Math.max(5000, this._heartbeatIntervalMs) }),
            map((response: any) => {
                const reply = response?.payload ?? response;
                const expected: string | null = reply?.expectedVersion ?? null;
                if (expected && expected !== this._expectedVersion && expected !== this._version) {
                    this._logger.warning({ sourceObject: this._name, message: "This node runs other code than the server expects", data: { running: this._version, expected } });
                }
                this._expectedVersion = expected;
                this._handleCommands(reply?.commands);
                return reply;
            }),
            catchError((error) => {
                this._log("Heartbeat not delivered", { error: error?.message ?? String(error), status: error?.status });
                return of(null);
            })
        );
    }

    /** Carries out the commands in a heartbeat reply: cancel stops the run in progress when it is the one named. */
    private _handleCommands(commands: any[] | undefined): void {
        for (const command of Array.isArray(commands) ? commands : []) {
            if (command?.type === "cancel" && this._run && command.runId === this._run.runId) {
                this._log("Cancelling run", { runId: command.runId, reason: command.reason });
                void this.cancelRun(command.reason);
            }
        }
    }

    /** Runs cancelled because the server no longer needed them. */
    get cancelledRuns(): number {
        return this._cancelledRuns;
    }

    /** Milliseconds to wait before the next job request (see start$). */
    nextDelay(random: () => number = Math.random): number {
        if (this._consecutiveErrors > 0) {
            return Node.backoffDelay(this._consecutiveErrors, this._backoffBaseMs, this._backoffMaxMs, random);
        }
        return this._lastRecorded ? 0 : this._loopInterval;
    }

    /** Backoff after the k-th consecutive error: min(max, base x 2^(k-1)) x U(0.5, 1.5). */
    static backoffDelay(errors: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
        const exponential = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, errors - 1)));
        return Math.round(exponential * (0.5 + random()));
    }

    /** The node code's git commit (dist/version.txt, written by the build), or "dev" when run from source. */
    static codeVersion(file: string = path.join(__dirname, "..", "..", "version.txt")): string {
        try {
            return fs.readFileSync(file, "utf-8").trim() || "unknown";
        } catch {
            return "dev";
        }
    }

    get version(): string {
        return this._version;
    }

    /**
     * Requests one job, simulates it and posts the result. Emits true when a result was recorded, false otherwise;
     * never errors.
     */
    runOnce$(): Observable<boolean> {
        this._log("Requesting job");
        this._counter = 0;
        this._state = "requesting";
        this._lastRecorded = false;
        return this._flushBuffer$().pipe(
            concatMap(() => this._getNext$()),
            concatMap((response: SimConfigDTO) => {
                if (response !== null && response !== undefined && response.id && response.orgConfig) {
                    this._log("SimConfig received", { jobId: response.id, runId: response.runId, runIndex: response.runIndex });
                    // a run that fails here is reported to the server, which stops dispatching a simConfig whose runs
                    // keep failing (otherwise every node would be handed the same failing job forever)
                    return this.simulate$(response).pipe(
                        catchError((error) => {
                            // a run the server no longer needs: neither a failure nor a result
                            if (error instanceof RunCancelledError) {
                                this._cancelledRuns++;
                                this._log("Run cancelled", { runId: response.runId, reason: error.message });
                                return of(null);
                            }
                            this._failedRuns++;
                            this._consecutiveFailures++;
                            this._lastError = error?.message ?? String(error);
                            return this._reportFailure$(response, error).pipe(map(() => null));
                        })
                    );
                }
                this._log("No job received - retrying");
                this._consecutiveErrors = 0; // the server answered
                return of(null);
            }),
            concatMap((result: ResultDTO | null) => {
                if (result === null || result === undefined) return of(false);
                this._consecutiveFailures = 0; // the simulation ran
                this._state = "posting";
                this._log("Posting results", {
                    simConfigId: result.simConfigId,
                    runId: result.runId,
                    payloadSizeKB: Math.round(JSON.stringify(result).length / 1024)
                });
                return this._postResult$(result).pipe(
                    catchError((error) => {
                        // the server is unreachable or refuses the node for now: the result is kept on disk and
                        // posted before the next job (a refused result, e.g. 400, is not kept)
                        if (this._buffer && (Node.isTransientError(error) || error?.status === 401 || error?.status === 403)) {
                            try {
                                const file = this._buffer.save(result);
                                this._log("Result buffered on disk", { runId: result.runId, file, buffered: this._buffer.count() });
                            } catch (saveError: any) {
                                this._logger.error({ sourceObject: this._name, message: "Could not buffer result", data: { runId: result.runId, error: saveError?.message } });
                            }
                        }
                        return throwError(() => error);
                    }),
                    map((response: any) => {
                        this._log("Result recorded", { resultId: response?.payload?.id ?? response?.id });
                        this._completedRuns++;
                        this._lastRecorded = true;
                        this._consecutiveErrors = 0;
                        return true;
                    })
                );
            }),
            catchError((error) => {
                // the server refused this node's key (revoked, replaced or missing) or its node id: polling on would
                // only repeat the refusal, so the node stops
                if (error?.status === 401 || error?.status === 403) {
                    return throwError(
                        () =>
                            new NodeAuthError(
                                error.status === 401
                                    ? "The server rejected this node's key (missing, revoked or replaced): run `login` to authorise the node"
                                    : "The server refused this node's id: run `login` to authorise the node"
                            )
                    );
                }
                this._lastError = error?.message ? error.message : String(error || "Unknown error");
                this._consecutiveErrors++;
                this._log("Error processing job", {
                    error: this._lastError,
                    status: error?.status
                });
                return of(false);
            }),
            finalize(() => {
                this._state = "idle";
                this._run = null;
            })
        );
    }

    /** The node process's activity (state, run in progress with its progress, counters). */
    getStatus(): NodeStatus {
        return {
            nodeId: this._id,
            state: this._draining ? "draining" : this._state,
            run: this._run ? { ...this._run } : null,
            completedRuns: this._completedRuns,
            failedRuns: this._failedRuns,
            averageRunMs: this._completedRuns > 0 ? Math.round(this._totalRunMs / this._completedRuns) : null,
            lastError: this._lastError,
            startedAt: this._startedAt
        };
    }

    /** Cancels the run in progress (worker thread only; a main-thread run cannot be interrupted). */
    cancelRun(reason?: string): Promise<boolean> {
        return this._runner ? this._runner.cancel(reason) : Promise.resolve(false);
    }

    /** Stops the simulation worker, if any. */
    close(): Promise<void> {
        return this._runner ? this._runner.close() : Promise.resolve();
    }

    private _workerLog(level: string, sourceObject: string, message: string, data?: any): void {
        const line = { sourceObject: sourceObject ?? "Worker", message, data };
        if (level === "error" || level === "fatal") this._logger.error(line);
        else if (level === "warn") this._logger.warning(line);
        else this._logger.trace(line);
    }

    /**
     * Simulates one run of a simConfig with a random stream factory created for this run.
     *
     * @remarks
     * - `randomStreamType: "static"`: streams are derived from (simConfig id, runIndex), so every dispatched run is
     *   distinct and any run can be reproduced exactly. Without a runIndex (older server) the run cannot be made
     *   reproducible and falls back to non-reproducible streams with a warning.
     * - `randomStreamType: "random"`: non-reproducible streams.
     * - The state space is recorded when the simConfig asks for it, unless the node configuration disables it.
     */
    simulate$(simConfigDTO: SimConfigDTO): Observable<ResultDTO | null> {
        const model = this._models.find((model) => model.name === simConfigDTO.orgConfig?.type);
        if (!model) {
            this._log(`Model ${simConfigDTO.orgConfig?.type} not found - skipping job`);
            return of(null);
        }
        const saveStateSpace: boolean = simConfigDTO.saveStateSpace === true && this._saveStateSpace !== false;
        const started = Date.now();
        this._state = "simulating";
        this._run = { runId: simConfigDTO.runId, simConfigId: simConfigDTO.id, clockTick: 0, totalClockTicks: 0, startedAt: new Date(started).toISOString() };
        const progress = (clockTick: number, totalClockTicks: number) => {
            if (this._run) {
                this._run.clockTick = clockTick;
                this._run.totalClockTicks = totalClockTicks;
            }
        };
        const done = (result: ResultDTO | null) => {
            if (result) this._totalRunMs += Date.now() - started;
        };
        if (this._runner) {
            // worker thread: the main thread stays free while the run executes
            return this._runner.run$(simConfigDTO, this._id, saveStateSpace, this._verbose).pipe(
                tap((event: RunEvent) => {
                    if (event.type === "progress") progress(event.clockTick, event.totalClockTicks);
                }),
                filter((event: RunEvent): event is Extract<RunEvent, { type: "result" }> => event.type === "result"),
                map((event) => event.result),
                tap(done)
            );
        }
        // defer: a synchronous throw while building the simulation (e.g. an invalid horizon) becomes an error of
        // this job rather than of the loop
        return defer(() =>
            model.run$(
                simConfigDTO,
                this.createRandomStreamFactory(simConfigDTO),
                this._logger,
                this._id,
                saveStateSpace,
                (clockTick: number, totalClockTicks: number) => progress(clockTick + 1, totalClockTicks)
            )
        ).pipe(tap(done));
    }

    /** Creates the random stream factory for one run of a simConfig (see {@link simulate$}). */
    createRandomStreamFactory(simConfigDTO: SimConfigDTO): RandomStreamFactory {
        // server-issued keys ([base seed, org config replicate, run index]): the same replicate and run share their
        // streams at every optimiser point (common random numbers); used for both stream types, "random" differing
        // by a base seed drawn once per simulation parameter set
        if (Array.isArray(simConfigDTO.seedKeys) && simConfigDTO.seedKeys.length > 0) {
            return RandomStreamFactory.seeded(...simConfigDTO.seedKeys);
        }
        if (simConfigDTO.randomStreamType === "static") {
            if (simConfigDTO.id !== undefined && Number.isInteger(simConfigDTO.runIndex)) {
                return RandomStreamFactory.seeded(simConfigDTO.id, simConfigDTO.runIndex as number);
            }
            this._logger.warning({
                sourceObject: this._name,
                message: "Static random stream requested without a runIndex; using non-reproducible streams",
                data: { simConfigId: simConfigDTO.id }
            });
        }
        return new RandomStreamFactory();
    }

    getLog$(): Observable<LogLine> {
        return this._logger.getObservable$();
    }

    /**
     * The process part of the node id, `<instance>:<process index>`: the instance is ARION_NODE_INSTANCE (the EC2
     * instance id, set by deploy/aws/node-setup.sh) or the host name; the process index is pm2's NODE_APP_INSTANCE,
     * or the process id when the node is not run by pm2. Unique per process, and tells which machine a process is on.
     */
    static processSuffix(env: NodeJS.ProcessEnv = process.env, hostname: string = os.hostname(), pid: number = process.pid): string {
        const clean = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
        const instance = clean(env.ARION_NODE_INSTANCE || hostname || "host");
        const index = env.NODE_APP_INSTANCE !== undefined && env.NODE_APP_INSTANCE !== "" ? clean(env.NODE_APP_INSTANCE) : `p${pid}`;
        return `${instance}:${index}`;
    }

    /** The machine id the node's key is bound to: `config.id`, else the hardware-based machine id. */
    static machineId(config: Pick<NodeConfig, "id">): string {
        return config?.id ? config.id : machineIdSync();
    }

    getLogger(): Logger {
        return this._logger;
    }

    private _getNext$(): Observable<SimConfigDTO> {
        const options: APIRequestOptions = { query: { nodeId: this._id } };
        return this._api.request$("SimConfigController_next", options).pipe(
            timeout({ first: this._requestTimeoutMs }),
            map((response) => response?.payload ?? null)
        );
    }

    /**
     * Posts a result. Retries only transient failures (network errors, timeouts, 5xx, 429); a 409 means the server
     * already holds a result for this run and counts as success. Posting is idempotent through the result's runId,
     * so a retry after a response was lost cannot double count the run.
     */
    private _postResult$(result: ResultDTO): Observable<any> {
        const options: APIRequestOptions = { body: result };
        const maxRetries = 5;
        return defer(() => this._api.request$("ResultController_create", options)).pipe(
            timeout({ first: this._postTimeoutMs }),
            retry({
                count: maxRetries,
                delay: (error, retryCount) => {
                    if (!Node.isTransientError(error)) return throwError(() => error);
                    this._log("Error posting result - retrying", {
                        error: error?.message ? error.message : String(error || "Unknown error"),
                        status: error?.status || 0,
                        attempt: retryCount,
                        maxRetries: maxRetries
                    });
                    return timer(Math.min(2000 * Math.pow(2, retryCount - 1), 32000));
                }
            }),
            catchError((error) => {
                if (error?.status === 409) {
                    this._log("Result already recorded by the server", { runId: result?.runId });
                    return of({ duplicate: true });
                }
                this._log("Failed to post result", {
                    error: error?.message ? error.message : String(error || "Unknown error"),
                    status: error?.status || 0,
                    simConfigId: result?.simConfigId,
                    runId: result?.runId
                });
                return throwError(() => error);
            })
        );
    }

    /**
     * Posts the buffered results, oldest first. Errors (and so holds back new work) while the server cannot take
     * them; a result the server refuses outright is set aside, not retried.
     */
    private _flushBuffer$(): Observable<void> {
        const buffer = this._buffer;
        if (!buffer) return of(undefined);
        return defer(() => {
            const names = buffer.pending();
            if (names.length === 0) return of(undefined);
            this._state = "posting";
            this._log("Posting buffered results", { buffered: names.length });
            return from(names).pipe(
                concatMap((name) => {
                    const claimed = buffer.claim(name);
                    if (!claimed) return of(undefined); // taken by another process
                    return this._postResult$(claimed.result).pipe(
                        map(() => {
                            buffer.done(claimed);
                            this._log("Buffered result recorded", { runId: claimed.result.runId });
                        }),
                        catchError((error) => {
                            if (Node.isTransientError(error) || error?.status === 401 || error?.status === 403 || error?.status === 408) {
                                buffer.release(claimed);
                                return throwError(() => error);
                            }
                            buffer.reject(claimed);
                            this._logger.warning({
                                sourceObject: this._name,
                                message: "Buffered result refused by the server; moved to rejected/",
                                data: { runId: claimed.result.runId, status: error?.status }
                            });
                            return of(undefined);
                        })
                    );
                }),
                ignoreElements(),
                defaultIfEmpty(undefined)
            ) as Observable<void>;
        });
    }

    /** Reports a failed run to the server (best effort: a report that cannot be delivered is only logged). */
    private _reportFailure$(job: SimConfigDTO, error: any): Observable<any> {
        const message: string = error?.message ? error.message : String(error || "Unknown error");
        this._log("Simulation failed", { simConfigId: job.id, runId: job.runId, error: message });
        if (job.runId === undefined || job.runId === null) return of(null);
        return this._api
            .request$("RunController_fail", { params: { id: job.runId }, body: { error: message } } as APIRequestOptions)
            .pipe(
                timeout({ first: this._requestTimeoutMs }),
                map((response: any) => {
                    this._log("Failure reported", response?.payload ?? response);
                    return response;
                }),
                catchError((reportError) => {
                    this._log("Failure report not delivered", { runId: job.runId, error: reportError?.message ?? String(reportError) });
                    return of(null);
                })
            );
    }

    /** True for failures worth retrying: network errors and timeouts (no status), 5xx and 429. */
    static isTransientError(error: any): boolean {
        const status: number = error?.status ?? 0;
        return status === 0 || status === 429 || status >= 500;
    }

    private _log(message: string, data?: any) {
        this._logger.info({ sourceObject: this._name, message: message, data: data });
    }

    /**
     * Routes log events to console output with appropriate formatting.
     *
     * @remarks
     * Internal method that subscribes to the logger's observable and renders
     * log events to the terminal. Implements different output modes based on
     * verbosity and log level.
     *
     * **Output Modes by Log Level:**
     *
     * - **info/warn/error:** Always shown with TSLogger formatting
     *   - Format: `[timestamp] LEVEL: Node: message {data}`
     *   - Colors: Warn=yellow, Error=red, Info=default
     *
     * - **trace:**
     *   - Verbose mode: Full trace output with TSLogger
     *   - Quiet mode: Progress dots (`.`) every clock tick
     *
     * **Progress Indicator (Quiet Mode):**
     * ```
     * .  <- First trace event
     * .  <- Every 1000th trace event (configurable via _counterDiv)
     * ```
     * Provides visual feedback without overwhelming the terminal.
     *
     * **Newline Management:**
     * - Progress dots don't include newlines (`_newline = true` flag)
     * - Next non-trace log prints newline first, then message
     * - Ensures clean output transitions between dots and messages
     *
     * **Format Example (Verbose):**
     * ```
     * [2025-01-09 14:32:15] INFO: Node: Requesting job
     * [2025-01-09 14:32:15] INFO: Node: SimConfig received {"jobId":"sim-123"}
     * [2025-01-09 14:32:16] TRACE: C1: Clock tick 0
     * [2025-01-09 14:32:16] TRACE: C1: Clock tick 1
     * ...
     * ```
     *
     * **Format Example (Quiet):**
     * ```
     * [2025-01-09 14:32:15] INFO: Node: Requesting job
     * [2025-01-09 14:32:15] INFO: Node: SimConfig received {"jobId":"sim-123"}
     * ..........
     * [2025-01-09 14:32:45] INFO: Node: Posting results
     * ```
     *
     * @param logLine - Structured log event from the logger observable
     * @internal
     */
    private _console(logLine: LogLine) {
        const message = (logLine.message?.sourceObject || "Unknown") + ": " + (logLine.message?.message || "");
        const data: any = logLine.message?.data ? JSON.stringify(logLine.message.data) : "";
        switch (logLine.type) {
            case "warn":
                if (this._newline) {
                    process.stdout.write("\n");
                    this._newline = false;
                }
                this._tsLogger.warn(message, data);
                break;
            case "error":
                if (this._newline) {
                    process.stdout.write("\n");
                    this._newline = false;
                }
                this._tsLogger.error(message, data);
                break;
            case "trace":
                if (this._verbose) {
                    this._tsLogger.trace(message, data);
                } else {
                    this._counter++;
                    if (!this._newline) {
                        process.stdout.write(".");
                        this._newline = true;
                    }
                    if (this._counterDiv > 0 && this._counter % this._counterDiv === 0) process.stdout.write(".");
                }
                break;
            default:
                if (this._newline) {
                    process.stdout.write("\n");
                    this._newline = false;
                }
                this._tsLogger.info(message, data);
        }
    }
}

/** The server refused the node's key or id; the node must be authorised again (`login`). */
export class NodeAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NodeAuthError";
    }
}
