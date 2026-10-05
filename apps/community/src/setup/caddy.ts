/**
 * Caddy設定の生成(#12、docs/community/installation-setup-design.md §6)。
 *
 * 利用者にCaddyfileを編集させない。Setupで設定したPublic URLから生成し、
 * 共有volume上のfileへ書く(Caddyは`--watch`で読み直す)。
 *
 * Routemon containerへDocker socketをmountしない。Caddyの管理APIも
 * Docker internal networkに限定し、Publicへ出さない。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CaddyTargets = {
	/** GUI / API(Routemon本体) */
	app: string;
	/** Agent Gateway。Agent以外のAPIをこのlistenerへ出さない */
	agent: string;
	/** Native WebGUI relay(専用origin) */
	webgui: string;
	/** Native WebGUI用のport(Public URLのhostnameで別portを使う) */
	webguiPort: number;
};

const AGENT_PATHS = ["/v1/tunnel/*", "/v1/enrollment/*", "/v1/agent/*"];

export function renderCaddyfile(
	publicBaseUrl: string,
	targets: CaddyTargets,
): string {
	const url = new URL(publicBaseUrl);
	// httpのままなら証明書を取りに行かせない(bootstrap中のLAN利用)
	const site = url.protocol === "https:" ? url.hostname : `http://${url.host}`;
	return `# 自動生成(Routemon Setup)。手で編集しても次のPublic URL変更で上書きされる。
{
	admin :2019
}

${site} {
	# Routerが使うAgent APIだけをAgent Gatewayへ渡す
	@agent path ${AGENT_PATHS.join(" ")}
	handle @agent {
		reverse_proxy ${targets.agent}
	}
	handle {
		reverse_proxy ${targets.app}
	}
}

# YAMAHA Native WebGUIは専用origin(docs/core/webgui-relay-design.md §8)
${url.protocol === "https:" ? `${url.hostname}:${targets.webguiPort}` : `http://${url.hostname}:${targets.webguiPort}`} {
	reverse_proxy ${targets.webgui}
}
`;
}

/**
 * Caddyfileを書き出す。内容が変わらない場合は書かない(不要なreloadを避ける)。
 * 反映はCaddyの`--watch`に任せる。
 */
export function writeCaddyfile(
	path: string,
	publicBaseUrl: string,
	targets: CaddyTargets,
): boolean {
	const next = renderCaddyfile(publicBaseUrl, targets);
	try {
		if (readFileSync(path, "utf8") === next) return false;
	} catch {
		// 無ければ作る
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next, "utf8");
	return true;
}
