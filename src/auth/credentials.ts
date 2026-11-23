import fs from "fs";
import os from "os";
import path from "path";
import { NodeConfig } from "../interfaces/node.interfaces";

/** What the node keeps after it has been authorised by the server. */
export interface NodeCredentials {
    /** The server's origin, e.g. https://arion.example.com or http://127.0.0.1:3000 */
    serverUrl: string;
    /** The machine id the key is bound to. */
    nodeId: string;
    key: string;
    authorisedAt: string;
}

/** The credential file: ARION_NODE_CREDENTIALS, else ~/.arion/node-credentials.json. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
    return env.ARION_NODE_CREDENTIALS ? path.resolve(env.ARION_NODE_CREDENTIALS) : path.join(os.homedir(), ".arion", "node-credentials.json");
}

/**
 * The node's credentials: from ARION_SERVER_URL and ARION_NODE_KEY when both are set (headless setups), else from
 * the credential file; null when there are none.
 */
export function loadCredentials(file: string, env: NodeJS.ProcessEnv = process.env): NodeCredentials | null {
    if (env.ARION_SERVER_URL && env.ARION_NODE_KEY) {
        return { serverUrl: parseServerAddress(env.ARION_SERVER_URL, true).origin, nodeId: "", key: env.ARION_NODE_KEY, authorisedAt: "" };
    }
    if (!fs.existsSync(file)) return null;
    const credentials = JSON.parse(fs.readFileSync(file, "utf-8")) as NodeCredentials;
    if (!credentials?.serverUrl || !credentials?.key) throw new Error(`Credential file ${file} is incomplete; run login again`);
    return credentials;
}

/** Writes the credential file readable by the current user only (directory 0700, file 0600). */
export function saveCredentials(file: string, credentials: NodeCredentials): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600); // the mode option does not apply to an existing file
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Parses a server address typed by the operator: a URL, a host name or an IP address, with an optional port.
 * Without a scheme, https is assumed (http for localhost). Plain http to another host sends the password and the key
 * readable by anyone on the network, so it is refused unless `allowHttp` is set.
 */
export function parseServerAddress(input: string, allowHttp: boolean = false): URL {
    const text = String(input ?? "").trim();
    if (!text) throw new Error("A server address is required");
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    let url: URL;
    try {
        url = new URL(hasScheme ? text : "https://" + text);
        if (!hasScheme && LOCAL_HOSTS.includes(url.hostname)) url = new URL("http://" + text);
    } catch {
        throw new Error(`Not a valid server address: ${text}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported scheme ${url.protocol} (use http or https)`);
    if (url.protocol === "http:" && !LOCAL_HOSTS.includes(url.hostname) && !allowHttp) {
        throw new Error("Plain http to a remote server exposes the password and the key; use https, or pass --allow-http");
    }
    return url;
}

/** The node configuration pointed at the server the node was authorised by. */
export function withServer(config: NodeConfig, serverUrl: string): NodeConfig {
    const url = new URL(serverUrl);
    return {
        ...config,
        protocol: url.protocol.replace(":", "") as NodeConfig["protocol"],
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    };
}
