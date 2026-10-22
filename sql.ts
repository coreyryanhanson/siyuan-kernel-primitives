/** Single-quote SQL string literal — ids ride the ownership query; agent
 * input is escaped, never interpolated raw. */
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
