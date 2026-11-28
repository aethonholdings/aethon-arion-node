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

describe("Local result buffer (step 2.5)", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { ResultBuffer } = require("../src/classes/result-buffer");
    const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n: string) => n.endsWith(".json") || n.includes(".claimed-")) : []);

    it("keeps a result the server cannot take, posts it once after a restart before new work, then removes it", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-buffer-"));
        const first = new Node({ ...config, resultBufferDir: dir }, [C1]);
        stubApi(first, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => throwError(() => httpError(401)) // not retried in place: keeps the test fast
        });
        await expectAsync(firstValueFrom(first.runOnce$())).toBeRejectedWithError(/rejected this node's key/);
        expect(files(dir).length).toBe(1);

        // a restarted process: the buffered result goes first, and new work only after it is recorded
        const second = new Node({ ...config, resultBufferDir: dir }, [C1]);
        const order: string[] = [];
        const posted: any[] = [];
        stubApi(second, {
            SimConfigController_next: () => (order.push("next"), of({ payload: null })),
            ResultController_create: (options: any) => (order.push("post"), posted.push(options.body), of({ payload: { id: 5 } }))
        });
        expect(await firstValueFrom(second.runOnce$())).toBe(false);
        expect(order).toEqual(["post", "next"]);
        expect(posted[0].runId).toBe(70);
        expect(files(dir)).toEqual([]);
        expect(await firstValueFrom(second.runOnce$())).toBe(false);
        expect(order).toEqual(["post", "next", "next"]); // posted once
    });

    it("takes no new work while the buffered results cannot be posted", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-buffer-"));
        new ResultBuffer(dir).save({ runId: 71, simConfigId: 7 } as any);
        const node = new Node({ ...config, resultBufferDir: dir }, [C1]);
        const calls = stubApi(node, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => throwError(() => httpError(403))
        });
        await expectAsync(firstValueFrom(node.runOnce$())).toBeRejectedWithError(/refused this node's id/);
        expect(calls["SimConfigController_next"]).toBeUndefined();
        expect(files(dir).length).toBe(1);
        expect(files(dir)[0]).toMatch(/\.json$/); // released, not left claimed
    });

    it("sets aside a buffered result the server refuses, and does not keep refused results", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-buffer-"));
        new ResultBuffer(dir).save({ runId: 72, simConfigId: 7 } as any);
        const node = new Node({ ...config, resultBufferDir: dir }, [C1]);
        stubApi(node, {
            SimConfigController_next: () => of({ payload: job() }),
            ResultController_create: () => throwError(() => httpError(400))
        });
        expect(await firstValueFrom(node.runOnce$())).toBe(false);
        expect(files(dir)).toEqual([]);
        expect(fs.readdirSync(path.join(dir, "rejected")).length).toBe(1);
    });

    it("lets one process claim a buffered result, and takes over a stale claim", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-buffer-"));
        const a = new ResultBuffer(dir);
        const name = a.save({ runId: 73 } as any);
        const claimed = a.claim(name);
        expect(claimed.result.runId).toBe(73);
        expect(a.claim(name)).toBeNull();
        expect(a.pending()).toEqual([]);
        expect(new ResultBuffer(dir, -1).pending().length).toBe(1); // a dead process's claim
        a.release(claimed);
        expect(a.pending()).toEqual([name]);
        expect(a.count()).toBe(1);
    });

    it("can be switched off", () => {
        expect((new Node({ ...config, resultBufferDir: false }, [C1]) as any)._buffer).toBeNull();
    });
});

describe("Self-check (step 2.6)", () => {
    it("stops for a restart after consecutive failed runs, but not for server errors", async () => {
        const node = new Node({ ...config, maxConsecutiveFailures: 2, loopInterval: 100, resultBufferDir: false }, [C1]);
        let next = 0;
        stubApi(node, {
            // two server errors first (must not count), then jobs whose simulation fails
            SimConfigController_next: () => (++next <= 2 ? throwError(() => httpError(503)) : of({ payload: job({ orgConfig: { type: "C1", configuration: null } } as any) })),
            RunController_fail: () => of({ payload: {} }),
            NodeController_heartbeat: () => of({ payload: {} })
        });
        (node as any).nextDelay = () => 0; // no backoff wait in the test
        await lastValueFrom(node.start$(), { defaultValue: undefined });
        expect(node.recycle).toBe("2 consecutive failed runs");
        expect(node.getStatus().failedRuns).toBe(2);
        expect(next).toBe(4);
    }, 30000);

    it("resets the count when a run succeeds, and checks memory", () => {
        const node = new Node({ ...config, maxConsecutiveFailures: 3, maxRssMb: 100 }, [C1]);
        (node as any)._consecutiveFailures = 2;
        expect(node.selfCheck(50 * 1024 * 1024)).toBeNull();
        (node as any)._consecutiveFailures = 3;
        expect(node.selfCheck(50 * 1024 * 1024)).toBe("3 consecutive failed runs");
        (node as any)._consecutiveFailures = 0;
        expect(node.selfCheck(150 * 1024 * 1024)).toBe("resident memory 150 MB above 100 MB");
        expect(new Node({ ...config, maxConsecutiveFailures: 0 }, [C1]).selfCheck(1e12)).toBeNull();
        expect(validateNodeConfig({ ...config, maxRssMb: -1 }).length).toBe(1);
    });
});

describe("Remote commands (step 3.1)", () => {
    const reply = (commands: any[]) => of({ payload: { commands, expectedVersion: null } });

    it("pauses and resumes, carries each command out once and acknowledges it in the next heartbeat", async () => {
        const node = new Node({ ...config, resultBufferDir: false, heartbeatIntervalMs: 0 }, [C1]);
        const sent: any[] = [];
        let commands: any[] = [];
        const calls = stubApi(node, {
            NodeController_heartbeat: (options: any) => (sent.push(options.body), reply(commands)),
            SimConfigController_next: () => of({ payload: null })
        });
        commands = [{ type: "pause", id: 11 }];
        await lastValueFrom(node.heartbeat$());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(node.hold).toBe("paused");
        expect(node.getStatus().state).toBe("paused");
        // the paused loop takes no work
        const loop = node.start$().subscribe();
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(calls["SimConfigController_next"]).toBeUndefined();
        // the resent command (acknowledgement not yet received) is not carried out twice; both acks go out
        commands = [{ type: "pause", id: 11 }, { type: "resume", id: 12 }];
        await lastValueFrom(node.heartbeat$());
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sent[sent.length - 1].acks).toEqual([{ commandId: 11, ok: true }]);
        expect(node.hold).toBeNull();
        commands = [];
        await lastValueFrom(node.heartbeat$());
        expect(sent[sent.length - 1].acks).toEqual([{ commandId: 11, ok: true, message: "already carried out" }, { commandId: 12, ok: true }]);
        await lastValueFrom(node.heartbeat$());
        expect(sent[sent.length - 1].acks).toBeUndefined(); // acknowledged once delivered
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(calls["SimConfigController_next"]).toBeGreaterThan(0); // resumed: takes work again
        loop.unsubscribe();
    });

    it("restarts: sends the acknowledgement, then the job loop ends with a recycle reason", async () => {
        const node = new Node({ ...config, resultBufferDir: false, heartbeatIntervalMs: 0 }, [C1]);
        const sent: any[] = [];
        let commands: any[] = [];
        stubApi(node, {
            NodeController_heartbeat: (options: any) => (sent.push(options.body), reply(commands)),
            SimConfigController_next: () => of({ payload: null })
        });
        let completed = false;
        node.start$().subscribe({ complete: () => (completed = true) });
        commands = [{ type: "restart", id: 21 }];
        await lastValueFrom(node.heartbeat$());
        commands = [];
        for (let i = 0; i < 40 && !completed; i++) await new Promise((resolve) => setTimeout(resolve, 50));
        expect(completed).toBe(true);
        expect(node.recycle).toBe("restart requested from the Monitor");
        expect(sent.some((b) => (b.acks ?? []).some((a: any) => a.commandId === 21 && a.ok))).toBe(true);
    });

    it("refuses set-processes outside pm2 and leaves it to process 0 under pm2", async () => {
        const node = new Node({ ...config, resultBufferDir: false }, [C1]);
        const sent: any[] = [];
        let commands: any[] = [{ type: "set-processes", id: 31, args: { processes: 2 } }];
        stubApi(node, { NodeController_heartbeat: (options: any) => (sent.push(options.body), reply(commands)) });
        const saved = { pm_id: process.env.pm_id, NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE };
        try {
            delete process.env.pm_id;
            await lastValueFrom(node.heartbeat$());
            await new Promise((resolve) => setTimeout(resolve, 10));
            process.env.pm_id = "3";
            process.env.NODE_APP_INSTANCE = "1";
            commands = [{ type: "set-processes", id: 32, args: { processes: 2 } }, { type: "explode", id: 33 }];
            await lastValueFrom(node.heartbeat$());
            await new Promise((resolve) => setTimeout(resolve, 10));
            commands = [];
            await lastValueFrom(node.heartbeat$());
            expect(sent.flatMap((b) => b.acks ?? []).sort((a: any, b: any) => a.commandId - b.commandId)).toEqual([
                { commandId: 31, ok: false, message: "not running under pm2" },
                { commandId: 32, ok: true, message: "left to process 0 of the instance" },
                { commandId: 33, ok: false, message: "unknown command explode" }
            ]);
        } finally {
            for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
        }
    });
});
