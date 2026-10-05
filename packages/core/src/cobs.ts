/**
 * Gateway -> Agent方向のCOBS(docs/core/agent-protocol.md §6.2)。
 *
 * rt.httprequest()のresponse bodyは0x00で切り捨てられるため、body全体を
 * 0x00を含まない列にする。末尾に区切りの0x00は付けない。
 */

export function cobsEncode(data: Uint8Array): Uint8Array {
	const out: number[] = [0];
	let codeIndex = 0;
	let code = 1;
	for (const byte of data) {
		if (byte === 0) {
			out[codeIndex] = code;
			code = 1;
			codeIndex = out.length;
			out.push(0);
		} else {
			out.push(byte);
			code++;
			if (code === 0xff) {
				out[codeIndex] = code;
				code = 1;
				codeIndex = out.length;
				out.push(0);
			}
		}
	}
	out[codeIndex] = code;
	return Uint8Array.from(out);
}

export function cobsDecode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let i = 0;
	while (i < data.length) {
		const code = data[i] as number;
		i++;
		for (let n = 1; n < code && i < data.length; n++) {
			out.push(data[i] as number);
			i++;
		}
		if (code < 0xff && i < data.length) {
			out.push(0);
		}
	}
	return Uint8Array.from(out);
}
