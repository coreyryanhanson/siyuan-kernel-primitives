// Statement-kind classifier tests — the `./testing` entry's routing
// surface. The contract: every head in the registry classifies as its
// key, no head is a prefix of another (so classification order is
// irrelevant and a kind is unique), and the classifier is total
// (`other` for SQL the package does not build) instead of mis-routing.
// The table is imported, never copied — a head's pairing lives once in
// stmtKind.ts.

import { describe, expect, it } from "vitest";
import { statementKind } from "siyuan-kernel-primitives/testing";
import { STMT_HEADS } from "../stmtKind.js";
import { guardExactStmt, guardNearStmt } from "../titleGuard.js";
import { ownershipStmt } from "../byId.js";

describe("statementKind", () => {
	it("classifies every head, bare and with a tail", () => {
		for (const [kind, head] of Object.entries(STMT_HEADS)) {
			expect(statementKind(head), kind).toBe(kind);
			expect(statementKind(`${head} WHERE x = 'y'`), kind).toBe(kind);
		}
	});

	it("classifies real builder output", () => {
		expect(statementKind(guardExactStmt("nb", "T"))).toBe("guard");
		expect(statementKind(guardNearStmt("nb", "T"))).toBe("guard");
		expect(statementKind(ownershipStmt("nb", "blk"))).toBe("ownership");
	});

	it("maps no head onto another head's kind — no head is a prefix of another", () => {
		for (const [, head] of Object.entries(STMT_HEADS)) {
			for (const [otherKind, otherHead] of Object.entries(STMT_HEADS)) {
				if (head === otherHead) continue;
				// A head that starts with another head would classify as
				// that head's kind when it came first — the uniqueness the
				// registry's contract rests on.
				expect(otherHead.startsWith(head), head).toBe(false);
				expect(statementKind(head), `${head} → ${otherKind}`).not.toBe(
					otherKind,
				);
			}
		}
	});

	it("is total — unknown SQL classifies `other`, never throws", () => {
		expect(statementKind("SELECT * FROM sqlite_master")).toBe("other");
		expect(statementKind("")).toBe("other");
		expect(statementKind("INSERT INTO blocks VALUES (1)")).toBe("other");
	});
});
