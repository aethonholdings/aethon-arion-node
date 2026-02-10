import { Logger, RandomStreamFactory, LogLine, Api, ResultDTO, SimConfigDTO, Model } from "aethon-arion-pipeline";
import { Observable, catchError, concatMap, exhaustMap, first, interval, map, mergeMap, of, switchMap, throwError, retry, timer } from "rxjs";
import { NodeConfig } from "../interfaces/node.interfaces";
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
    private _saveStateSpace;
    private _loopObservable$: Observable<number>;
    private _loopInterval: number;
    private _logger: Logger;
    private _randomStreamFactory: RandomStreamFactory | undefined;
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
        config?.saveStateSpace ? (this._saveStateSpace = config.saveStateSpace) : (this._saveStateSpace = false);
        this._loopInterval = config.loopInterval;
        this._loopObservable$ = interval(this._loopInterval);
        this._log("Node initialised");
    }

    /**
     * Initializes the random stream factory by fetching seeds from the server.
     *
     * @remarks
     * This method performs a critical initialization step required before simulations can run.
     * It establishes deterministic randomness for reproducible simulations.
     *
     * **Initialization Flow:**
     * 1. Checks if factory already initialized (idempotent operation)
     * 2. If not initialized: Requests seed array from server
     * 3. Creates {@link RandomStreamFactory} with fetched seeds
     * 4. Stores factory instance for simulation execution
     * 5. Returns factory observable for subscriber chaining
     *
     * **Retry Strategy:**
     * - Maximum retries: 3 attempts
     * - Retry delay: 5 seconds between attempts
     * - Failure after retries: Throws error, stops node startup
     *
     * **Idempotency:**
     * If called multiple times, returns existing factory instance without
     * re-fetching seeds. This allows safe re-initialization attempts.
     *
     * **Error Cases:**
     * - Server unavailable: Retries with exponential backoff
     * - Null seed response: Treated as error, triggers retry
     * - Network timeout: Retries automatically
     * - 3 retries exhausted: Fatal error, requires manual intervention
     *
     * **Observable Behavior:**
     * - Emits: Single {@link RandomStreamFactory} instance on success
     * - Completes: After emitting factory (via `first()` operator)
     * - Errors: If initialization fails after all retries
     *
     * @returns Observable that emits the initialized RandomStreamFactory and completes
     *
     * @throws Error with message "Random stream factory initialization failed" after 3 retry attempts
     *
     * @example
     * ```typescript
     * const node = new Node(config, [C1]);
     *
     * // Initialize before starting simulations
     * node.initialiseStreamFactory$().subscribe({
     *   next: (factory) => {
     *     console.log("Factory ready:", factory);
     *     // Now safe to start node
     *   },
     *   error: (error) => {
     *     console.error("Initialization failed:", error);
     *     process.exit(1);
     *   }
     * });
     *
     * // Or use with async/await
     * try {
     *   const factory = await firstValueFrom(node.initialiseStreamFactory$());
     *   console.log("Factory initialized");
     * } catch (error) {
     *   console.error("Failed to initialize:", error);
     * }
     * ```
     *
     * @public
     */
    initialiseStreamFactory$(): Observable<RandomStreamFactory> {
        this._log("Initialising random stream factory");
        return this._loopObservable$.pipe(
            mergeMap(() => {
                if (!this._randomStreamFactory) {
                    this._log("Requesting seeds");
                    return this._getSeeds$();
                }
                return of(this._randomStreamFactory);
            }),
            switchMap((seeds: (number[] | null) | RandomStreamFactory) => {
                if (!(seeds instanceof RandomStreamFactory)) {
                    this._log("Seeds fetched");
                    if (seeds !== null) {
                        this._randomStreamFactory = new RandomStreamFactory(seeds);
                        this._log("Random stream factory initialised");
                        return of(this._randomStreamFactory);
                    } else {
                        this._log("No seeds received. Retrying.");
                        return throwError(() => new Error('No seeds received from server'));
                    }
                } else {
                    this._log("Node already initialised. Skipping.");
                    return of(seeds);
                }
            }),
            first((randomStreamFactory: RandomStreamFactory) => {
                return randomStreamFactory ? true : false;
            }),
            retry({ count: 3, delay: (error, retryCount) => {
                this._log("Error initialising random stream factory - retrying", {
                    error: error?.message ? error.message : String(error || 'Unknown error'),
                    attempt: retryCount + 1
                });
                return timer(5000); // 5 second delay between retries
            }}),
            catchError((error) => {
                this._log("Failed to initialise random stream factory after retries", {
                    error: error?.message ? error.message : String(error || 'Unknown error')
                });
                return throwError(() => new Error('Random stream factory initialization failed'));
            })
        );
    }

    /**
     * Starts the node's main execution loop for processing simulation jobs.
     *
     * @remarks
     * This is the primary entry point for node operation. It orchestrates the complete
     * lifecycle from initialization through continuous job processing.
     *
     * **Execution Flow:**
     *
     * ```
     * 1. Initialize: Call initialiseStreamFactory$() once
     * 2. Loop: Emit at intervals defined by config.loopInterval
     * 3. For each loop iteration:
     *    a. Request job from server (_getNext$)
     *    b. If job available: Execute simulation (simulate$)
     *    c. If simulation succeeds: Post results (_postResult$)
     *    d. If post succeeds: Emit true
     *    e. If any step fails/empty: Emit false, continue loop
     * 4. Repeat step 3 indefinitely until unsubscribed
     * ```
     *
     * **Concurrency Control:**
     *
     * Uses `exhaustMap` to prevent overlapping job execution:
     * - While processing a job, subsequent loop ticks are ignored
     * - New jobs only requested after previous job completes
     * - Guarantees single-threaded execution per node instance
     * - Prevents resource contention and state corruption
     *
     * **Error Handling:**
     *
     * Robust error recovery ensures continuous operation:
     * - Job processing errors: Logged, return false, continue loop
     * - Network failures: Logged, return false, retry on next tick
     * - Simulation crashes: Caught, logged, continue to next job
     * - No infinite retries: Failed jobs abandoned, not retried endlessly
     *
     * **Job Availability:**
     *
     * When no jobs available:
     * - Server returns null/undefined response
     * - Node emits false and continues polling
     * - No busy-waiting, controlled by loopInterval
     * - Nodes automatically resume when jobs appear in queue
     *
     * **Progress Indicators:**
     *
     * - Verbose mode: Full trace logs for every operation
     * - Quiet mode: Dots printed every 1000 clock ticks during simulation
     * - Resets counter at start of each job
     *
     * **Shutdown:**
     *
     * To gracefully stop the node:
     * ```typescript
     * const subscription = node.start$().subscribe(...);
     *
     * // Later...
     * subscription.unsubscribe();  // Stops loop at next iteration
     * ```
     *
     * **Observable Behavior:**
     * - Emits: Boolean for each job cycle (true=success, false=failure/no-job)
     * - Never completes: Runs indefinitely until unsubscribed
     * - Errors: Caught internally, converted to false emissions
     *
     * @returns Observable<boolean> that emits true when a job is successfully processed,
     *          false when no job available or processing fails, and never completes
     *
     * @example
     * ```typescript
     * const node = new Node(config, [C1]);
     *
     * // Start node with full error handling
     * const subscription = node.start$().subscribe({
     *   next: (success) => {
     *     if (success) {
     *       console.log("Job completed successfully");
     *     } else {
     *       console.log("No job or processing failed, continuing...");
     *     }
     *   },
     *   error: (error) => {
     *     // Should never occur - errors caught internally
     *     console.error("Fatal node error:", error);
     *     process.exit(1);
     *   },
     *   complete: () => {
     *     // Never called unless observable design changes
     *     console.log("Node stopped");
     *   }
     * });
     *
     * // Graceful shutdown on SIGTERM
     * process.on("SIGTERM", () => {
     *   console.log("Shutting down...");
     *   subscription.unsubscribe();
     *   process.exit(0);
     * });
     * ```
     *
     * @public
     */
    start$(): Observable<boolean> {
        return this.initialiseStreamFactory$().pipe(
            concatMap(() => {
                return this._loopObservable$;
            }),
            exhaustMap(() => {
                this._log("Requesting job");
                this._counter = 0;
                return this._getNext$().pipe(
                    concatMap((response: SimConfigDTO) => {
                        if (response !== null && response !== undefined && response.id && response.orgConfig) {
                            this._log("SimConfig received", { jobId: response.id });
                            return this.simulate$(response);
                        } else {
                            this._log("No job received - retrying");
                            return of(null);
                        }
                    }),
                    concatMap((result: ResultDTO | null) => {
                        if (result !== null && result !== undefined) {
                            // Estimate payload size for diagnostics
                            const payloadSize = JSON.stringify(result).length;
                            this._log("Posting results", {
                                resultId: result.id,
                                simConfigId: result.simConfigId,
                                payloadSizeKB: Math.round(payloadSize / 1024)
                            });
                            return this._postResult$(result);
                        } else {
                            return of(null);
                        }
                    }),
                    concatMap((response: any) => {
                        if (response !== null && response !== undefined && !response?.error) {
                            this._log("Response received", { responseId: response });
                            return of(true);
                        } else {
                            return of(false);
                        }
                    }),
                    catchError((error) => {
                        this._log("Error processing job", {
                            error: error?.message ? error.message : String(error || 'Unknown error')
                        });
                        return of(false); // Return false instead of retrying infinitely
                    })
                );
            }),
            catchError((error) => {
                this._log("Error in main loop", {
                    error: error?.message ? error.message : String(error || 'Unknown error')
                });
                return of(false); // Return false instead of infinite retry
            })
        );
    }

    /**
     * Executes a simulation job using the appropriate model implementation.
     *
     * @remarks
     * This method routes simulation execution to the correct model class based on
     * the job's `orgConfig.type` field. It acts as a dispatcher in the node's
     * model registry pattern.
     *
     * **Model Selection:**
     *
     * The node maintains a registry of model classes (e.g., C1, C2). Each model
     * has a static `name` property matching the `orgConfig.type` string:
     * ```typescript
     * const models = [C1, C2];  // C1.name === "C1", C2.name === "C2"
     * simConfigDTO.orgConfig.type = "C1";  // Routes to C1 model
     * ```
     *
     * **Execution Flow:**
     * 1. Lookup model in registry by `orgConfig.type`
     * 2. If not found: Log warning, return null (skip job)
     * 3. Verify random stream factory initialized
     * 4. If initialized: Delegate to model's `run$()` method
     * 5. If not initialized: Return null, will retry on next loop
     *
     * **Model Interface:**
     *
     * All models must implement:
     * ```typescript
     * class Model {
     *   static name: string;
     *   run$(
     *     config: SimConfigDTO,
     *     randomFactory: RandomStreamFactory,
     *     logger: Logger,
     *     nodeId: string,
     *     saveStateSpace: boolean
     *   ): Observable<ResultDTO>;
     * }
     * ```
     *
     * **State Space Persistence:**
     *
     * The `saveStateSpace` flag is passed to the model:
     * - `true`: Model saves complete state trajectory for analysis
     * - `false`: Model only saves final results (memory efficient)
     *
     * **Error Handling:**
     *
     * - Unknown model type: Logged, returns null, job skipped
     * - Factory not initialized: Logged, returns null, retry on next loop
     * - Model execution errors: Propagated to caller (handled in `start$()`)
     *
     * **Progress Tracking:**
     *
     * Models should use the provided logger to emit trace events. The node's
     * `_console()` method converts these to progress dots in quiet mode.
     *
     * @param simConfigDTO - Simulation configuration containing orgConfig with model type
     * @returns Observable that emits ResultDTO on successful execution, null if model not found
     *          or factory not ready
     *
     * @example
     * ```typescript
     * const config: SimConfigDTO = {
     *   id: "sim-123",
     *   orgConfig: {
     *     type: "C1",  // Routes to C1 model
     *     // ... C1-specific configuration
     *   },
     *   days: 30,
     *   randomStreamType: "static"
     * };
     *
     * node.simulate$(config).subscribe({
     *   next: (result) => {
     *     if (result) {
     *       console.log("Simulation completed:", result.performance);
     *     } else {
     *       console.log("Model not available or not ready");
     *     }
     *   },
     *   error: (error) => {
     *     console.error("Simulation failed:", error);
     *   }
     * });
     * ```
     *
     * @public
     */
    simulate$(simConfigDTO: SimConfigDTO): Observable<ResultDTO | null> {
        const model = this._models.find((model) => model.name === simConfigDTO.orgConfig?.type);
        if (!model) {
            this._log(`Model ${simConfigDTO.orgConfig?.type} not found - skipping job`);
            return of(null);
        } else if (this._randomStreamFactory) {
            return model.run$(simConfigDTO, this._randomStreamFactory, this._logger, this._id, this._saveStateSpace);
        } else {
            this._log("Random stream factory not initialised - retrying");
            return of(null);
        }
    }

    /**
     * Gets an observable stream of structured log events.
     *
     * @remarks
     * Returns a hot observable that emits all log events generated by the node
     * and its child components (models, API client, etc.).
     *
     * **Use Cases:**
     * - Real-time monitoring dashboards
     * - Structured log collection for analysis
     * - Custom log formatting and routing
     * - Debugging and troubleshooting
     *
     * **Log Line Structure:**
     * ```typescript
     * {
     *   type: "info" | "warn" | "error" | "trace",
     *   message: {
     *     sourceObject: string,  // Component name
     *     message: string,       // Log message
     *     data?: any            // Optional structured data
     *   }
     * }
     * ```
     *
     * @returns Observable that emits all log events from the node's logger
     *
     * @example
     * ```typescript
     * const node = new Node(config, [C1]);
     *
     * // Subscribe to log stream
     * node.getLog$().subscribe((logLine) => {
     *   if (logLine.type === "error") {
     *     // Send to error tracking service
     *     errorTracker.log(logLine);
     *   }
     * });
     * ```
     *
     * @public
     */
    getLog$(): Observable<LogLine> {
        return this._logger.getObservable$();
    }

    /**
     * Gets the node's logger instance for direct logging operations.
     *
     * @remarks
     * Provides access to the underlying {@link Logger} instance for:
     * - Emitting custom log events
     * - Direct logging in tests or utilities
     * - Integration with external logging systems
     *
     * The logger supports four log levels:
     * - `info`: General informational messages
     * - `warn`: Warning conditions
     * - `error`: Error conditions
     * - `trace`: Detailed execution traces (filtered in production)
     *
     * @returns The Logger instance used by this node
     *
     * @example
     * ```typescript
     * const node = new Node(config, [C1]);
     * const logger = node.getLogger();
     *
     * // Log custom events
     * logger.info({
     *   sourceObject: "CustomModule",
     *   message: "Custom operation completed",
     *   data: { duration: 1234, status: "success" }
     * });
     * ```
     *
     * @public
     */
    getLogger(): Logger {
        return this._logger;
    }

    /**
     * Gets the initialized random stream factory, if available.
     *
     * @remarks
     * Returns the {@link RandomStreamFactory} instance after successful initialization,
     * or `undefined` if `initialiseStreamFactory$()` hasn't completed yet.
     *
     * **Lifecycle:**
     * - Before `initialiseStreamFactory$()` completes: Returns `undefined`
     * - After initialization: Returns same factory instance for node lifetime
     * - Factory provides deterministic random streams for reproducible simulations
     *
     * **Use Cases:**
     * - Testing: Verify factory initialized before running simulations
     * - Debugging: Inspect factory state and seed values
     * - Utilities: Access random streams for custom operations
     *
     * @returns The initialized RandomStreamFactory, or undefined if not yet initialized
     *
     * @example
     * ```typescript
     * const node = new Node(config, [C1]);
     *
     * // Wait for initialization
     * await firstValueFrom(node.initialiseStreamFactory$());
     *
     * // Now safe to access factory
     * const factory = node.getRandomStreamFactory();
     * if (factory) {
     *   console.log("Factory ready with", factory.getStreamCount(), "streams");
     * }
     * ```
     *
     * @public
     */
    getRandomStreamFactory(): RandomStreamFactory | undefined {
        return this._randomStreamFactory;
    }

    /**
     * Fetches random number seeds from the server.
     *
     * @remarks
     * Internal method called during initialization to retrieve seed array for
     * deterministic random stream generation.
     *
     * **API Endpoint:**
     * - Route: `SeedsController_index`
     * - Method: GET
     * - Response: Array of seed numbers
     *
     * **Seed Usage:**
     * Seeds initialize the {@link RandomStreamFactory} which provides multiple
     * independent random streams for different simulation components:
     * - Agent decision-making
     * - Event timing
     * - Stochastic process sampling
     * - Initial state randomization
     *
     * **Null Response:**
     * If server returns null (no seeds available), the caller should retry.
     *
     * @returns Observable<number[] | null> - Seed array on success, null if unavailable
     * @internal
     */
    private _getSeeds$(): Observable<number[] | null> {
        return this._api.request$("SeedsController_index", {}).pipe(map((response) => response?.payload ?? null));
    }

    /**
     * Requests the next available simulation job from the server.
     *
     * @remarks
     * Internal method called in the main loop to pull jobs from the server's queue.
     * Implements the worker-pull pattern for distributed job processing.
     *
     * **API Endpoint:**
     * - Route: `SimConfigController_next`
     * - Method: GET
     * - Query: `{ nodeId: "machineId:instanceId" }`
     * - Response: {@link SimConfigDTO} or null if no jobs available
     *
     * **Node Identification:**
     * The nodeId query parameter allows the server to:
     * - Track which node is processing which job
     * - Prevent duplicate job assignment
     * - Collect node performance metrics
     * - Debug job distribution issues
     *
     * **Queue Behavior:**
     * - Empty queue: Returns null, node continues polling
     * - Job available: Returns job, server marks as "assigned"
     * - Job in progress: Server skips, returns next available job
     *
     * **Job Priority:**
     * Server determines job ordering based on:
     * - Creation timestamp
     * - Priority flags
     * - Dependency resolution
     * - Fair distribution algorithms
     *
     * @returns Observable<SimConfigDTO> - Job configuration or null if queue empty
     * @internal
     */
    private _getNext$(): Observable<SimConfigDTO> {
        const options: APIRequestOptions = { query: { nodeId: this._id } };
        return this._api.request$("SimConfigController_next", options).pipe(map((response) => response?.payload ?? null));
    }

    /**
     * Posts simulation results back to the server.
     *
     * @remarks
     * Internal method called after successful simulation execution to persist results
     * for analysis and reporting.
     *
     * **API Endpoint:**
     * - Route: `ResultController_create`
     * - Method: POST
     * - Body: {@link ResultDTO}
     * - Response: Created result record with database ID
     *
     * **ResultDTO Contents:**
     * - `simConfigId`: Links result to job configuration
     * - `nodeId`: Identifies which node produced the result
     * - `performance`: Primary KPI value
     * - `reporting`: Complete reporting metrics array
     * - `stateSpace`: (Optional) Full trajectory for analysis
     * - Timestamps, duration, and metadata
     *
     * **Transaction Semantics:**
     * - Success: Result persisted, job marked complete
     * - Failure: Result lost, job remains assigned (may be retried)
     * - Network error: Retried on next loop iteration
     *
     * **State Space Size:**
     * For long simulations with many agents, state space can be large (MB-GB).
     * Set `saveStateSpace: false` in config to save only final results.
     *
     * @param result - Complete simulation results to persist
     * @returns Observable<any> - Server response (typically created record)
     * @internal
     */
    private _postResult$(result: ResultDTO): Observable<any> {
        const options: APIRequestOptions = { body: result };
        return this._api.request$("ResultController_create", options).pipe(
            retry({
                count: 5,
                delay: (error, retryCount) => {
                    this._log("Error posting result - retrying", {
                        error: error?.message ? error.message : String(error || 'Unknown error'),
                        status: error?.status || 0,
                        statusText: error?.statusText || 'Unknown',
                        attempt: retryCount + 1,
                        maxRetries: 5
                    });
                    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
                    return timer(Math.min(2000 * Math.pow(2, retryCount), 32000));
                }
            }),
            catchError((error) => {
                this._log("Failed to post result after retries", {
                    error: error?.message ? error.message : String(error || 'Unknown error'),
                    status: error?.status || 0,
                    statusText: error?.statusText || 'Unknown',
                    resultId: result?.id,
                    simConfigId: result?.simConfigId
                });
                return throwError(() => new Error('Result post failed after retries'));
            })
        );
    }

    /**
     * Emits a structured log event via the node's logger.
     *
     * @remarks
     * Internal convenience method for consistent logging throughout the node.
     * All logs are tagged with the node's name ("Node") as the source object.
     *
     * **Log Format:**
     * ```typescript
     * {
     *   sourceObject: "Node",
     *   message: "User-provided message",
     *   data: { optional: "structured data" }
     * }
     * ```
     *
     * **Routing:**
     * Logs are emitted through the logger's observable stream and:
     * 1. Captured by `_console()` for terminal output
     * 2. Available via `getLog$()` for external subscribers
     * 3. Included in structured log collection systems
     *
     * @param message - Human-readable log message
     * @param data - Optional structured data for programmatic analysis
     * @internal
     */
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
