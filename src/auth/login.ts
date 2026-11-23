import os from "os";
import { NodeCredentials, parseServerAddress } from "./credentials";

export type Prompt = (question: string, hidden?: boolean) => Promise<string>;

/**
 * Authorises this node with the server: asks for the server address, then an operator's username and password, and
 * returns the key the server issues (POST <server>/<basePath>/auth/node). The key is bound to the machine id.
 */
export async function login(options: {
    machineId: string;
    basePath?: string;
    allowHttp?: boolean;
    prompt: Prompt;
    fetch?: typeof fetch;
    log?: (message: string) => void;
}): Promise<NodeCredentials> {
    const log = options.log ?? ((message: string) => console.log(message));
    const doFetch = options.fetch ?? fetch;
    const url = parseServerAddress(await options.prompt("Server address (URL or IP, e.g. https://arion.example.com): "), options.allowHttp);
    const username = await options.prompt("Username: ");
    const password = await options.prompt("Password: ", true);
    if (!username || !password) throw new Error("A username and a password are required");
    const basePath = (options.basePath ?? "arion").replace(/^\/+|\/+$/g, "");
    const endpoint = `${url.origin}${basePath ? "/" + basePath : ""}/auth/node`;
    let response: Response;
    try {
        response = await doFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nodeId: options.machineId, hostname: os.hostname(), username, password })
        });
    } catch (error) {
        throw new Error(`Cannot reach ${endpoint}: ${(error as Error)?.message ?? error}`);
    }
    if (response.status === 401) throw new Error("Invalid credentials");
    if (response.status === 429) throw new Error("Too many attempts; wait a minute and try again");
    if (response.status === 404) throw new Error(`${endpoint} not found: check the server address (does the server support node authentication?)`);
    if (!response.ok) throw new Error(`Authorisation failed with HTTP ${response.status}: ${await response.text()}`);
    const body: any = await response.json();
    const payload = body?.payload ?? body;
    if (!payload?.key) throw new Error("The server returned no key");
    log(`Node ${options.machineId} authorised by ${url.origin}`);
    return { serverUrl: url.origin, nodeId: payload.nodeId ?? options.machineId, key: payload.key, authorisedAt: payload.authorisedAt ?? new Date().toISOString() };
}
