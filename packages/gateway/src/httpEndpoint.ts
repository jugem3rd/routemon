/**
 * Agent向けpublic HTTPS endpoint(docs/core/agent-gateway-design.md §3)。
 *
 * このlistenerはAgent APIだけを公開する。Communityでは前段のCaddyがTLSを終端するため
 * tlsを渡さずHTTPで待ち受けてもよい(docs/community/architecture.md §3)。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import type { AgentGateway } from "./gateway.ts";

export const SYNC_PREFIX = "/v1/tunnel/sync/";
export const RELEASE_PREFIX = "/v1/agent/releases/";
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export type AgentEndpointOptions = {
	gateway: AgentGateway;
	/** Agent向けの追加route(Enrollment等)。一致しなければ404を返す */
	fallback?: (req: IncomingMessage, res: ServerResponse) => void;
	/** Agent artifactの配布(docs/core/agent-update-design.md §4)。Release管理は#35 */
	releases?: {
		dir: string;
		resolveCredential: (credential: string) => Promise<string | null>;
	};
	tls?: { cert: string | Buffer; key: string | Buffer };
	maxRequestBytes?: number;
};

export function createAgentEndpoint(options: AgentEndpointOptions): Server {
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		void handleRequest(options, req, res).catch(() => {
			send(res, 500, "internal error");
		});
	};
	return options.tls
		? createHttpsServer(options.tls, handler)
		: createHttpServer(handler);
}

async function handleRequest(
	options: AgentEndpointOptions,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const path = (req.url ?? "").split("?")[0] ?? "";
	if (
		req.method === "GET" &&
		path.startsWith(RELEASE_PREFIX) &&
		options.releases
	) {
		await handleRelease(options, path.slice(RELEASE_PREFIX.length), req, res);
		return;
	}
	const wait = path.startsWith(SYNC_PREFIX)
		? path.slice(SYNC_PREFIX.length)
		: "";
	if (req.method !== "POST" || !/^\d+$/.test(wait)) {
		if (options.fallback) {
			options.fallback(req, res);
			return;
		}
		send(res, 404, "not found");
		return;
	}

	const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
	const body = await readBody(req, maxBytes);
	if (body === null) {
		send(res, 413, "request body too large");
		return;
	}

	const response = await options.gateway.handleSync({
		authorization: req.headers.authorization,
		waitSeconds: Number(wait),
		body,
		remoteAddress: req.socket.remoteAddress,
	});
	res.writeHead(response.status, {
		"content-type": "application/octet-stream",
		"content-length": response.body.length,
		connection: "close",
	});
	res.end(response.body);
}

async function handleRelease(
	options: AgentEndpointOptions,
	rest: string,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const releases = options.releases;
	if (!releases) {
		send(res, 404, "not found");
		return;
	}
	const credential = (req.headers.authorization ?? "").replace(
		/^Bearer\s+/i,
		"",
	);
	if (!credential || !(await releases.resolveCredential(credential))) {
		send(res, 401, "unauthorized");
		return;
	}
	const [version = "", kind = ""] = rest.split("/");
	if (
		!/^[0-9A-Za-z._-]+$/.test(version) ||
		(kind !== "" && kind !== "manifest")
	) {
		send(res, 404, "not found");
		return;
	}
	const file = join(releases.dir, `${version}.lua`);
	let artifact: Buffer;
	try {
		artifact = readFileSync(file);
	} catch {
		send(res, 404, "not found");
		return;
	}
	const actualVersion =
		version === "stable" ? resolveStableVersion(artifact) : version;
	if (!actualVersion) {
		send(res, 500, "invalid stable artifact");
		return;
	}
	const body =
		kind === "manifest"
			? Buffer.from(
					JSON.stringify({
						version: actualVersion,
						size: artifact.length,
						content_hash: createHash("sha256").update(artifact).digest("hex"),
					}),
				)
			: artifact;
	res.writeHead(200, {
		"content-type": "application/octet-stream",
		"content-length": body.length,
		connection: "close",
	});
	res.end(body);
}

/** stable.lua is an alias artifact; its source declares the version Agent reports. */
function resolveStableVersion(artifact: Buffer): string | null {
	const source = artifact.toString("utf8");
	return (
		source.match(/^\s*local\s+VERSION\s*=\s*'([0-9A-Za-z._-]+)'\s*$/m)?.[1] ??
		null
	);
}

async function readBody(
	req: IncomingMessage,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > maxBytes) return null;
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > maxBytes) return null;
		chunks.push(chunk as Buffer);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, message: string): void {
	const body = Buffer.from(message, "utf8");
	res.writeHead(status, {
		"content-type": "application/octet-stream",
		"content-length": body.length,
		connection: "close",
	});
	res.end(body);
}
