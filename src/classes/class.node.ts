import {
    Logger,
    Organisation,
    RandomStreamFactory,
    Simulation,
    SimulationConfig,
    StepOutput,
    LogLine,
    Api,
    ResultDTO,
    SimConfigDTO,
    StateSpacePointDTO,
    Model
} from "aethon-arion-pipeline";
import {
    Observable,
    catchError,
    concatMap,
    exhaustMap,
    first,
    interval,
    map,
    mergeMap,
    of,
    reduce,
    switchMap,
    tap
} from "rxjs";
import { NodeConfig } from "../interfaces/node.interfaces";
import { Logger as TSLogger } from "tslog";
import { machineIdSync } from "node-machine-id";
import { API, APIRequestOptions } from "aethon-api-types";
import openApi from "../../swagger/swagger.json";

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

    // initialise the random stream factory
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
                        return of(null as unknown as RandomStreamFactory);
                    }
                } else {
                    this._log("Node already initialised. Skipping.");
                    return of(seeds);
                }
            }),
            first((randomStreamFactory: RandomStreamFactory) => {
                return randomStreamFactory ? true : false;
            }),
            catchError((error, caught) => {
                return caught;
            })
        );
    }

    // start running the node
    start$(simConfig?: SimConfigDTO): Observable<boolean> {
        return this.initialiseStreamFactory$().pipe(
            concatMap(() => {
                return this._loopObservable$;
            }),
            exhaustMap(() => {
                this._log("Requesting job");
                this._counter = 0;
                return this._getNext$().pipe(
                    concatMap((response: SimConfigDTO) => {
                        if (response && response.id && response.orgConfig) {
                            this._log("SimConfig received", { jobId: response.id });
                            const simulationConfig = {
                                days: response.days,
                                debug: [],
                                randomStreamType: response.randomStreamType,
                                orgConfig: response.orgConfig
                            } as SimulationConfig;
                            const simulationFactory = this._models
                                .find((model) => model.getName() === response.orgConfig?.type)
                                ?.getSimulationFactory();
                            if (!simulationFactory) {
                                this._logger.error({
                                    sourceObject: this._name,
                                    message: "No simulation factory found for type " + response.orgConfig.type
                                });
                                return of(null);
                            } else {
                                let simulation = simulationFactory.newSimulation(
                                    simulationConfig,
                                    this._logger,
                                    this._randomStreamFactory as RandomStreamFactory // this should be safe as the stream factory is initialised before the loop starts
                                );
                                return this.simulate$(simulation, response.runCount, response.id);
                            }
                        } else {
                            this._log("No job received - retrying");
                            return of(null);
                        }
                    }),
                    concatMap((result: ResultDTO | null) => {
                        if (result) {
                            this._log("Posting results");
                            return this._postResult$(result);
                        } else {
                            return of(null);
                        }
                    }),
                    concatMap((response: any) => {
                        if (response && !response?.error) {
                            this._log("Response received", { responseId: response });
                            return of(true);
                        } else {
                            return of(false);
                        }
                    }),
                    concatMap((success: boolean) => {
                        // this is weird; required to make the observable wait for the response, but feels very redundant and repetitive
                        if (success) {
                            return of(true);
                        } else {
                            return of(false);
                        }
                    }),
                    catchError((error, caught) => {
                        return caught;
                    })
                );
            }),
            catchError((error, caught) => {
                return caught;
            })
        );
    }

    // run one simulation run
    simulate$(simulation: Simulation, runCount: number, simConfigId: number): Observable<ResultDTO> {
        const startTime = new Date();
        let organisation: Organisation;
        let clockTick: number = 0;
        return simulation.run$().pipe(
            map((runOutput: StepOutput) => {
                organisation = runOutput.organisation;
                clockTick = runOutput.clockTick;
                return {
                    clockTick: runOutput.clockTick,
                    board: runOutput.organisation.getBoard().getPlan().reporting,
                    agentStates: runOutput.organisation.getAgents().getAgentStateArray(),
                    plant: runOutput.organisation.getPlant().getStateTensor(),
                    reporting: runOutput.organisation.getReporting().getReportingTensor(),
                    priorityTensor: runOutput.organisation.getAgents().getTensors().priorityTensor
                } as StateSpacePointDTO;
            }),
            reduce((stateSpace: StateSpacePointDTO[], stateSpacePoint: StateSpacePointDTO) => {
                if (this._saveStateSpace) stateSpace.push(JSON.parse(JSON.stringify(stateSpacePoint)));
                return stateSpace;
            }, [] as StateSpacePointDTO[]),
            map((results: StateSpacePointDTO[]) => {
                const endTime = new Date();
                return {
                    simConfigId: simConfigId,
                    runCount: runCount,
                    nodeId: this._id,
                    start: startTime,
                    end: endTime,
                    clockTick: clockTick,
                    durationSec: (endTime.getTime() - startTime.getTime()) / 1000,
                    agentStates: organisation.getAgents().getAgentStateArray(),
                    board: organisation.getBoard().getPlan().reporting,
                    plant: organisation.getPlant().getStateTensor(),
                    reporting: organisation.getReporting().getReportingTensor(),
                    priorityTensor: organisation.getAgents().getTensors().priorityTensor,
                    stateSpace: results
                } as ResultDTO;
            })
        );
    }

    getLog$(): Observable<LogLine> {
        return this._logger.getObservable$();
    }

    getLogger(): Logger {
        return this._logger;
    }

    getRandomStreamFactory(): RandomStreamFactory | undefined {
        return this._randomStreamFactory;
    }

    private _getSeeds$(): Observable<number[] | null> {
        return this._api.request$("SeedsController_index", {}).pipe(map((response) => response.payload));
    }

    private _getNext$(): Observable<SimConfigDTO> {
        const options: APIRequestOptions = { query: { nodeId: this._id } };
        return this._api.request$("SimConfigController_next", options).pipe(map((response) => response.payload));
    }

    private _postResult$(result: ResultDTO): Observable<any> {
        const options: APIRequestOptions = { body: result };
        return this._api.request$("ResultController_create", options);
    }

    private _log(message: string, data?: any) {
        this._logger.info({ sourceObject: this._name, message: message, data: data });
    }

    private _console(logLine: LogLine) {
        const message = logLine.message.sourceObject + ": " + logLine.message.message;
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
                    if (this._counter % this._counterDiv === 0) process.stdout.write(".");
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
