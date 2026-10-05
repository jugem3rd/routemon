import { createHash } from "node:crypto";
import type {
	ObservedRoute,
	RouteTableFamily,
	RouteTableParseResult,
} from "@routemon/core";
import type { Db } from "../storage/db.ts";

export type RouteTableAttemptStatus = "complete" | "partial" | "failed";
export type RouteTableErrorCode =
	| "timeout"
	| "command_failed"
	| "output_too_large"
	| "unrecognized_output"
	| "collection_failed";

export type RouteTableFamilySnapshot = {
	capturedAt: string | null;
	changedAt: string | null;
	lastAttemptAt: string;
	lastAttemptStatus: RouteTableAttemptStatus;
	lastErrorCode: RouteTableErrorCode | null;
	routes: ObservedRoute[];
	unparsedLines: string[];
};

export type DeviceRouteTables = {
	ipv4: RouteTableFamilySnapshot | null;
	ipv6: RouteTableFamilySnapshot | null;
};

type RouteTableRow = {
	family: RouteTableFamily;
	captured_at: string | null;
	changed_at: string | null;
	content_hash: string | null;
	last_attempt_at: string;
	last_attempt_status: RouteTableAttemptStatus;
	last_error_code: RouteTableErrorCode | null;
	routes_json: string | null;
	unparsed_lines_json: string | null;
};

type ExistingSnapshot = {
	content_hash: string | null;
	changed_at: string | null;
};

export class RouteTableRepository {
	private readonly db: Db;

	constructor(db: Db) {
		this.db = db;
	}

	get(deviceId: string): DeviceRouteTables {
		const rows = this.db
			.prepare("SELECT * FROM device_route_tables WHERE device_id = ?")
			.all(deviceId) as RouteTableRow[];
		const byFamily = new Map(rows.map((row) => [row.family, toSnapshot(row)]));
		return {
			ipv4: byFamily.get("ipv4") ?? null,
			ipv6: byFamily.get("ipv6") ?? null,
		};
	}

	recordSnapshot(input: {
		deviceId: string;
		family: RouteTableFamily;
		result: RouteTableParseResult;
		capturedAt: string;
		outputBytes: number;
		parserVersion: string;
	}): void {
		const status = input.result.status;
		if (status === "unrecognized_output") {
			throw new RangeError("unrecognized route table output cannot be saved");
		}
		const routesJson = JSON.stringify(input.result.routes);
		const unparsedLinesJson = JSON.stringify(input.result.unparsedLines);
		const contentHash = hashNormalizedContent(
			input.result.routes,
			input.result.unparsedLines,
		);

		this.db.transaction(() => {
			const existing = this.db
				.prepare(
					"SELECT content_hash, changed_at FROM device_route_tables WHERE device_id = ? AND family = ?",
				)
				.get(input.deviceId, input.family) as ExistingSnapshot | undefined;
			const changedAt =
				existing?.content_hash === contentHash
					? (existing.changed_at ?? input.capturedAt)
					: input.capturedAt;
			this.db
				.prepare(
					`INSERT INTO device_route_tables (
						device_id, family, captured_at, changed_at, content_hash,
						last_attempt_at, last_attempt_status, last_error_code,
						output_bytes, parser_version, routes_json, unparsed_lines_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
					ON CONFLICT(device_id, family) DO UPDATE SET
						captured_at = excluded.captured_at,
						changed_at = excluded.changed_at,
						content_hash = excluded.content_hash,
						last_attempt_at = excluded.last_attempt_at,
						last_attempt_status = excluded.last_attempt_status,
						last_error_code = NULL,
						output_bytes = excluded.output_bytes,
						parser_version = excluded.parser_version,
						routes_json = excluded.routes_json,
						unparsed_lines_json = excluded.unparsed_lines_json`,
				)
				.run(
					input.deviceId,
					input.family,
					input.capturedAt,
					changedAt,
					contentHash,
					input.capturedAt,
					status,
					input.outputBytes,
					input.parserVersion,
					routesJson,
					unparsedLinesJson,
				);
		})();
	}

	recordFailure(input: {
		deviceId: string;
		family: RouteTableFamily;
		attemptedAt: string;
		errorCode: RouteTableErrorCode;
	}): void {
		this.db
			.prepare(
				`INSERT INTO device_route_tables (
					device_id, family, last_attempt_at, last_attempt_status, last_error_code
				) VALUES (?, ?, ?, 'failed', ?)
				ON CONFLICT(device_id, family) DO UPDATE SET
					last_attempt_at = excluded.last_attempt_at,
					last_attempt_status = 'failed',
					last_error_code = excluded.last_error_code`,
			)
			.run(input.deviceId, input.family, input.attemptedAt, input.errorCode);
	}
}

function toSnapshot(row: RouteTableRow): RouteTableFamilySnapshot {
	return {
		capturedAt: row.captured_at,
		changedAt: row.changed_at,
		lastAttemptAt: row.last_attempt_at,
		lastAttemptStatus: row.last_attempt_status,
		lastErrorCode: row.last_error_code,
		routes: row.routes_json
			? (JSON.parse(row.routes_json) as ObservedRoute[])
			: [],
		unparsedLines: row.unparsed_lines_json
			? (JSON.parse(row.unparsed_lines_json) as string[])
			: [],
	};
}

/** Routeの表示順の揺れで内容変更と判定しないよう、正規化してhashにする。 */
function hashNormalizedContent(
	routes: readonly ObservedRoute[],
	unparsedLines: readonly string[],
): string {
	const stableRoutes = [...routes].sort(compareJson);
	const stableUnparsed = [...unparsedLines].sort();
	return createHash("sha256")
		.update(
			JSON.stringify({ routes: stableRoutes, unparsedLines: stableUnparsed }),
		)
		.digest("hex");
}

function compareJson(left: ObservedRoute, right: ObservedRoute): number {
	const leftJson = JSON.stringify(left);
	const rightJson = JSON.stringify(right);
	return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}
