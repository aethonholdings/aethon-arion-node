import { firstValueFrom, lastValueFrom, toArray, of } from "rxjs";
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
