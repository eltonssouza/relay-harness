import {
	type AgentId,
	CAPABILITY_TIERS,
	type CapabilityTier,
	REASONING_EFFORTS,
	type TaskScope,
	type TaskType,
	type ToolRequirement,
	type ValidationLevel,
} from "./questions.ts";

/**
 * Synthetic bootstrap exercises for training Laya before the harness has telemetry.
 *
 * Each template fixes the task profile; the tier and effort follow from it by the same rule for
 * every template, so the labels are consistent. These are opinion-based labels. Replace them over
 * time with evidence-based labels exported from telemetry (`/laya export`).
 */

interface Template {
	type: TaskType;
	/** Indexes into the score levels of `questions.ts`. */
	complexity: 0 | 1 | 2 | 3 | 4;
	scope: TaskScope;
	risk: 0 | 1 | 2 | 3;
	ambiguity: 0 | 1 | 2;
	reasoning: 0 | 1 | 2 | 3 | 4;
	agent: AgentId;
	validation: ValidationLevel;
	/** w=write s=shell t=tests W=web b=browser d=database g=git */
	tools: string;
	security?: boolean;
	texts: string[];
}

const TOOL_FLAGS: Record<string, ToolRequirement> = {
	w: "requires_write",
	s: "requires_shell",
	t: "requires_tests",
	W: "requires_web",
	b: "requires_browser",
	d: "requires_database",
	g: "requires_git",
};

const t = (
	type: TaskType,
	complexity: Template["complexity"],
	scope: TaskScope,
	risk: Template["risk"],
	ambiguity: Template["ambiguity"],
	reasoning: Template["reasoning"],
	agent: AgentId,
	validation: ValidationLevel,
	tools: string,
	texts: string[],
	security = false,
): Template => ({ type, complexity, scope, risk, ambiguity, reasoning, agent, validation, tools, texts, security });

const TEMPLATES: Template[] = [
	t("question", 0, "single_file", 0, 0, 0, "researcher", "none", "", [
		"What does the function {fn} in {file} return?",
		"O que a função {fn} em {file} retorna?",
		"Where is {fn} defined?",
		"Onde fica definida a função {fn}?",
	]),
	t("question", 1, "module", 0, 0, 1, "researcher", "none", "", [
		"How does the {module} module load its configuration?",
		"Como o módulo {module} carrega a configuração?",
		"Explain how {module} handles errors.",
		"Explique como o {module} trata erros.",
	]),
	t("question", 2, "repository", 0, 1, 2, "software-architect", "none", "", [
		"Why does the {module} package depend on {module2}? Is that coupling necessary?",
		"Por que o pacote {module} depende do {module2}? Esse acoplamento é necessário?",
	]),
	t("question", 1, "single_file", 0, 2, 1, "researcher", "none", "", [
		"Is this approach ok?",
		"Isso está certo?",
		"Can you take a look at {file}?",
		"Dá uma olhada no {file}?",
	]),
	t("code_edit", 0, "single_line", 0, 0, 0, "frontend-engineer", "syntax", "w", [
		"Change the text of the submit button to 'Save'.",
		"Corrija o texto deste botão para 'Salvar'.",
		"Fix the typo in the error message of {file}.",
		"Corrija o erro de digitação na mensagem de erro de {file}.",
	]),
	t("code_edit", 0, "single_line", 0, 0, 0, "software-engineer", "compile", "wt", [
		"Rename the variable {var} to {var2} in {file}.",
		"Renomeie a variável {var} para {var2} em {file}.",
		"Change the default timeout in {file} from 30 to 60 seconds.",
		"Mude o timeout padrão em {file} de 30 para 60 segundos.",
	]),
	t("code_edit", 1, "single_file", 0, 0, 1, "software-engineer", "compile", "wt", [
		"Remove the unused imports from {file}.",
		"Remova os imports não usados de {file}.",
		"Make {fn} in {file} async.",
		"Transforme {fn} em {file} em uma função assíncrona.",
	]),
	t("code_edit", 0, "single_file", 0, 0, 0, "software-engineer", "none", "g", [
		"Commit the staged changes with a descriptive message.",
		"Faça o commit das mudanças com uma mensagem descritiva.",
		"Create a branch for this fix.",
		"Crie uma branch para essa correção.",
	]),
	t("code_edit", 1, "single_file", 1, 0, 1, "devops-engineer", "compile", "ws", [
		"Bump Node to 22 in the Dockerfile.",
		"Atualize a versão do Node para 22 no Dockerfile.",
		"Add a cache step for npm in the CI workflow.",
		"Adicione cache do npm no workflow do CI.",
	]),
	t("bug_fix", 1, "single_file", 1, 0, 1, "software-engineer", "unit_test", "wt", [
		"{fn} in {file} returns undefined when the list is empty; it should return an empty array.",
		"A função {fn} em {file} retorna undefined quando a lista está vazia; deveria retornar um array vazio.",
		"Off-by-one error in the pagination of {module}: the last page is skipped.",
		"Erro de off-by-one na paginação do {module}: a última página é pulada.",
	]),
	t("bug_fix", 1, "single_file", 0, 0, 1, "frontend-engineer", "syntax", "w", [
		"The header is misaligned on small screens.",
		"O cabeçalho está desalinhado em telas pequenas.",
		"Fix the CSS so the footer sticks to the bottom.",
		"Arrume o CSS para o rodapé ficar no final da página.",
	]),
	t("bug_fix", 2, "module", 1, 1, 2, "backend-engineer", "unit_test", "wt", [
		"The {module} API returns 500 when the request body has no 'email' field. It should return 400.",
		"A API do {module} retorna 500 quando o corpo não tem o campo 'email'. Deveria retornar 400.",
		"Dates are saved in local time instead of UTC in the {module} service.",
		"As datas são salvas no horário local em vez de UTC no serviço {module}.",
	]),
	t("bug_fix", 2, "single_file", 1, 1, 2, "frontend-engineer", "integration_test", "wtb", [
		"The dropdown in the settings page closes immediately on mobile.",
		"O dropdown da página de configurações fecha sozinho no celular.",
		"The modal does not trap focus; keyboard users can tab behind it.",
		"O modal não prende o foco; quem usa teclado consegue navegar por trás dele.",
	]),
	t("bug_fix", 3, "multi_module", 2, 1, 3, "backend-engineer", "integration_test", "wts", [
		"Race condition: two workers in {module} sometimes process the same job twice.",
		"Condição de corrida: dois workers do {module} às vezes processam o mesmo job duas vezes.",
		"Memory leak in the {module} cache under load; memory grows until the process is killed.",
		"Vazamento de memória no cache do {module} sob carga; a memória cresce até o processo cair.",
	]),
	t("bug_fix", 3, "module", 2, 1, 3, "mobile-engineer", "integration_test", "wt", [
		"The Android app crashes on startup on Android 14 only.",
		"O app Android fecha ao abrir apenas no Android 14.",
	]),
	t("debugging", 2, "single_file", 1, 1, 2, "software-engineer", "unit_test", "wts", [
		"I get 'TypeError: cannot read properties of undefined' when running the app. Help.",
		"Estou recebendo 'TypeError: cannot read properties of undefined' ao rodar o app. Ajuda.",
	]),
	t("debugging", 3, "module", 1, 2, 3, "software-engineer", "unit_test", "wts", [
		"The test '{test}' fails only on CI with a timeout and passes locally. Find out why.",
		"O teste '{test}' falha só no CI com timeout e passa localmente. Descubra o motivo.",
		"Something broke after the last merge: {module} hangs on startup. Investigate.",
		"Alguma coisa quebrou depois do último merge: o {module} trava na inicialização. Investigue.",
	]),
	t("debugging", 4, "multi_module", 2, 2, 4, "software-architect", "integration_test", "wts", [
		"Intermittent data corruption between the {module} and {module2} services, no clear reproduction. Find the root cause.",
		"Corrupção de dados intermitente entre os serviços {module} e {module2}, sem reprodução clara. Ache a causa raiz.",
		"Deadlock under high concurrency in the scheduler; it happens about once a day in production.",
		"Deadlock com alta concorrência no scheduler; acontece mais ou menos uma vez por dia em produção.",
	]),
	t("refactor", 1, "single_file", 0, 0, 1, "software-engineer", "compile", "wt", [
		"Convert {file} from JavaScript to TypeScript.",
		"Converta {file} de JavaScript para TypeScript.",
		"Replace var with const and let in {file}.",
		"Troque var por const e let em {file}.",
	]),
	t("refactor", 2, "single_file", 1, 0, 2, "software-engineer", "unit_test", "wt", [
		"Extract the validation logic of {file} into its own function.",
		"Extraia a lógica de validação de {file} para uma função separada.",
		"Split {file}; it has 1500 lines.",
		"Divida {file}, que tem 1500 linhas.",
	]),
	t("refactor", 3, "multi_module", 2, 1, 3, "software-architect", "unit_test", "wt", [
		"Replace the global singleton config in {module} with dependency injection across the packages.",
		"Substitua o singleton global de configuração do {module} por injeção de dependência em todos os pacotes.",
		"Migrate all callbacks in {module} to async/await.",
		"Migre todos os callbacks do {module} para async/await.",
	]),
	t("refactor", 4, "repository", 2, 2, 4, "software-architect", "integration_test", "wtg", [
		"Restructure the monorepo so {module} becomes an independent package without breaking consumers.",
		"Reestruture o monorepo para o {module} virar um pacote independente sem quebrar quem usa.",
	]),
	t("feature", 1, "single_file", 0, 0, 1, "software-engineer", "unit_test", "wt", [
		"Add a --verbose flag to the CLI that prints debug logs.",
		"Adicione uma flag --verbose na CLI que imprima logs de debug.",
		"Add a helper in {file} that formats bytes as KB or MB.",
		"Crie em {file} uma função que formata bytes como KB ou MB.",
	]),
	t("feature", 2, "module", 1, 1, 2, "backend-engineer", "unit_test", "wt", [
		"Add a GET /users/:id/orders endpoint with pagination.",
		"Crie um endpoint GET /users/:id/orders com paginação.",
		"Add retry with exponential backoff to the HTTP client in {module}.",
		"Adicione retry com backoff exponencial no cliente HTTP do {module}.",
	]),
	t("feature", 2, "module", 1, 1, 2, "frontend-engineer", "integration_test", "wtb", [
		"Add a dark mode toggle to the settings page.",
		"Adicione um botão de modo escuro na página de configurações.",
		"Create a reusable date picker component.",
		"Crie um componente reutilizável de seleção de data.",
	]),
	t("feature", 2, "module", 1, 1, 2, "mobile-engineer", "integration_test", "wt", [
		"Add push notifications to the Android app.",
		"Adicione notificações push no app Android.",
		"The iOS app needs offline caching of the feed.",
		"O app iOS precisa de cache offline do feed.",
	]),
	t("feature", 2, "module", 1, 1, 2, "software-engineer", "unit_test", "wtW", [
		"Integrate the {tech} SDK following its official docs.",
		"Integre o SDK do {tech} seguindo a documentação oficial.",
	]),
	t("feature", 2, "single_file", 1, 0, 2, "database-engineer", "unit_test", "wtd", [
		"Add an index to speed up the orders-by-customer query.",
		"Adicione um índice para acelerar a consulta de pedidos por cliente.",
		"Write a SQL query that returns monthly revenue per product.",
		"Escreva uma consulta SQL que retorne o faturamento mensal por produto.",
	]),
	t(
		"feature",
		2,
		"module",
		3,
		1,
		3,
		"database-engineer",
		"review",
		"wd",
		[
			"Write a migration that drops the legacy column from the production orders table.",
			"Escreva uma migration que remove a coluna legada da tabela de pedidos de produção.",
			"Run a data migration on the production database to backfill user emails.",
			"Rode uma migração de dados no banco de produção para preencher os e-mails dos usuários.",
		],
		true,
	),
	t("feature", 3, "multi_module", 2, 1, 3, "backend-engineer", "integration_test", "wtsd", [
		"Implement multi-tenant support in {module}: every query must be scoped by tenant.",
		"Implemente suporte multi-tenant no {module}: toda consulta tem que filtrar pelo tenant.",
	]),
	t("feature", 3, "repository", 2, 1, 3, "devops-engineer", "integration_test", "wsg", [
		"Set up a release pipeline that builds, tests and publishes the packages on tag.",
		"Monte um pipeline de release que compila, testa e publica os pacotes quando criar uma tag.",
		"Deploy the {module} service to Kubernetes with zero downtime.",
		"Faça o deploy do serviço {module} no Kubernetes sem downtime.",
	]),
	t("feature", 4, "multi_module", 2, 2, 4, "software-architect", "integration_test", "wts", [
		"Build a plugin system so third parties can add commands at runtime.",
		"Crie um sistema de plugins para terceiros adicionarem comandos em tempo de execução.",
		"Implement a CRDT-based collaborative editing engine.",
		"Implemente um motor de edição colaborativa baseado em CRDT.",
	]),
	t("test", 0, "single_file", 0, 0, 0, "qa-engineer", "unit_test", "t", [
		"Run the tests and tell me what fails.",
		"Rode os testes e me diga o que falha.",
		"Run the type checker.",
		"Rode a checagem de tipos.",
	]),
	t("test", 1, "single_file", 0, 0, 1, "qa-engineer", "unit_test", "wt", [
		"Write unit tests for {fn} in {file}.",
		"Escreva testes unitários para {fn} em {file}.",
		"Add a regression test for the empty input case of {fn}.",
		"Adicione um teste de regressão para a entrada vazia de {fn}.",
	]),
	t("test", 2, "module", 1, 1, 2, "qa-engineer", "integration_test", "wts", [
		"The test suite of {module} is flaky; stabilize the flaky tests.",
		"A suíte de testes do {module} está instável; estabilize os testes flaky.",
		"Add integration tests for the checkout flow.",
		"Adicione testes de integração para o fluxo de checkout.",
	]),
	t("architecture", 3, "multi_module", 1, 2, 3, "software-architect", "review", "", [
		"Propose an event-driven architecture for the notification system of our services.",
		"Proponha uma arquitetura orientada a eventos para o sistema de notificações dos nossos serviços.",
		"Evaluate whether we should split {module} into microservices.",
		"Avalie se devemos dividir o {module} em microsserviços.",
	]),
	t("architecture", 4, "multi_repository", 2, 2, 4, "software-architect", "review", "W", [
		"Design a distributed cache invalidation strategy across our three regions with strong consistency.",
		"Desenhe uma estratégia de invalidação de cache distribuído entre nossas três regiões com consistência forte.",
		"Analyze the concurrency model of the system and propose how to remove the global lock.",
		"Analise o modelo de concorrência do sistema e proponha como remover o lock global.",
	]),
	t(
		"security",
		3,
		"module",
		3,
		1,
		3,
		"security-engineer",
		"review",
		"wt",
		[
			"Fix the SQL injection in the search endpoint of {module}.",
			"Corrija o SQL injection no endpoint de busca do {module}.",
			"The password reset token never expires; fix it.",
			"O token de redefinição de senha nunca expira; corrija.",
		],
		true,
	),
	t(
		"security",
		3,
		"module",
		3,
		1,
		3,
		"security-engineer",
		"review",
		"",
		[
			"Review the authentication middleware for vulnerabilities.",
			"Revise o middleware de autenticação procurando vulnerabilidades.",
			"Audit how API keys are stored in {module}.",
			"Audite como as chaves de API são guardadas no {module}.",
		],
		true,
	),
	t(
		"security",
		4,
		"multi_module",
		3,
		1,
		4,
		"security-engineer",
		"review",
		"wtd",
		[
			"Implement OAuth2 login with refresh token rotation.",
			"Implemente login OAuth2 com rotação de refresh token.",
			"Add payment processing with Stripe webhooks and idempotency.",
			"Adicione processamento de pagamentos com webhooks do Stripe e idempotência.",
		],
		true,
	),
	t("documentation", 1, "single_file", 0, 0, 1, "software-engineer", "syntax", "w", [
		"Update the README with the new installation steps.",
		"Atualize o README com os novos passos de instalação.",
		"Add doc comments to the public functions of {file}.",
		"Escreva a documentação da função {fn}.",
	]),
	t("documentation", 2, "module", 0, 1, 2, "software-architect", "syntax", "w", [
		"Write an ADR documenting why we chose {tech} for the job queue.",
		"Escreva um ADR documentando por que escolhemos {tech} para a fila de jobs.",
	]),
	t("research", 1, "single_file", 0, 1, 2, "researcher", "none", "W", [
		"Compare {tech} and {tech2} for our use case.",
		"Compare {tech} e {tech2} para o nosso caso.",
		"What changed in the latest version of {tech}?",
		"Pesquise as novidades da última versão do {tech}.",
	]),
	t("research", 2, "repository", 0, 1, 2, "researcher", "none", "", [
		"Map every place where {module} writes to disk.",
		"Mapeie todos os lugares onde o {module} grava em disco.",
		"List the modules that would be affected by changing the signature of {fn}.",
		"Liste os módulos afetados se mudarmos a assinatura de {fn}.",
	]),
];

const SLOTS: Record<string, string[]> = {
	file: [
		"src/utils/date.ts",
		"app/models/user.py",
		"src/main/java/OrderService.java",
		"lib/cache.go",
		"src/components/Header.tsx",
		"internal/auth/token.go",
		"src/api/routes.ts",
		"services/billing.rb",
	],
	fn: ["parseDate", "calculateTotal", "getUser", "formatPrice", "loadConfig", "mergeOptions", "validateInput"],
	module: ["billing", "auth", "orders", "notifications", "search", "sync", "scheduler", "gateway"],
	var: ["data", "tmp", "res", "cfg"],
	var2: ["payload", "buffer", "response", "config"],
	test: ["should refresh token", "renders header", "handles retries"],
	tech: ["Redis", "Kafka", "RabbitMQ", "PostgreSQL", "Stripe", "Sentry"],
};

/** Optional stack mention appended to a request; it varies the text without changing the labels. */
const STACKS = ["TypeScript", "Python", "Go", "Java", "Kotlin", "Swift", "Ruby", "Rust"];
const STACK_FORMATS = ["", " ({stack})", " [{stack}]", " - {stack}"];

/** Tier from the task profile: the cheapest tier for its difficulty, raised for risk and security. */
export function seedTier(template: Pick<Template, "complexity" | "reasoning" | "risk" | "security">): CapabilityTier {
	const difficulty = Math.max(template.complexity, template.reasoning);
	let index = difficulty <= 1 ? 0 : difficulty - 1;
	if (template.risk >= 2 || template.security) index = Math.max(index, 2);
	return CAPABILITY_TIERS[Math.min(index, CAPABILITY_TIERS.length - 1)];
}

/** Deterministic PRNG (mulberry32), so the same count yields the same exercises. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

export interface SeedRow {
	state: { request: string };
	expected: Record<string, string | number | boolean>;
	source: "synthetic";
}

/**
 * Generates up to `count` distinct exercises in laya-trainer's dataset format, the same number per
 * template, so templates with many slot combinations do not crowd out the others.
 */
export function generateSeed(count: number, seed = 2026): SeedRow[] {
	const next = random(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
	const rows: SeedRow[] = [];
	const seen = new Set<string>();
	const quota = Math.ceil(count / TEMPLATES.length);
	const produced = new Map<Template, number>();
	for (let attempt = 0; rows.length < count && attempt < count * 50; attempt++) {
		const template = TEMPLATES[attempt % TEMPLATES.length];
		if ((produced.get(template) ?? 0) >= quota) continue;
		const module = pick(SLOTS.module);
		const tech = pick(SLOTS.tech);
		const stack = pick(STACK_FORMATS).replace("{stack}", pick(STACKS));
		const request =
			pick(template.texts).replace(/\{(\w+)\}/g, (_, slot: string) => {
				if (slot === "module") return module;
				if (slot === "module2") return pick(SLOTS.module.filter((value) => value !== module));
				if (slot === "tech") return tech;
				if (slot === "tech2") return pick(SLOTS.tech.filter((value) => value !== tech));
				return pick(SLOTS[slot]);
			}) + stack;
		if (seen.has(request)) continue;
		seen.add(request);
		produced.set(template, (produced.get(template) ?? 0) + 1);
		const tools = Object.fromEntries(
			Object.entries(TOOL_FLAGS).map(([flag, id]) => [id, template.tools.includes(flag)]),
		);
		rows.push({
			state: { request },
			expected: {
				task_type: template.type,
				complexity: template.complexity,
				scope: template.scope,
				risk: template.risk,
				ambiguity: template.ambiguity,
				reasoning_requirement: template.reasoning,
				capability_tier: seedTier(template),
				reasoning_effort: REASONING_EFFORTS[template.reasoning],
				agent: template.agent,
				validation_level: template.validation,
				...tools,
				security_sensitive: template.security ?? false,
			},
			source: "synthetic",
		});
	}
	return rows;
}
