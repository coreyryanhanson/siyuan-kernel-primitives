import { describe, expect, it } from "vitest";
import { sqlString } from "../sql.js";

describe("sqlString", () => {
	it("wraps a plain value in single quotes", () => {
		expect(sqlString("20240101120000-abc")).toBe(`'20240101120000-abc'`);
	});

	it("doubles embedded apostrophes — agent input is escaped, never raw", () => {
		expect(sqlString(`it's`)).toBe(`'it''s'`);
		expect(sqlString(`' DROP TABLE blocks`)).toBe(`''' DROP TABLE blocks'`);
	});

	it("passes an empty string through as ''", () => {
		expect(sqlString("")).toBe(`''`);
	});
});
