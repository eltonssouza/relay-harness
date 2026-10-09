export interface RetrievableTool {
	name: string;
	label?: string;
	description?: string;
}

export type ToolRetrievalOutcome = "answer" | "approval" | "clarify" | "refuse" | "retrieve";

export interface ToolRetrievalEvaluation {
	candidateCount: number;
	retrievedCount: number;
	invokedCount: number;
	invokedRetrievedCount: number;
}

const aliases: Record<string, string> = {
	abrir: "read",
	abra: "read",
	abre: "create",
	ache: "find",
	atualizar: "update",
	atualize: "update",
	baixar: "read",
	arquivo: "file",
	arquivos: "file",
	buscar: "search",
	busque: "search",
	changelog: "changelog",
	crie: "create",
	cliente: "client",
	custos: "data",
	encontre: "search",
	encontrar: "search",
	execute: "run",
	ficheiro: "file",
	fornecedor: "vendor",
	gere: "write",
	implement: "write",
	executar: "run",
	leia: "read",
	lembrete: "task",
	lentamente: "slow",
	find: "search",
	issue: "issue",
	issues: "issue",
	localizar: "search",
	locate: "search",
	metricas: "data",
	minuta: "write",
	planilha: "spreadsheet",
	problema: "issue",
	problemas: "issue",
	processo: "documentation",
	procure: "search",
	compare: "compare",
	procurar: "search",
	publique: "deploy",
	publicar: "deploy",
	politica: "documentation",
	reembolso: "documentation",
	release: "release",
	repository: "repository",
	repositorio: "repository",
	run: "run",
	search: "search",
	test: "test",
	teste: "test",
	testes: "test",
	requisito: "requirement",
	relatorio: "report",
	reverta: "revert",
	noticias: "news",
	grafico: "graph",
	plano: "plan",
	mail: "email",
	esqueci: "history",
	version: "release",
	versao: "release",
	salve: "write",
	stub: "stub",
	write: "write",
};

const toolIntentTerms: Record<string, readonly string[]> = {
	bash: ["build", "ci", "command", "endpoint", "execute", "migration", "performance", "script", "slow", "test"],
	browser: ["feed", "news", "page", "site", "web"],
	read: ["config", "documentation", "email", "feed", "fixture", "open", "read", "requirement", "spreadsheet"],
	search: [
		"chart",
		"graph",
		"client",
		"compare",
		"data",
		"document",
		"email",
		"endpoint",
		"find",
		"history",
		"integration",
		"issue",
		"locate",
		"migration",
		"repository",
		"revert",
		"rollback",
		"search",
		"symbol",
		"vendor",
	],
	write: [
		"changelog",
		"create",
		"draft",
		"edit",
		"graph",
		"implement",
		"modify",
		"plan",
		"report",
		"stub",
		"task",
		"update",
		"write",
	],
};

const abstentionTerms = new Set(["credential", "credenciais"]);

/** Classifies cases where tool discovery must abstain or require user confirmation. */
export function classifyToolRetrievalOutcome(prompt: string): ToolRetrievalOutcome {
	const normalized = prompt.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	if (/credenciais? de producao|production credentials|imprima.*impressora/u.test(normalized)) return "refuse";
	if (/\b(reverta|transfer|transfira|migration)\b/u.test(normalized)) return "approval";
	if (
		/\b(aquilo|aquela funcao|para o paulo)\b/u.test(normalized) ||
		/me avisa assim que|me avise quando/u.test(normalized) ||
		/almoco.*20h/u.test(normalized)
	)
		return "clarify";
	if (
		/quanto tempo preciso|qual e o total|voce acha|quais ferramentas|aqui esta um json|here is .*json/u.test(
			normalized,
		)
	)
		return "answer";
	return "retrieve";
}

function terms(text: string): string[] {
	return (
		text
			.normalize("NFD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	).map((word) => aliases[word] ?? word.replace(/s$/u, ""));
}

/** Ranks tools using their model-facing metadata and a small Portuguese-English vocabulary. */
export function retrieveTools(prompt: string, tools: readonly RetrievableTool[], limit: number): string[] {
	const query = new Set(terms(prompt).filter((word) => word.length > 2 || word === "ci"));
	const outcome = classifyToolRetrievalOutcome(prompt);
	if (outcome === "answer" || outcome === "clarify" || outcome === "refuse") return [];
	if ([...query].some((word) => abstentionTerms.has(word))) return [];
	return tools
		.map((tool) => {
			const metadata = new Set([
				...terms(`${tool.name} ${tool.label ?? ""} ${tool.description ?? ""}`),
				...(toolIntentTerms[tool.name] ?? []),
			]);
			return { name: tool.name, score: [...query].filter((word) => metadata.has(word)).length };
		})
		.filter((tool) => tool.score > 0)
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map((tool) => tool.name);
}

/** Observed counts only: invocation does not prove relevance or retrieval precision. */
export function evaluateToolRetrieval(
	candidateCount: number,
	retrievedNames: readonly string[],
	invokedNames: readonly string[],
): ToolRetrievalEvaluation {
	const retrieved = new Set(retrievedNames);
	const invoked = new Set(invokedNames);
	return {
		candidateCount,
		retrievedCount: retrieved.size,
		invokedCount: invoked.size,
		invokedRetrievedCount: [...invoked].filter((name) => retrieved.has(name)).length,
	};
}
