export type RouteTableFamily = "ipv4" | "ipv6";

export type ObservedRouteCategory =
	| "static"
	| "dynamic"
	| "implicit"
	| "temporary"
	| "unknown";

export type ObservedRoute = {
	family: RouteTableFamily;
	destination: string;
	gateway: string | null;
	interface: string | null;
	rawType: string;
	category: ObservedRouteCategory;
	protocol?: string;
	metric?: number;
	cost?: number;
	rawDetails?: string;
};

export type RouteTableParseStatus =
	| "complete"
	| "partial"
	| "unrecognized_output";

export type RouteTableParseResult = {
	family: RouteTableFamily;
	status: RouteTableParseStatus;
	routes: ObservedRoute[];
	/** 見出し認識後にroute rowとして解釈できなかった行。 */
	unparsedLines: string[];
};

/**
 * `show ip route` / `show ipv6 route`のテキスト出力を正規化する。
 * 既知headerの列幅ではなく空白区切りのtokenで読むため、機種差のある桁位置に依存しない。
 */
export function parseRouteTable(
	output: string,
	family: RouteTableFamily,
): RouteTableParseResult {
	const lines = output.split(/\r\n|\r|\n/);
	const headerIndex = lines.findIndex(isKnownHeader);
	if (headerIndex < 0) {
		return {
			family,
			status: "unrecognized_output",
			routes: [],
			unparsedLines: [],
		};
	}

	const routes: ObservedRoute[] = [];
	const unparsedLines: string[] = [];
	for (const line of lines.slice(headerIndex + 1)) {
		if (!line.trim()) continue;
		const route = parseRouteLine(line, family);
		if (route) routes.push(route);
		else unparsedLines.push(line);
	}

	return {
		family,
		status: unparsedLines.length > 0 ? "partial" : "complete",
		routes,
		unparsedLines,
	};
}

function isKnownHeader(line: string): boolean {
	const lower = line.toLowerCase();
	const hasDestination = /\bdestination\b/.test(lower) || /宛先/.test(line);
	const hasGateway = /\bgateway\b/.test(lower) || /ゲートウェイ/.test(line);
	const hasInterface =
		/\binterface\b/.test(lower) || /インタ(?:フェース|ーフェース)/.test(line);
	const hasType = /\btype\b/.test(lower) || /種別|タイプ/.test(line);
	return hasDestination && hasGateway && hasInterface && hasType;
}

function parseRouteLine(
	line: string,
	family: RouteTableFamily,
): ObservedRoute | undefined {
	const tokens = line.trim().split(/\s+/);
	if (tokens.length < 4) return undefined;

	const destination = normalizeDestination(tokens[0] ?? "", family);
	const rawGateway = tokens[1] ?? "";
	const interfaceName = tokens[2] ?? "";
	const rawType = tokens[3] ?? "";
	if (
		destination === undefined ||
		!isGateway(rawGateway, family) ||
		!interfaceName ||
		!rawType
	) {
		return undefined;
	}

	const rawDetails = tokens.slice(4).join(" ") || undefined;
	const protocol = knownProtocol(rawType);
	const category = categoryFor(rawType, protocol);
	const route: ObservedRoute = {
		family,
		destination,
		gateway: rawGateway === "-" ? null : rawGateway,
		interface: interfaceName === "-" ? null : interfaceName,
		rawType,
		category,
	};
	if (protocol) route.protocol = protocol;
	if (rawDetails !== undefined) {
		route.rawDetails = rawDetails;
		const metric = numericDetail(rawDetails, "metric");
		const cost = numericDetail(rawDetails, "cost");
		if (metric !== undefined) route.metric = metric;
		if (cost !== undefined) route.cost = cost;
	}
	return route;
}

function normalizeDestination(
	value: string,
	family: RouteTableFamily,
): string | undefined {
	if (value === "default") return "default";
	if (family === "ipv4" && value === "0.0.0.0/0") return "default";
	if (family === "ipv6" && value === "::/0") return "default";

	const separator = value.lastIndexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	const address = value.slice(0, separator);
	const prefix = value.slice(separator + 1);
	if (!/^\d+$/.test(prefix)) return undefined;
	const prefixLength = Number(prefix);
	if (family === "ipv4") {
		return isIpv4Address(address) && prefixLength <= 32 ? value : undefined;
	}
	return isIpv6Address(address) && prefixLength <= 128 ? value : undefined;
}

function isGateway(value: string, family: RouteTableFamily): boolean {
	if (value === "-") return true;
	return family === "ipv4" ? isIpv4Address(value) : isIpv6Address(value);
}

function isIpv4Address(value: string): boolean {
	const octets = value.split(".");
	return (
		octets.length === 4 &&
		octets.every((octet) => {
			if (!/^\d{1,3}$/.test(octet)) return false;
			const number = Number(octet);
			return number >= 0 && number <= 255;
		})
	);
}

function isIpv6Address(value: string): boolean {
	if (!value || value.includes("%")) return false;
	const compressionIndex = value.indexOf("::");
	const hasCompression = compressionIndex >= 0;
	if (hasCompression && value.indexOf("::", compressionIndex + 2) >= 0) {
		return false;
	}

	const leftText = hasCompression ? value.slice(0, compressionIndex) : value;
	const rightText = hasCompression ? value.slice(compressionIndex + 2) : "";
	const left = leftText ? leftText.split(":") : [];
	const right = rightText ? rightText.split(":") : [];
	const groups = [...left, ...right];
	if (groups.some((group) => !group)) return false;

	const lastGroup = groups.at(-1);
	if (lastGroup?.includes(".")) {
		if (!isIpv4Address(lastGroup)) return false;
		groups.splice(-1, 1, "0", "0");
	}
	if (groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return false;
	return hasCompression ? groups.length < 8 : groups.length === 8;
}

function knownProtocol(rawType: string): string | undefined {
	const normalized = rawType.toUpperCase();
	return normalized === "RIP" || normalized === "OSPF" || normalized === "BGP"
		? normalized
		: undefined;
}

function categoryFor(
	rawType: string,
	protocol: string | undefined,
): ObservedRouteCategory {
	if (protocol) return "dynamic";
	switch (rawType.toLowerCase()) {
		case "static":
			return "static";
		case "implicit":
			return "implicit";
		case "temporary":
			return "temporary";
		default:
			return "unknown";
	}
}

function numericDetail(
	value: string,
	name: "metric" | "cost",
): number | undefined {
	const match = new RegExp(
		`(?:^|\\s)${name}\\s*=\\s*(\\d+)(?=\\s|$)`,
		"i",
	).exec(value);
	if (!match?.[1]) return undefined;
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : undefined;
}
