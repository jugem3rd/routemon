/**
 * Password hash(docs/community/local-auth-design.md §3)。
 *
 * Node.js組み込みのscryptを使い、外部依存を増やさない。保存形式:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */
import {
	randomBytes,
	type ScryptOptions,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";

function scrypt(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCallback(password, salt, keylen, options, (error, key) =>
			error ? reject(error) : resolve(key),
		);
	});
}

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {}

export async function hashPassword(password: string): Promise<string> {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new WeakPasswordError(
			`password must be at least ${MIN_PASSWORD_LENGTH} characters`,
		);
	}
	const salt = randomBytes(SALT_BYTES);
	const hash = await scrypt(password, salt, KEY_BYTES, PARAMS);
	return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(
	password: string,
	encoded: string,
): Promise<boolean> {
	const [scheme, n, r, p, salt, hash] = encoded.split("$");
	if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
	const expected = Buffer.from(hash, "base64");
	const actual = await scrypt(
		password,
		Buffer.from(salt, "base64"),
		expected.length,
		{
			N: Number(n),
			r: Number(r),
			p: Number(p),
		},
	);
	return timingSafeEqual(expected, actual);
}
