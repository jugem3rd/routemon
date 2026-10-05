import type { Socket } from "node:net";

/** node:httpのServerとnode:netのServerを、同じ形で閉じるための最小の型。 */
export type ClosableServer = {
	close(callback: () => void): unknown;
	closeIdleConnections(): void;
	closeAllConnections(): void;
};

/**
 * node:netのServerには接続をまとめて閉じる関数が無いため、接続を記録して
 * ClosableServerとして扱えるようにする。
 */
export function trackNetServer(server: {
	close(callback: () => void): unknown;
	on(event: "connection", listener: (socket: Socket) => void): unknown;
}): ClosableServer {
	const sockets = new Set<Socket>();
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return {
		close: (callback) => server.close(callback),
		closeIdleConnections: () => {},
		closeAllConnections: () => {
			for (const socket of sockets) socket.destroy();
		},
	};
}

export type ShutdownOptions = {
	servers: ClosableServer[];
	/** 新しい接続を止める直前に呼ぶ。待機中のlong-pollを返す(AgentGateway.shutdown) */
	beforeClose?: () => void;
	/** すべてのserverが閉じた後に呼ぶ。storageを閉じる */
	afterClose?: () => void;
	/** この時間を過ぎたら強制終了する */
	graceMs: number;
	log?: (message: string) => void;
	exit?: (code: number) => void;
};

/**
 * 停止シグナルを受けたときの正常終了(#151)。
 *
 * 1. 待機中のlong-pollを返し、新しい接続の受け付けを止める
 * 2. 進行中のリクエストの完了を待つ(待機の途中で閉じられる接続は閉じる)
 * 3. storageを閉じて終了する
 * 猶予を過ぎても終わらない場合は、終了コード1で強制終了する。
 */
export function createShutdown(options: ShutdownOptions): () => Promise<void> {
	const log = options.log ?? (() => {});
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let running: Promise<void> | undefined;

	return () => {
		running ??= run();
		return running;
	};

	async function run(): Promise<void> {
		const forced = setTimeout(() => {
			log("shutdown: grace period exceeded, forcing exit");
			exit(1);
		}, options.graceMs);
		forced.unref();

		options.beforeClose?.();
		// 猶予の途中で、まだ残っている接続を閉じる
		const dropConnections = setTimeout(() => {
			for (const server of options.servers) server.closeAllConnections();
		}, options.graceMs * 0.6);
		dropConnections.unref();

		await Promise.all(
			options.servers.map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
						server.closeIdleConnections();
					}),
			),
		);
		clearTimeout(dropConnections);
		options.afterClose?.();
		clearTimeout(forced);
		log("shutdown: complete");
		exit(0);
	}
}

/** SIGTERM / SIGINTで正常終了を始める。 */
export function installShutdownSignals(shutdown: () => Promise<void>): void {
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.on(signal, () => {
			console.log(`received ${signal}, shutting down`);
			void shutdown();
		});
	}
}
