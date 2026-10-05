import { expect, test } from "vitest";
import { decodeAgentStatus, encodeAgentStatus } from "./agentStatus.ts";

test("version / slot / rollbackを、往復できる", () => {
	const status = {
		version: "0.3.0",
		slot: "b",
		rollback: "0.4.0 health_timeout",
	};
	expect(decodeAgentStatus(encodeAgentStatus(status))).toEqual({
		...status,
		supervisorVersion: undefined,
		supervisorRollback: undefined,
	});
});

test("Supervisorのversionと、更新を戻した理由を、往復できる(#159)", () => {
	const status = {
		version: "0.3.0",
		slot: "a",
		supervisorVersion: "1.1.0",
		supervisorRollback: "1.2.0 crashed: boom",
	};
	expect(decodeAgentStatus(encodeAgentStatus(status))).toEqual({
		...status,
		rollback: undefined,
	});
});

test("Supervisorの項目を含まない(古いAgentの)statusも読める", () => {
	const decoded = decodeAgentStatus(
		new TextEncoder().encode("0.2.0\na\nrollback:0.3.0 x"),
	);
	expect(decoded.version).toBe("0.2.0");
	expect(decoded.rollback).toBe("0.3.0 x");
	expect(decoded.supervisorVersion).toBeUndefined();
	expect(decoded.supervisorRollback).toBeUndefined();
});
