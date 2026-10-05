/**
 * URLの値、または呼ぶたびに最新の値を返す関数。
 *
 * Public URLはSetup Wizardで起動後に決まるため、起動時の値を固定すると、Setup直後に作る
 * Enrollmentのcommand(CLI block)とBootstrapがlocalhostを指してしまう。
 */
export type UrlSource = string | (() => string);

export function resolveUrl(source: UrlSource): string {
	return typeof source === "function" ? source() : source;
}
