// The hand-rolled surface scanner the completeness guard runs on: TS 7
// ships no stable JS-callable compiler API (`ts.createSourceFile` is
// undefined on typescript@7), and a type-level `keyof typeof` assertion
// cannot see type-only exports — the exact dropped-type failure mode the
// guard exists for. Pure functions over source text; the file-reading
// and module-enumeration glue lives in the suite that enforces the rules.

/** The names in one exported declarator list, split at bracket depth 0
 * (an initializer's own commas belong to their declarator). String and
 * template literals are skipped whole — SQL statement heads and prose
 * contain commas and semicolons of their own, and their contents are
 * never declarators. */
function declaratorNames(list: string): string[] {
	const pieces: string[] = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	while (i < list.length) {
		const ch = list.charAt(i);
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			i++;
			while (i < list.length) {
				if (list.charAt(i) === "\\") i += 2;
				else if (list.charAt(i) === quote) {
					i++;
					break;
				} else i++;
			}
			continue;
		}
		if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (ch === "," && depth === 0) {
			pieces.push(list.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	pieces.push(list.slice(start));
	return pieces
		.map((piece) => /^([A-Za-z_$][\w$]*)/.exec(piece.trim())?.[1])
		.filter((name): name is string => name !== undefined);
}

/** Source with comments removed, string/template literals preserved
 * whole — a `//` inside a SQL statement head must not read as a line
 * comment. Every regex scan below runs over this text: matching raw
 * barrel text would let a commented-out re-export forge completeness
 * coverage for an actually-unreachable export — a silent false pass, the
 * worst direction for this guard. */
export function stripComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === "/" && source.charAt(i + 1) === "/") {
			while (i < source.length && source.charAt(i) !== "\n") i++;
			continue;
		}
		if (ch === "/" && source.charAt(i + 1) === "*") {
			i += 2;
			while (
				i < source.length &&
				!(source.charAt(i) === "*" && source.charAt(i + 1) === "/")
			)
				i++;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			out += ch;
			i++;
			while (i < source.length) {
				const c = source.charAt(i);
				if (c === "\\") {
					out += c + source.charAt(i + 1);
					i += 2;
					continue;
				}
				out += c;
				i++;
				if (c === quote) break;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Source with string/template literal contents removed (the quote
 * characters kept, so token structure survives): a `;` inside a literal
 * must not terminate the declarator capture — the capture would stop at
 * the literal and silently drop every declarator after it from the
 * accounting. Runs over comment-stripped source, so a quote inside a
 * comment cannot desync it. */
export function blankLiterals(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			out += quote;
			i++;
			while (i < source.length && source.charAt(i) !== quote) {
				i += source.charAt(i) === "\\" ? 2 : 1;
			}
			if (i < source.length) {
				out += quote;
				i++;
			}
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** True when the scan would hold a `'`/`"` literal open across a raw
 * newline. A quoted literal containing a raw newline is a syntax error
 * in TS, so holding one open across a line break means the scan has
 * swallowed code — the signature of a quote inside a regex literal
 * (telling `/` division from a regex start needs a real tokenizer, which
 * stripComments deliberately is not). A desynced scan copies the file
 * tail verbatim, so a commented-out re-export past the regex would forge
 * completeness coverage — this predicate turns that silent false pass
 * into a named failure. Template literals may span lines legitimately.
 * Runs over comment-stripped source. */
export function hasRunawayString(source: string): boolean {
	let i = 0;
	while (i < source.length) {
		const ch = source.charAt(i);
		if (ch === '"' || ch === "'") {
			const quote = ch;
			i++;
			while (i < source.length && source.charAt(i) !== "\n") {
				if (source.charAt(i) === "\\") {
					i += 2;
					continue;
				}
				if (source.charAt(i) === quote) break;
				i++;
			}
			// Still open at the newline (or EOF): the scan is desynced.
			if (i >= source.length || source.charAt(i) === "\n") return true;
			i++;
			continue;
		}
		if (ch === "`") {
			i++;
			while (i < source.length && source.charAt(i) !== "`") {
				i += source.charAt(i) === "\\" ? 2 : 1;
			}
			i++;
			continue;
		}
		i++;
	}
	return false;
}

/** Type declarations of one (comment-stripped, literal-blanked) module
 * source: name, exportedness, and body text. A `type` body runs to the
 * `;` at bracket depth 0; an `interface` body runs from after its name
 * (so an `extends` clause counts as a reference) to the matching `}`.
 * A `type`-alias head with a generic parameter list is not parsed
 * (`type X<T> =` fails the name-then-`=` pattern; generic interface
 * heads parse fine) — none exist in this package; teach this parser
 * before relying on the reachability rule below if one is ever
 * needed. */
export function typeDeclarations(
	source: string,
): { name: string; exported: boolean; body: string }[] {
	const decls: { name: string; exported: boolean; body: string }[] = [];
	for (const match of source.matchAll(
		/\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g,
	)) {
		const start = (match.index ?? 0) + match[0].length;
		let depth = 0;
		let end = start;
		while (end < source.length) {
			const ch = source.charAt(end);
			if ("([{".includes(ch)) depth++;
			else if (")]}".includes(ch)) {
				if (depth === 0) break;
				depth--;
			} else if (ch === ";" && depth === 0) break;
			end++;
		}
		decls.push({
			name: match[1] as string,
			exported: match[0].startsWith("export"),
			body: source.slice(start, end),
		});
	}
	for (const match of source.matchAll(
		/\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
	)) {
		let i = (match.index ?? 0) + match[0].length;
		while (i < source.length && source.charAt(i) !== "{") {
			if (source.charAt(i) === ";") break;
			i++;
		}
		if (source.charAt(i) !== "{") continue;
		const start = (match.index ?? 0) + match[0].length;
		let depth = 1;
		let end = i + 1;
		while (end < source.length && depth > 0) {
			const ch = source.charAt(end);
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			end++;
		}
		decls.push({
			name: match[1] as string,
			exported: match[0].startsWith("export"),
			body: source.slice(start, end),
		});
	}
	return decls;
}

/** Exported names one module source declares: declarations plus re-export
 * lists (value or type). */
export function declaredNames(rawSource: string): Set<string> {
	const source = stripComments(rawSource);
	const names = new Set<string>();
	const patterns = [
		/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
		/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
		/export\s+interface\s+([A-Za-z_$][\w$]*)/g,
		/export\s+type\s+([A-Za-z_$][\w$]*)\s*=/g,
		/export\s+enum\s+([A-Za-z_$][\w$]*)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			names.add(match[1] as string);
		}
	}
	// The declarator list of every const/let/var, so a multi-declarator
	// statement (`export const a = 1, b = 2`) is accounted name by name
	// rather than invisible to the accounting. The capture runs over
	// literal-blanked source — a `;` inside a literal must not terminate
	// the list, or every declarator after it is silently dropped — and
	// declaratorNames splits at depth-0 commas, so each
	// `name = initializer` piece contributes its leading identifier.
	for (const match of blankLiterals(source).matchAll(
		/export\s+(?:const|let|var)\s+([^;]+)/g,
	)) {
		for (const name of declaratorNames(match[1] as string)) names.add(name);
	}
	for (const match of source.matchAll(
		/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g,
	)) {
		for (const piece of (match[1] as string).split(",")) {
			const name = piece.trim().replace(/^type\s+/, "");
			if (name !== "") names.add(name);
		}
	}
	// Re-export lists without a `from` (a local re-binding) ride the
	// same accounting — the barrel's surface is what matters, not where
	// the binding came from.
	for (const match of source.matchAll(
		/export\s+(?:type\s+)?\{([^}]*)\}\s*;/g,
	)) {
		for (const piece of (match[1] as string).split(",")) {
			const name = piece.trim().replace(/^type\s+/, "");
			if (name !== "") names.add(name);
		}
	}
	return names;
}

/** Re-export lists of one source keyed by specifier — the attribution
 * edge the coverage check walks from a barrel to the module it covers. */
export function reExportLists(rawSource: string): Map<string, Set<string>> {
	const source = stripComments(rawSource);
	const lists = new Map<string, Set<string>>();
	for (const match of source.matchAll(
		/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
	)) {
		const names = lists.get(match[2] as string) ?? new Set<string>();
		for (const piece of (match[1] as string).split(",")) {
			const name = piece.trim().replace(/^type\s+/, "");
			if (name !== "") names.add(name);
		}
		lists.set(match[2] as string, names);
	}
	return lists;
}
