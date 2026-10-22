import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STMT_HEADS } from "./stmtKind.js";
import {
	blankLiterals,
	declaredNames,
	hasRunawayString,
	reExportLists,
	stripComments,
	typeDeclarations,
} from "./__tests__/surfaceScanner.js";

// The guard's inputs, hoisted above both rule suites: the exports map is
// the whole public API, so every rule here is derived from the module
// sources and the barrels' own re-export lists — never hand-listed.
const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(path.join(root, "package.json"), "utf8"),
) as { files: string[] };
const BARRELS = new Set(["index.ts", "write.ts", "testing.ts"]);
const modules = pkg.files.filter(
	(file) => file.endsWith(".ts") && !BARRELS.has(file),
);

/** Names each barrel re-exports from each root module (the specifier
 * "./walk.js" attributes to walk.ts). Specifiers outside the root
 * modules — the layer-1 identity surface — carry no attribution, and a
 * barrel local re-binding (`export { x };`) attributes to nothing: the
 * coverage check then demands the explicit `from` form. */
function barrelCoverage(): Map<string, Set<string>> {
	const coverage = new Map<string, Set<string>>();
	for (const barrel of BARRELS) {
		for (const [spec, names] of reExportLists(
			readFileSync(path.join(root, barrel), "utf8"),
		)) {
			const file = spec.replace(/^\.\//, "").replace(/\.js$/, ".ts");
			if (!modules.includes(file)) continue;
			const covered = coverage.get(file) ?? new Set<string>();
			for (const name of names) covered.add(name);
			coverage.set(file, covered);
		}
	}
	return coverage;
}

// Both entry points resolve through the package's own exports map, and
// the map gates resolution: anything not declared under "exports" is
// unreachable, so deep imports fail rather than reaching module files.
describe("package entry points", () => {
	it("exposes the read barrel at the default subpath", async () => {
		const read = await import("siyuan-kernel-primitives");
		expect(read).toBeTypeOf("object");
	});

	it("exposes the write entry at the ./write subpath", async () => {
		const write = await import("siyuan-kernel-primitives/write");
		expect(write).toBeTypeOf("object");
	});

	it("exposes the test seam at the ./testing subpath", async () => {
		const testing = await import("siyuan-kernel-primitives/testing");
		expect(testing.statementKind).toBeTypeOf("function");
	});

	it("does not resolve subpaths outside the declared exports", async () => {
		// Computed at runtime so the resolver sees it only at call time.
		const deep = ["siyuan-kernel-primitives", "walk.js"].join("/");
		await expect(import(deep)).rejects.toThrow();
	});
});

// The read barrel must never carry a write primitive — every name the
// write entry declares, value or type alike, stays behind ./write.
// Derived from write.ts's own declarations, so a TYPE re-exported onto
// the read barrel fails here too; Object.keys only ever saw runtime
// values, and a type never appears in them.
describe("boundary rules", () => {
	it("read barrel declares nothing the write entry declares", () => {
		const readNames = declaredNames(
			readFileSync(path.join(root, "index.ts"), "utf8"),
		);
		const writeNames = declaredNames(
			readFileSync(path.join(root, "write.ts"), "utf8"),
		);
		expect(writeNames.size).toBeGreaterThan(0);
		const overlap = [...readNames].filter((name) => writeNames.has(name));
		expect(overlap).toEqual([]);
	});

	// The seam's home is pinned, not merely covered: completeness is
	// satisfied by any barrel naming the module, so a seam on ./write
	// would pass it silently. The testing entry carries exactly
	// the SQL routing classifier, and no other barrel names those exports.
	it("the testing entry carries exactly the statement classifier, on no other barrel", () => {
		const testingNames = declaredNames(
			readFileSync(path.join(root, "testing.ts"), "utf8"),
		);
		expect([...testingNames].sort()).toEqual([
			"StatementKind",
			"statementKind",
		]);
		for (const barrel of ["index.ts", "write.ts"]) {
			const names = declaredNames(
				readFileSync(path.join(root, barrel), "utf8"),
			);
			for (const name of testingNames) {
				expect(names.has(name), `${barrel}: ${name}`).toBe(false);
			}
		}
	});

	// The nine write flow entries pin WHICH barrel carries them. The two
	// rules above only forbid a name on both barrels, so moving one of
	// these from write.ts to index.ts passes completeness (it still rides
	// a barrel), disjointness (it left the write barrel), and the runtime
	// half (the write entry's own keys shrank with it). Each entry is
	// pinned by name: the disjointness rules alone cannot tell a moved
	// export from a deleted one. moveVerified is the two-route move's one
	// dispatch entry — the section sequence it routes headings to stays
	// internal.
	const FLOW_ENTRIES = [
		"createDocVerified",
		"editVerified",
		"insertVerified",
		"replaceSectionVerified",
		"moveVerified",
		"moveDocVerified",
		"deleteBlockVerified",
		"deleteSectionVerified",
		"deleteDocVerified",
	];

	it("every write flow entry rides ./write and is unreachable from the read barrel", () => {
		const readNames = declaredNames(
			readFileSync(path.join(root, "index.ts"), "utf8"),
		);
		const writeNames = declaredNames(
			readFileSync(path.join(root, "write.ts"), "utf8"),
		);
		const misplaced = FLOW_ENTRIES.filter(
			(name) => !writeNames.has(name) || readNames.has(name),
		);
		expect(misplaced).toEqual([]);
	});
});

// Barrel completeness — the public surface is the exports map and deep
// imports fail, so a module-level export that no barrel re-exports is
// unreachable by consumers: a public function whose result type cannot be
// named by the consumer that must switch over it. Derived from the module
// sources, values and types alike, so a new export that is silently not
// shipped fails here without editing this test. Anything genuinely
// internal joins the allow-list below — a deliberate public-API decision,
// never a default.
describe("barrel completeness", () => {
	// Deliberately internal module-level exports — reachable by this
	// repo's suites through relative imports, never by consumers.
	const INTERNAL_EXPORTS = new Set([
		// Per-flow structural client subsets — WriteKernelClient composes
		// them; tests stub them against the module files.
		"CreateKernelClient",
		"DeleteBlockClient",
		"EditKernelClient",
		"InsertKernelClient",
		"MoveBlockKernelClient",
		"MoveDocKernelClient",
		"MoveVerifiedKernelClient",
		"MoveSectionKernelClient",
		"DeleteKernelClient",
		"ReplaceKernelClient",
		"DeleteSectionKernelClient",
		// The batched-route foundation (batch.ts), internal for this repo's
		// suites; `TransactClient` rides WriteKernelClient's composition.
		"TransactClient",
		"TransactKernelClient",
		"TransactThenWalkOutcome",
		"transactThenWalk",
		// Pure judgment seams — mutation and landing judgment ride the flow
		// entry points, not these helpers.
		"newBlockIdFrom",
		"insertLanded",
		"judgeEditLanded",
		"verifyMoveLanded",
		// The per-id route's core: drift, provenance, and anchor derivation
		// live on `moveVerified`; the core judges the handed-in walks.
		"moveBlockCore",
		"deleteLanded",
		// Placement's pure evidence helpers — flow seams, not consumer
		// surface (the public placement face is the anchors and sectionOf).
		"inSubtree",
		"landingId",
		"sectionSubjectOf",
		"foreignRefusalOf",
		"cascadeDescendantsOf",
		// The container vocabulary's read-side set — walk.ts and the kernel
		// pin test derive from it; consumers need only the targetable face.
		"KERNEL_CONTAINER_TYPES",
		// The move-section landed judgment's owner projection — the landing
		// container-local owner, read off the walk the judgment holds. Its
		// `SectionOwner` payload rides ./write as a field of the public
		// `MoveSectionOutcome.landed.owner`.
		"sectionOwnerOf",
		// The section-move sequence and its pure seams — internal beside
		// moveVerified, the one public entry (a second entrance would bypass
		// the row-type dispatch).
		"moveSectionVerified",
		"planMoveSection",
		"MoveSectionPlan",
		"MoveSectionPlanResult",
		"judgeMoveSectionLanded",
		"MoveSectionLandedVerdict",
		// The shared pre-judgment seam — failure.ts is a leaf; only
		// MutationFailure rides ./write, the consumer names none of these.
		"refuseDrift",
		"catchMutation",
		"catchVerification",
		"DriftFailure",
		"MutationPhaseFailure",
		// The section-delete core behind both batched-route section flows
		// (deleteSection.ts, replace.ts) — internal for this repo's suites;
		// the barrel never carries the core's outcome unions, the tool
		// layer words the wrapper's own arms.
		"sectionDeletePlan",
		"sectionDeleteApply",
		"SectionDeletePlan",
		"SectionDeletePlanOutcome",
		"SectionDeletePlanRefusal",
		"SectionDeleteApplyJudgedPhase",
		"SectionDeleteApplyUnverifiedPhase",
		"SectionDeleteApplyOutcome",
		"DeleteOp",
		// The core's judged-block row shape — no consumer names it.
		"JudgedSectionBlock",
		// The replace sequence's phase sub-unions and survival seam —
		// internal joins composed into the barreled unions, on the
		// insertLanded precedent (structural typing means no consumer
		// names them).
		"ReplaceInsertUnverified",
		"ReplaceDeleteLegUnverified",
		"ReplaceDeleteLegJudged",
		// The replace sequence's survival seam — the pure judgment over the
		// delete leg's post-write walk, exported for suites on the
		// insertLanded precedent; the reading type rides it (structural
		// typing means no consumer needs to name the field's shape, only
		// the arm's values).
		"replacementSurvivalOf",
		"ReplacementSurvivalReading",
		// The scoping-refusal projection the block-delete flow composes
		// pre-mutation (the edit's is lazily-taken inside editVerified).
		"scopingRefusalOf",
		// The fresh-content judgment family — internal to the write
		// primitives (no completeness shape to name); the public write
		// surface carries only ServedBaseline / FreshOutcome / StaleFreshArm
		// / FreshRefusal (re-exported at ./write). contentHash stays public
		// (the pure hash the tool layer's baselines ride).
		"judgeFreshOverWalk",
		"checkFreshContent",
		"freshRefusalOf",
		"FreshInput",
		"FreshTarget",
		// Internal helpers the barrels deliberately do not surface.
		"guardNearPatterns",
		"MAX_WALK_DEPTH",
		// Walk-set helpers the verification judgments derive from — pure
		// walk projections; `siblingRunOf` is the same class (the move's
		// anchors and landed predicate).
		"idSet",
		"byIdMap",
		"siblingRunOf",
		// Internal so the vocabulary's test stays one-homed while
		// `TARGETABLE_CONTAINER_TYPES` remains the barrel's only
		// targetability name.
		"isTargetableContainer",
		// Data, so the outline suite can pin the targetable-set coupling;
		// the renderer is the notation's public face.
		"CONTAINER_GLYPHS",
		// The shared poll loop over the convergence window (create.ts and
		// move.ts); the window rides no barrel — in-repo suites import
		// convergence.js directly, seam and frozen table alike.
		"verifyWithinWindow",
		"withVerifyWindow",
		"VERIFY_RETRY_DELAYS_MS",
		// The SQL statement heads — one private table (head, kind, pairing
		// registered once); the public face is the derived classifier
		// (`statementKind`) on the ./testing entry, never the text.
		"STMT_HEADS",
	]);

	function barrelExportNames(): Set<string> {
		const names = new Set<string>();
		for (const barrel of BARRELS) {
			for (const name of declaredNames(
				readFileSync(path.join(root, barrel), "utf8"),
			)) {
				names.add(name);
			}
		}
		return names;
	}

	function moduleExportNames(): Set<string> {
		const names = new Set<string>();
		for (const file of modules) {
			for (const name of declaredNames(
				readFileSync(path.join(root, file), "utf8"),
			)) {
				names.add(name);
			}
		}
		return names;
	}

	it("every module export is re-exported by a barrel naming its module, or explicitly internal", () => {
		const coverage = barrelCoverage();
		const unreachable: string[] = [];
		for (const file of modules) {
			for (const name of declaredNames(
				readFileSync(path.join(root, file), "utf8"),
			)) {
				if (INTERNAL_EXPORTS.has(name)) continue;
				// Keyed per (module, name): a barreled same-name export
				// of another module cannot satisfy this module's
				// coverage, so a duplicate name cannot mask an
				// unreachable one.
				if (!coverage.get(file)?.has(name)) {
					unreachable.push(`${file}: ${name}`);
				}
			}
		}
		expect(unreachable).toEqual([]);
	});

	// Two-sided allow-list: an internal name that later rides a barrel
	// must drop off the allow-list (else the "internal" claim is stale),
	// and a stale allow-list entry (a symbol that no longer exists) must
	// fail too — the barrel-coverage invariant is enforced here,
	// not by discipline.
	it("the internal allow-list is disjoint from the barrels and free of stale entries", () => {
		const barrelNames = barrelExportNames();
		const moduleNames = moduleExportNames();
		const overlap = [...barrelNames].filter((name) =>
			INTERNAL_EXPORTS.has(name),
		);
		expect(overlap).toEqual([]);
		const stale = [...INTERNAL_EXPORTS].filter(
			(name) => !moduleNames.has(name),
		);
		expect(stale).toEqual([]);
	});

	// The barrels are hand-maintained, so every export shape declaredNames
	// cannot account for is banned outright rather than parsed: namespace
	// re-exports, default exports, destructured declarations, generator
	// functions, ambient declarations, and namespaces (their inner members
	// would be misattributed as module-level exports). The scan runs over
	// stripped source, so a commented-out offender cannot trip it either.
	it("root modules and barrels declare no export shape declaredNames cannot account for", () => {
		const offenders: string[] = [];
		const rules = [
			[/export\s+\*/, "export *"],
			[/export\s+default\b/, "export default"],
			[/export\s+(?:const|let|var)\s*[{[]/, "destructured export"],
			[/export\s+(?:async\s+)?function\s*\*/, "generator export"],
			[/export\s+declare\b/, "ambient export"],
			[/export\s+namespace\b/, "namespace export"],
		] as const;
		for (const file of [...modules, ...BARRELS]) {
			const source = stripComments(readFileSync(path.join(root, file), "utf8"));
			for (const [pattern, label] of rules) {
				if (pattern.test(source)) offenders.push(`${file}: ${label}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// The nameability half of completeness, one level deeper: a type
	// riding a barrel must be nameable, and so must everything its body
	// references — a private type reachable from a public type's body
	// (directly or through further private types) leaves the consumer
	// holding a value it cannot name. Transitive, so a chain of private
	// helpers cannot launder a public arm's payload type past the rule.
	it("no private type is reachable from a public type's body", () => {
		const violations: string[] = [];
		const coverage = barrelCoverage();
		for (const file of modules) {
			const decls = typeDeclarations(
				blankLiterals(
					stripComments(readFileSync(path.join(root, file), "utf8")),
				),
			);
			const privateByName = new Map(
				decls.filter((d) => !d.exported).map((d) => [d.name, d]),
			);
			const byName = new Map(decls.map((d) => [d.name, d]));
			// Adjacency: each declaration's body → the module's declared
			// type names it references (word-boundary match, `$` escaped;
			// a self-reference is recursion, not a hop). Imported and
			// built-in names cannot appear here — they are not private
			// declarations of this module, and a truly undefined name is
			// already a typecheck failure. Traversal goes through EVERY
			// declared type, so a private type hidden behind an internal
			// (exported but unbarreled) one is still reached.
			const refsOf = (body: string, self: string): string[] =>
				[...byName.keys()].filter(
					(name) =>
						name !== self &&
						new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body),
				);
			// Seeded from the BARRELED types only: a consumer traverses
			// nameability from the surface inward, so a chain through an
			// internal type exposes nothing UNLESS the internal type is
			// itself nested inside a consumer-visible type — which the
			// traversal from a barreled seed reaches anyway. Seeding from
			// every export would flag private types no consumer-visible
			// type can reach; an unbarreled public type stays the
			// completeness rule's finding, not this one's.
			const reached = new Set<string>();
			const queue: string[] = decls
				.filter((d) => coverage.get(file)?.has(d.name))
				.flatMap((d) => refsOf(d.body, d.name));
			while (queue.length > 0) {
				const name = queue.pop() as string;
				if (reached.has(name)) continue;
				reached.add(name);
				const decl = byName.get(name);
				if (decl) queue.push(...refsOf(decl.body, name));
			}
			// Only private names are unnameable under every circumstance;
			// an internal export reached this way is its own allow-list
			// decision, already pinned by the completeness rule.
			for (const name of reached) {
				if (privateByName.has(name)) violations.push(`${file}: ${name}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

// The scanner is hand-rolled because TS 7 ships no stable JS-callable
// compiler API (`ts.createSourceFile` is undefined on typescript@7), and
// a type-level `keyof typeof` assertion cannot see type-only exports —
// the exact dropped-type failure mode this guard exists for. Its known
// fail-open hazards are therefore pinned by synthetic self-tests: a
// scanner regression must go red here, not silently pass on the real
// modules, whose current sources happen to contain neither hazard.
describe("completeness scanner", () => {
	it("accounts for every declarator when a literal contains a semicolon", () => {
		const names = declaredNames('export const a = { t: "x;y" }, b = 2;\n');
		expect(names.has("a")).toBe(true);
		expect(names.has("b")).toBe(true);
	});

	it("flags the quote-in-regex desync stripComments cannot parse, and stays quiet on clean source", () => {
		const hazard = `export const re = /["']/;\n// export { ghost } from "./mod.js"\nexport const real = 1;\n`;
		expect(hasRunawayString(stripComments(hazard))).toBe(true);
		// Single/double quotes never span a raw newline in valid TS;
		// template literals may.
		const clean = 'export const a = "x";\nexport const t = `multi\nline`;\n';
		expect(hasRunawayString(stripComments(clean))).toBe(false);
	});

	// The real-module half: the desync signature must stay absent from
	// every source the guard scans. If this fires, the file gained a
	// quote-bearing regex literal — reword it or teach stripComments a
	// real tokenizer; never delete this canary.
	it("no scanned source holds a quoted literal open across a newline", () => {
		const desynced: string[] = [];
		for (const file of [...modules, ...BARRELS]) {
			const source = stripComments(readFileSync(path.join(root, file), "utf8"));
			if (hasRunawayString(source)) desynced.push(file);
		}
		expect(desynced).toEqual([]);
	});
});

// The statement heads' single home, enforced not merely described: the
// head table (STMT_HEADS) guarantees registered heads cannot drift, but
// nothing else forbids a future flow from inlining a raw SELECT — such a
// statement classifies as `other` and a consumer's SQL-routed stub
// silently mis-routes it instead of failing. Both rules here are
// source-derived over comment-stripped text, so they cannot go stale.
describe("statement head single home", () => {
	// The head-table module itself is the one exemption — it OWNS the
	// vocabulary; every other root module must index the table.
	const SQL_VERB = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;

	it("no root module other than stmtKind.ts contains a SQL verb literal", () => {
		const offenders: string[] = [];
		for (const file of modules) {
			if (file === "stmtKind.ts") continue;
			const source = stripComments(readFileSync(path.join(root, file), "utf8"));
			if (SQL_VERB.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	// A dead head (registered, referenced by nobody) is a lie in the
	// single-home table: a harness could route on a statement the package
	// never builds. Every head must be reachable from at least one
	// builder's assembled statement.
	it("every STMT_HEADS entry is referenced by at least one root module", () => {
		const sources = modules
			.filter((file) => file !== "stmtKind.ts")
			.map((file) =>
				stripComments(readFileSync(path.join(root, file), "utf8")),
			);
		const dead = Object.keys(STMT_HEADS).filter(
			(head) =>
				!sources.some((source) =>
					new RegExp(`STMT_HEADS(?:\\.${head}|\\["${head}"\\])`).test(source),
				),
		);
		expect(dead).toEqual([]);
	});
});

// The identity surface's value half. Every value layer 1 exports at runtime
// must ride the read barrel AS THE SAME VALUE — the whole point of routing
// consumers through this barrel is that the `instanceof` branches in
// failure.ts see exactly one copy, and that a consumer cannot need a
// layer-1 symbol this barrel does not carry (its boundary test forbids
// importing layer 1 directly, so an un-re-exported export would be
// silently unreachable downstream). barrelCoverage() deliberately
// attributes nothing to layer-1 specifiers, so the completeness accounting
// cannot catch a new layer-1 value arriving un-re-exported; this test does.
// Layer 1's type-only exports are erased at runtime and unreachable here —
// the barrels' type re-exports are covered by the public-type nameability
// guard above.
describe("identity surface", () => {
	function isErrorClass(value: unknown): boolean {
		if (typeof value !== "function") return false;
		const proto = (value as { prototype?: unknown }).prototype;
		if (!(proto instanceof Object)) return false;
		return Error.prototype.isPrototypeOf(proto);
	}

	// Every layer-1 value rides the read barrel, no exceptions — the
	// `instanceof` guarantee leaves no legitimate skip. If one ever must
	// be omitted, that is an AGENTS.md-level decision, not a list here.
	it("the read barrel re-exports every value layer 1 exports, as the same value", async () => {
		const layer1 = (await import("siyuan-kernel-api")) as Record<
			string,
			unknown
		>;
		const read = (await import("siyuan-kernel-primitives")) as Record<
			string,
			unknown
		>;
		const errorClasses = Object.keys(layer1).filter((name) =>
			isErrorClass(layer1[name]),
		);
		expect(errorClasses.length).toBeGreaterThan(0);
		const missing = Object.keys(layer1).filter(
			(name) => read[name] !== layer1[name],
		);
		expect(missing).toEqual([]);
	});
});
