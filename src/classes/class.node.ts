import { Logger, RandomStreamFactory, LogLine, Api, ResultDTO, SimConfigDTO, Model } from "aethon-arion-pipeline";
import { Observable, catchError, concatMap, defer, exhaustMap, interval, map, of, throwError, retry, timer, timeout } from "rxjs";
import { NodeConfig, validateNodeConfig } from "../interfaces/node.interfaces";
import { Logger as TSLogger } from "tslog";
import { machineIdSync } from "node-machine-id";
import { API, APIRequestOptions } from "aethon-api-types";
import openApi from "../../swagger/swagger.json";

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
    private _loopObservable$: Observable<number>;
    private _loopInterval: number;
    private _logger: Logger;
    private _verbose: boolean;
    private _newline: boolean = false;
    private _tsLogger = new TSLogger();
    private _counter: number = 0;
    private _counterDiv: number = 1000;
    private _models: Model[];

    /**
     * Creates a new distributed simulation node.
     *
     * @remarks
     * The constructor performs comprehensive initialization:
     *
     * **Identity Generation:**
     * - Machine ID: Either from config or hardware-based via `machineIdSync()`
     * - Instance ID: Random 6-digit number (100000-999999)
     * - Node ID: Composite `machineId:instanceId` for cluster-wide uniqueness
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
    constructor(config: NodeConfig, models: Model[]) {
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
        config?.id ? (this._machineId = config.id) : (this._machineId = machineIdSync());
        this._models = models;
        this._instanceId = Math.floor(100000 + Math.random() * 900000).toString();
        this._id = this._machineId + ":" + this._instanceId;
        this._log("Initialising node", { nodeId: this._id });
        // a cap: false disables state space recording even when a simConfig asks for it
        this._saveStateSpace = config.saveStateSpace !== false;
        this._requestTimeoutMs = config.requestTimeoutMs ?? 30000;
        this._postTimeoutMs = config.postTimeoutMs ?? 120000;
        this._loopInterval = config.loopInterval;
        this._loopObservable$ = interval(this._loopInterval);
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
        this._log("Starting job loop", { loopInterval: this._loopInterval });
        return this._loopObservable$.pipe(exhaustMap(() => this.runOnce$()));
    }

    /**
     * Requests one job, simulates it and posts the result. Emits true when a result was recorded, false otherwise;
     * never errors.
     */
    runOnce$(): Observable<boolean> {
        this._log("Requesting job");
        this._counter = 0;
        return this._getNext$().pipe(
            concatMap((response: SimConfigDTO) => {
                if (response !== null && response !== undefined && response.id && response.orgConfig) {
                    this._log("SimConfig received", { jobId: response.id, runId: response.runId, runIndex: response.runIndex });
                    // a run that fails here is reported to the server, which stops dispatching a simConfig whose runs
                    // keep failing (otherwise every node would be handed the same failing job forever)
                    return this.simulate$(response).pipe(
                        catchError((error) => this._reportFailure$(response, error).pipe(map(() => null)))
                    );
                }
                this._log("No job received - retrying");
                return of(null);
            }),
            concatMap((result: ResultDTO | null) => {
                if (result === null || result === undefined) return of(false);
                this._log("Posting results", {
                    simConfigId: result.simConfigId,
                    runId: result.runId,
                    payloadSizeKB: Math.round(JSON.stringify(result).length / 1024)
                });
                return this._postResult$(result).pipe(
                    map((response: any) => {
                        this._log("Result recorded", { resultId: response?.payload?.id ?? response?.id });
                        return true;
                    })
                );
            }),
            catchError((error) => {
                this._log("Error processing job", {
                    error: error?.message ? error.message : String(error || "Unknown error"),
                    status: error?.status
                });
                return of(false);
            })
        );
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
        // defer: a synchronous throw while building the simulation (e.g. an invalid horizon) becomes an error of
        // this job rather than of the loop
        return defer(() =>
            model.run$(
                simConfigDTO,
                this.createRandomStreamFactory(simConfigDTO),
                this._logger,
                this._id,
                saveStateSpace
            )
        );
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
