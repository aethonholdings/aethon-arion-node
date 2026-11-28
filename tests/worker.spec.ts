import { firstValueFrom, lastValueFrom, toArray, of, throwError } from "rxjs";
import { ResultDTO, SimConfigDTO } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";
import { Node } from "../src/classes/class.node";
import { NodeConfig } from "../src/interfaces/node.interfaces";
import { RunCancelledError, RunEvent, WorkerSimulationRunner } from "../src/classes/simulation-runner";
import { simpleC1SimulationConfig } from "./init/test.init.simconfig";

const job = (overrides: Partial<SimConfigDTO> = {}): SimConfigDTO =>
    ({ ...JSON.parse(JSON.stringify(simpleC1SimulationConfig)), id: 7, runId: 70, runIndex: 3, runCount: 0, seedKeys: [11, 2, 3], ...overrides }) as SimConfigDTO;
const config: NodeConfig = { host: "localhost", port: 3000, basePath: "arion", loopInterval: 100, verbose: false };
// compare results without their timing fields
const comparable = (r: any) => {
    const { start, end, durationSec, ...rest } = r;
    return JSON.parse(JSON.stringify(rest));
};

describe("Simulation in a worker thread", () => {
    let runner: WorkerSimulationRunner;
    beforeEach(() => (runner = new WorkerSimulationRunner()));
    afterEach(async () => runner.close());

    it("produces the same result as a main-thread run, and reports progress up to the last tick", async () => {
        const events: RunEvent[] = await lastValueFrom(runner.run$(job(), "node-1", false).pipe(toArray()));
        const result = (events[events.length - 1] as any).result as ResultDTO;
        const local = (await lastValueFrom(new Node(config, [C1]).simulate$(job()))) as ResultDTO;
        expect(comparable(result)).toEqual({ ...comparable(local), nodeId: "node-1" });
        const progress = events.filter((e) => e.type === "progress") as any[];
        expect(progress.length).toBeGreaterThan(0);
        expect(progress[progress.length - 1].clockTick).toBe(progress[progress.length - 1].totalClockTicks);
        expect(runner.busy).toBe(false);
    }, 60000);

    it("cancels a run within a second and runs the next one in a new worker", async () => {
        const long = runner.run$(job({ days: 200 } as any), "node-1", false);
        const outcome = lastValueFrom(long).then(() => "finished", (error) => error);
        await new Promise((resolve) => setTimeout(resolve, 1500)); // the worker is mid-run
        const t0 = Date.now();
        expect(await runner.cancel("test")).toBe(true);
        const error = await outcome;
        expect(error).toEqual(jasmine.any(RunCancelledError));
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(await runner.cancel()).toBe(false); // nothing left to cancel
        const next = await lastValueFrom(runner.run$(job(), "node-1", false));
        expect(next.type).toBe("result");
    }, 60000);

    it("fails a run that throws in the worker, and keeps working", async () => {
        await expectAsync(lastValueFrom(runner.run$(job({ days: 0.0001 } as any), "node-1", false))).toBeRejected();
        const next = await lastValueFrom(runner.run$(job(), "node-1", false));
        expect(next.type).toBe("result");
    }, 60000);

    it("refuses a second run while one is in progress", async () => {
        const first = lastValueFrom(runner.run$(job({ days: 50 } as any), "node-1", false)).catch(() => undefined);
        await expectAsync(lastValueFrom(runner.run$(job(), "node-1", false))).toBeRejectedWithError(/already in progress/);
        await runner.cancel();
        await first;
    }, 60000);
});

describe("Node with simulationThread: worker", () => {
    it("simulates in the worker, reports its state and progress, and counts runs", async () => {
        const node = new Node({ ...config, simulationThread: "worker" }, [C1]);
        let status: any = null;
        let posted: any = null;
        (node as any)._api = {
            request$: (operationId: string, options: any) => {
                if (operationId === "SimConfigController_next") return of({ payload: job({ days: 20 } as any) });
                if (operationId === "ResultController_create") { posted = options.body; return of({ payload: { id: 1 } }); }
                throw new Error(operationId);
            }
        };
        const run = firstValueFrom(node.runOnce$());
        // the main thread is free while the worker simulates: the status can be read mid-run
        for (let i = 0; i < 50 && !(status?.state === "simulating" && status.run.clockTick > 0); i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            status = node.getStatus();
        }
        expect(status.state).toBe("simulating");
        expect(status.run.runId).toBe(70);
        expect(status.run.clockTick).toBeGreaterThan(0);
        expect(status.run.totalClockTicks).toBeGreaterThan(status.run.clockTick);
        expect(await run).toBe(true);
        expect(posted.runId).toBe(70);
        const after = node.getStatus();
        expect([after.state, after.run, after.completedRuns, after.failedRuns]).toEqual(["idle", null, 1, 0]);
        expect(after.averageRunMs).toBeGreaterThan(0);
        await node.close();
    }, 120000);

    it("rejects an unknown simulation thread setting", () => {
        expect(() => new Node({ ...config, simulationThread: "gpu" } as any, [C1])).toThrowError(/simulationThread/);
    });
});

describe("Node process ids", () => {
    it("are <machine id>:<instance>:<process index>, from the environment, pm2 and the host", () => {
        expect(Node.processSuffix({ ARION_NODE_INSTANCE: "i-0abc", NODE_APP_INSTANCE: "2" }, "host", 99)).toBe("i-0abc:2");
        expect(Node.processSuffix({ NODE_APP_INSTANCE: "0" }, "mini-2.local", 99)).toBe("mini-2.local:0");
        expect(Node.processSuffix({}, "mini-2.local", 4321)).toBe("mini-2.local:p4321"); // not run by pm2
        expect(Node.processSuffix({ ARION_NODE_INSTANCE: "bad:id/x" }, "h", 1)).toBe("bad-id-x:p1"); // no extra separators
        const node = new Node({ ...config, id: "fleet" }, [C1]);
        expect(node.getStatus().nodeId).toMatch(/^fleet:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/);
    });

    it("differ between pm2 processes on one instance", () => {
        const ids = ["0", "1", "2", "3"].map((index) => Node.processSuffix({ ARION_NODE_INSTANCE: "i-1", NODE_APP_INSTANCE: index }, "h", 1));
        expect(new Set(ids).size).toBe(4);
    });
});

describe("Node heartbeats", () => {
    it("report the process's state, run progress, counters, memory and code version", async () => {
        const node = new Node({ ...config, id: "fleet", simulationThread: "worker", heartbeatIntervalMs: 200 }, [C1]);
        const heartbeats: any[] = [];
        (node as any)._api = {
            request$: (operationId: string, options: any) => {
                if (operationId === "NodeController_heartbeat") { heartbeats.push(options.body); return of({ payload: { commands: [], expectedVersion: null } }); }
                if (operationId === "SimConfigController_next") return of({ payload: job({ days: 20 } as any) });
                if (operationId === "ResultController_create") return of({ payload: { id: 1 } });
                throw new Error(operationId);
            }
        };
        const subscription = node.start$().subscribe();
        // heartbeats keep arriving while a run is in progress
        for (let i = 0; i < 100 && !heartbeats.some((h) => h.state === "simulating" && h.run?.clockTick > 0); i++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        subscription.unsubscribe();
        await node.close();
        const during = heartbeats.find((h) => h.state === "simulating" && h.run?.clockTick > 0);
        expect(during).toBeDefined();
        expect(during.nodeId).toMatch(/^fleet:/);
        expect(during.run).toEqual(jasmine.objectContaining({ runId: 70, simConfigId: 7 }));
        expect(during.run.totalClockTicks).toBeGreaterThan(during.run.clockTick);
        expect(during.memoryMb).toBeGreaterThan(0);
        expect(during.version).toBe("dev"); // run from source in tests
        expect(typeof during.startedAt).toBe("string");
    }, 120000);

    it("survive a server that does not answer, and note the version the server expects", async () => {
        const node = new Node({ ...config, heartbeatIntervalMs: 1000 }, [C1]);
        (node as any)._api = { request$: () => throwError(() => Object.assign(new Error("down"), { status: 503 })) };
        expect(await firstValueFrom(node.heartbeat$())).toBeNull();
        const warnings: any[] = [];
        node.getLogger().getObservable$().subscribe((line: any) => { if (line.type === "warn") warnings.push(line.message); });
        (node as any)._api = { request$: () => of({ payload: { commands: [], expectedVersion: "abc1234" } }) };
        expect((await firstValueFrom(node.heartbeat$())).expectedVersion).toBe("abc1234");
        expect(warnings.some((w) => /other code/.test(w.message))).toBe(true);
    });

    it("read the code version written by the build", () => {
        const fs = require("fs"), os = require("os"), path = require("path");
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "v-")), "version.txt");
        fs.writeFileSync(file, "abc1234\n");
        expect(Node.codeVersion(file)).toBe("abc1234");
        expect(Node.codeVersion(file + ".missing")).toBe("dev");
        expect(() => new Node({ ...config, heartbeatIntervalMs: -1 }, [C1])).toThrowError(/heartbeatIntervalMs/);
    });
});

describe("Node backoff (step 2.1)", () => {
    it("doubles the wait after each consecutive error, with jitter between half and one and a half times, up to a cap", () => {
        const at = (r: number) => () => r;
        expect([1, 2, 3, 4, 5, 6].map((k) => Node.backoffDelay(k, 2000, 60000, at(0.5)))).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
        expect(Node.backoffDelay(1, 2000, 60000, at(0))).toBe(1000);
        expect(Node.backoffDelay(1, 2000, 60000, at(0.999999))).toBe(3000);
        expect(Node.backoffDelay(30, 2000, 60000, at(0.5))).toBe(60000);
    });

    it("asks again at once after a result, after the poll interval with no work, and backs off after errors", async () => {
        const node = new Node({ ...config, loopInterval: 300, backoffBaseMs: 200, heartbeatIntervalMs: 0 }, [C1]);
        let call = 0;
        // requests: error, error, no work, a job (recorded), no work
        (node as any)._api = {
            request$: (operationId: string) => {
                if (operationId === "ResultController_create") return of({ payload: { id: 1 } });
                call++;
                if (call <= 2) return throwError(() => Object.assign(new Error("down"), { status: 503 }));
                if (call === 4) return of({ payload: job() });
                return of({ payload: null });
            }
        };
        // the delay chosen after each request, and the state while waiting
        const delays: number[] = [];
        const states: string[] = [];
        const original = node.nextDelay.bind(node);
        (node as any).nextDelay = (random?: () => number) => {
            const delay = original(random);
            delays.push(delay);
            setTimeout(() => states.push(node.getStatus().state), 0);
            return delay;
        };
        const t0 = Date.now();
        const subscription = node.start$().subscribe();
        while (delays.length < 5) await new Promise((resolve) => setTimeout(resolve, 20));
        subscription.unsubscribe();
        expect(delays[0]).toBeGreaterThanOrEqual(100); // after error 1: 200 x U(0.5, 1.5)
        expect(delays[0]).toBeLessThanOrEqual(300);
        expect(delays[1]).toBeGreaterThanOrEqual(200); // after error 2: 400 x U(0.5, 1.5)
        expect(delays[1]).toBeLessThanOrEqual(600);
        expect(delays[2]).toBe(300); // no work: the poll interval
        expect(delays[3]).toBe(0); // after a recorded result: at once
        expect(delays[4]).toBe(300);
        expect(states.slice(0, 2)).toEqual(["backing-off", "backing-off"]);
        expect(states[2]).toBe("idle");
        expect(Date.now() - t0).toBeGreaterThanOrEqual(delays[0] + delays[1] + delays[2]); // the waits happened
    }, 60000);

    it("rejects an invalid backoff setting", () => {
        expect(() => new Node({ ...config, backoffBaseMs: 0 }, [C1])).toThrowError(/backoffBaseMs/);
    });
});

describe("Node run cancellation (step 2.3)", () => {
    it("stops a run the server no longer needs, without reporting a failure, and takes the next job", async () => {
        const node = new Node({ ...config, simulationThread: "worker", heartbeatIntervalMs: 200, loopInterval: 100 }, [C1]);
        const calls: string[] = [];
        let jobs = 0;
        (node as any)._api = {
            request$: (operationId: string, options: any) => {
                calls.push(operationId);
                if (operationId === "SimConfigController_next") return of({ payload: ++jobs === 1 ? job({ days: 200 } as any) : null });
                if (operationId === "NodeController_heartbeat") {
                    // the server answers a heartbeat about run 70 mid-run with a cancel
                    const run = options.body.run;
                    return of({ payload: { commands: run?.runId === 70 && run.clockTick > 0 ? [{ type: "cancel", runId: 70, reason: "its simulation configuration has converged" }] : [], expectedVersion: null } });
                }
                if (operationId === "RunController_fail") return of({ payload: {} });
                return of({ payload: { id: 1 } });
            }
        };
        const t0 = Date.now();
        const subscription = node.start$().subscribe();
        while (node.cancelledRuns === 0 && Date.now() - t0 < 60000) await new Promise((resolve) => setTimeout(resolve, 50));
        while (jobs < 2 && Date.now() - t0 < 60000) await new Promise((resolve) => setTimeout(resolve, 50));
        subscription.unsubscribe();
        await node.close();
        expect(node.cancelledRuns).toBe(1);
        expect(Date.now() - t0).toBeLessThan(30000); // a 200-day run, cut short
        expect(calls).not.toContain("RunController_fail");
        expect(calls).not.toContain("ResultController_create");
        expect(node.getStatus().failedRuns).toBe(0);
        expect(jobs).toBeGreaterThanOrEqual(2); // asked for the next job
    }, 90000);

    it("ignores a cancel for another run", async () => {
        const node = new Node({ ...config, simulationThread: "worker" }, [C1]);
        (node as any)._run = { runId: 1, clockTick: 0, totalClockTicks: 10, startedAt: "" };
        const spy = spyOn(node, "cancelRun").and.returnValue(Promise.resolve(true));
        (node as any)._handleCommands([{ type: "cancel", runId: 2 }, { type: "unknown" }]);
        expect(spy).not.toHaveBeenCalled();
        (node as any)._handleCommands([{ type: "cancel", runId: 1, reason: "x" }]);
        expect(spy).toHaveBeenCalledWith("x");
        await node.close();
    });
});
