import { firstValueFrom, lastValueFrom, of, throwError } from "rxjs";
import { LogLine, ResultDTO, SimConfigDTO } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";
import { Node } from "../src/classes/class.node";
import { NodeConfig, validateNodeConfig } from "../src/interfaces/node.interfaces";
import { simpleC1SimulationConfig } from "./init/test.init.simconfig";

const config: NodeConfig = { host: "localhost", port: 3000, basePath: "arion", loopInterval: 100, verbose: false };
const job = (overrides: Partial<SimConfigDTO> = {}): SimConfigDTO =>
    ({ ...JSON.parse(JSON.stringify(simpleC1SimulationConfig)), id: 7, runId: 70, runIndex: 3, runCount: 0, ...overrides }) as SimConfigDTO;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Replaces the node's API client with a stub answering by operation id. */
function stubApi(node: Node, handlers: { [operationId: string]: (options: any) => any }) {
    const calls: { [operationId: string]: number } = {};
    (node as any)._api = {
        request$: (operationId: string, options: any) => {
            calls[operationId] = (calls[operationId] ?? 0) + 1;
            return handlers[operationId](options);
        }
    };
    return calls;
}

describe("Node", () => {
    it("rejects an invalid configuration", () => {
        expect(validateNodeConfig({ host: "", loopInterval: 0 } as NodeConfig).length).toBe(2);
        expect(() => new Node({ host: "x" } as NodeConfig, [C1])).toThrowError(/loopInterval/);
        expect(validateNodeConfig(config)).toEqual([]);
    });

    it("derives distinct, reproducible random streams per run", async () => {
        const node = new Node(config, [C1]);
        const run = (j: SimConfigDTO) => lastValueFrom(node.simulate$(j)) as Promise<ResultDTO>;
        const a = await run(job({ runIndex: 1 }));
        const b = await run(job({ runIndex: 2 }));
        const a2 = await run(job({ runIndex: 1 }));
        expect(a.reporting).toEqual(a2.reporting);
        expect(a.priorityTensor).toEqual(a2.priorityTensor);
        expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
        expect(a.runId).toBe(70);
    });

    it("uses server-issued seed keys so the same replicate and run share streams across optimiser points", async () => {
        const node = new Node(config, [C1]);
        const run = (j: SimConfigDTO) => lastValueFrom(node.simulate$(j)) as Promise<ResultDTO>;
        const a = await run(job({ id: 7, seedKeys: [5, 1, 1] }));
        const b = await run(job({ id: 8, seedKeys: [5, 1, 1] }));
        const c = await run(job({ id: 7, seedKeys: [5, 1, 2] }));
        expect(b.reporting).toEqual(a.reporting);
        expect(JSON.stringify(c.priorityTensor)).not.toEqual(JSON.stringify(a.priorityTensor));
    });

    it("uses the simConfig's state space flag, capped by the node configuration", async () => {
        const on = new Node(config, [C1]);
        const off = new Node({ ...config, saveStateSpace: false }, [C1]);
        const withFlag = job({ saveStateSpace: true });
        expect(((await lastValueFrom(on.simulate$(withFlag))) as ResultDTO).stateSpace!.length).toBeGreaterThan(0);
        expect(((await lastValueFrom(on.simulate$(job()))) as ResultDTO).stateSpace!.length).toBe(0);
        expect(((await lastValueFrom(off.simulate$(withFlag))) as ResultDTO).stateSpace!.length).toBe(0);
    });

    it("reports a failed run to the server and keeps polling", async () => {
        const node = new Node(config, [C1]);
        const bad = job({ runId: 77 });
        (bad.orgConfig as any).clockTickSeconds = 7; // invalid horizon: the simulation throws
        const reports: any[] = [];
        const calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: bad }),
            RunController_fail: (options: any) => { reports.push(options); return of({ payload: { runId: 77, failedRuns: 1 } }); }
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(reports.length).toBe(1);
        expect(reports[0].params.id).toBe(77);
        expect(reports[0].body.error).toContain("whole number");
        expect(calls["ResultController_create"]).toBeUndefined();
        // an undeliverable report does not break the loop
        stubApi(node, { SimConfigController_next: () => of({ payload: bad }), RunController_fail: () => throwError(() => httpError(503)) });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
    });

    it("returns null for an unknown model and errors the job (not the loop) on an invalid horizon", async () => {
        const node = new Node(config, [C1]);
        expect(await lastValueFrom(node.simulate$(job({ orgConfig: { type: "Unknown" } as any })))).toBeNull();
        const bad = job();
        (bad.orgConfig as any).clockTickSeconds = 7;
        await expectAsync(lastValueFrom(node.simulate$(bad))).toBeRejected();
        const calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: bad }),
            ResultController_create: () => of({ payload: { id: 1 } })
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(calls["ResultController_create"]).toBeUndefined();
    });

    it("keeps polling when the server is unreachable", async () => {
        const node = new Node(config, [C1]);
        stubApi(node, { SimConfigController_next: () => throwError(() => httpError(0)) });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
    });

    it("retries transient post failures, treats 409 as recorded and does not retry other 4xx", async () => {
        const node = new Node(config, [C1]);
        let attempts = 0;
        let calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => (++attempts < 2 ? throwError(() => httpError(503)) : of({ payload: { id: 9 } }))
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(true);
        expect(calls["ResultController_create"]).toBe(2);

        calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => throwError(() => httpError(409))
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(true);
        expect(calls["ResultController_create"]).toBe(1);

        calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => throwError(() => httpError(400))
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(calls["ResultController_create"]).toBe(1);
    }, 60000);

    it("times out a hung request and keeps going", async () => {
        const node = new Node({ ...config, requestTimeoutMs: 200 }, [C1]);
        const lines: LogLine[] = [];
        node.getLog$().subscribe((l) => lines.push(l));
        stubApi(node, { SimConfigController_next: () => new (require("rxjs").Observable)(() => {}) });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(lines.some((l) => l.message.message === "Error processing job")).toBe(true);
    });
});
