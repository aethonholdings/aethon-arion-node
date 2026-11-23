import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { AddressInfo } from "net";
import { firstValueFrom, lastValueFrom, toArray, take } from "rxjs";
import { spawn } from "child_process";
import { C1 } from "aethon-arion-c1";
import { Node, NodeAuthError } from "../src/classes/class.node";
import { NodeConfig } from "../src/interfaces/node.interfaces";
import { credentialsPath, loadCredentials, parseServerAddress, saveCredentials, withServer } from "../src/auth/credentials";
import { login } from "../src/auth/login";

const root = path.resolve(__dirname, "..");

/** A stub Arion server: POST /arion/auth/node issues "the-key" to operator/secret; other requests need that key. */
function stubServer(): Promise<{ url: string; requests: { method: string; url: string; authorization?: string; body: any }[]; close: () => void }> {
    const requests: { method: string; url: string; authorization?: string; body: any }[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : undefined;
            requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body });
            const send = (status: number, payload: any) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: status < 400, payload }));
            };
            if (req.method === "POST" && req.url === "/arion/auth/node") {
                if (body?.username === "operator" && body?.password === "secret") return send(201, { nodeId: body.nodeId, key: "the-key", authorisedAt: "2026-01-01T00:00:00.000Z" });
                return send(401, { message: "Invalid credentials" });
            }
            if (req.headers.authorization !== "Bearer the-key") return send(401, { message: "Missing, invalid or revoked node key" });
            return send(200, null); // no job available
        });
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
            resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() })
        )
    );
}

describe("Node authentication", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arion-node-auth-"));
    const config: NodeConfig = { id: "machine-1", host: "unused", basePath: "arion", loopInterval: 100, verbose: false };

    it("parses server addresses, defaulting to https and refusing plain http to a remote host", () => {
        expect(parseServerAddress("arion.example.com").origin).toBe("https://arion.example.com");
        expect(parseServerAddress("10.0.0.5:8443").origin).toBe("https://10.0.0.5:8443");
        expect(parseServerAddress("localhost:3000").origin).toBe("http://localhost:3000");
        expect(parseServerAddress("127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
        expect(parseServerAddress("https://arion.example.com/").origin).toBe("https://arion.example.com");
        expect(() => parseServerAddress("http://10.0.0.5:3000")).toThrowError(/allow-http/);
        expect(parseServerAddress("http://10.0.0.5:3000", true).origin).toBe("http://10.0.0.5:3000");
        expect(() => parseServerAddress("ftp://x")).toThrowError(/scheme/);
        expect(() => parseServerAddress("")).toThrowError(/required/);
        expect(withServer(config, "https://arion.example.com")).toEqual(jasmine.objectContaining({ protocol: "https", host: "arion.example.com", port: 443 }));
        expect(withServer(config, "http://127.0.0.1:3000")).toEqual(jasmine.objectContaining({ protocol: "http", host: "127.0.0.1", port: 3000 }));
    });

    it("saves the credentials readable by the user only and loads them, or takes them from the environment", () => {
        const file = path.join(dir, "sub", "creds.json");
        saveCredentials(file, { serverUrl: "https://a", nodeId: "m", key: "k", authorisedAt: "t" });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(loadCredentials(file, {})).toEqual({ serverUrl: "https://a", nodeId: "m", key: "k", authorisedAt: "t" });
        expect(loadCredentials(path.join(dir, "none.json"), {})).toBeNull();
        expect(loadCredentials(path.join(dir, "none.json"), { ARION_SERVER_URL: "https://b", ARION_NODE_KEY: "k2" })?.key).toBe("k2");
        expect(credentialsPath({ ARION_NODE_CREDENTIALS: file })).toBe(file);
        expect(credentialsPath({})).toBe(path.join(os.homedir(), ".arion", "node-credentials.json"));
    });

    it("logs in with the machine id and returns the issued key; reports invalid credentials", async () => {
        const server = await stubServer();
        try {
            const answers = (list: string[]) => async () => list.shift() as string;
            const credentials = await login({ machineId: "machine-1", prompt: answers([server.url, "operator", "secret"]), log: () => undefined });
            expect(credentials).toEqual({ serverUrl: server.url, nodeId: "machine-1", key: "the-key", authorisedAt: "2026-01-01T00:00:00.000Z" });
            expect(server.requests[0].body).toEqual(jasmine.objectContaining({ nodeId: "machine-1", username: "operator", password: "secret", hostname: os.hostname() }));
            await expectAsync(login({ machineId: "machine-1", prompt: answers([server.url, "operator", "wrong"]), log: () => undefined })).toBeRejectedWithError(/Invalid credentials/);
        } finally {
            server.close();
        }
    });

    it("sends its key with every request and stops when the server rejects it", async () => {
        const server = await stubServer();
        try {
            const good = new Node(withServer(config, server.url), [C1], { key: "the-key" });
            expect(await firstValueFrom(good.runOnce$())).toBe(false); // no job, but admitted
            expect(server.requests[0].authorization).toBe("Bearer the-key");
            expect(server.requests[0].url).toMatch(/nodeId=machine-1(:|%3A)/);
            const revoked = new Node(withServer(config, server.url), [C1], { key: "old-key" });
            await expectAsync(lastValueFrom(revoked.start$().pipe(take(3), toArray()))).toBeRejectedWith(jasmine.any(NodeAuthError));
        } finally {
            server.close();
        }
    });

    it("authorises from the command line and saves the key (login), then refuses to start unauthorised without a terminal", async () => {
        const server = await stubServer();
        const file = path.join(dir, "cli", "creds.json");
        const configFile = path.join(dir, "config.json");
        fs.writeFileSync(configFile, JSON.stringify(config));
        const run = (args: string[], input: string, env: { [k: string]: string } = {}): Promise<{ status: number | null; out: string }> =>
            new Promise((resolve) => {
                const child = spawn(process.execPath, ["-r", require.resolve("ts-node/register/transpile-only", { paths: [root] }), path.join(root, "src", "main.ts"), ...args], {
                    cwd: os.tmpdir(),
                    env: { ...process.env, TS_NODE_PROJECT: path.join(root, "tsconfig.json"), ARION_NODE_CREDENTIALS: file, ...env }
                });
                let out = "";
                child.stdout.on("data", (d) => (out += d));
                child.stderr.on("data", (d) => (out += d));
                child.on("close", (status) => resolve({ status, out }));
                child.stdin.end(input);
            });
        try {
            const unauthorised = await run([configFile], "");
            expect(unauthorised.status).toBe(1);
            expect(unauthorised.out).toContain("not authorised");
            const wrong = await run(["login", configFile], `${server.url}\noperator\nwrong\n`);
            expect(wrong.status).toBe(1);
            expect(wrong.out).toContain("Invalid credentials");
            expect(fs.existsSync(file)).toBe(false);
            const ok = await run(["login", configFile], `${server.url}\noperator\nsecret\n`);
            expect(ok.status).toBe(0);
            expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual(jasmine.objectContaining({ serverUrl: server.url, nodeId: "machine-1", key: "the-key" }));
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        } finally {
            server.close();
        }
    }, 120000);
});
