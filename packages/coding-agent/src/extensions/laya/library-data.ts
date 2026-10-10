import type { LibraryIndex } from "./library.ts";
import { libraryScenario } from "./library-scenarios.ts";
import { LIBRARY_SHORT_REQUESTS } from "./library-short-scenarios.ts";
import { LIBRARY_CATEGORY_IDS, LIBRARY_DIRECTORIES, type LibraryCategoryId } from "./questions.ts";
import type { TrainingRow } from "./training.ts";

/** Independently worded validation/test examples; never reused as training templates. */
const HELD_OUT: Record<LibraryCategoryId, string[]> = {
	languages: [
		"Why does a JavaScript closure keep the old value after the loop ends?",
		"Como cancelar uma Promise sem depender de um framework?",
		"Explain Rust ownership when a value moves into a closure.",
		"Qual a diferença entre tipos union e intersection no TypeScript?",
		"How do Python generators yield values without storing the entire sequence?",
		"Por que o event loop executa microtasks antes de timers no JavaScript?",
		"Compare Java virtual threads with platform threads in the standard library.",
		"Como funciona o empréstimo mutável no Rust?",
	],
	algorithms: [
		"Find the shortest path in a weighted graph with nonnegative edges.",
		"Como provar a complexidade de uma busca binária?",
		"Implement a heap supporting insertion and extraction of the minimum.",
		"Quando usar programação dinâmica em vez de uma estratégia gulosa?",
		"Explain why hash table lookup has amortized constant complexity.",
		"Como detectar um ciclo em um grafo direcionado?",
		"Choose a sorting algorithm when stability matters and input barely fits memory.",
		"Implemente uma árvore balanceada para buscas ordenadas.",
	],
	architecture: [
		"Define aggregate boundaries for orders and payments using DDD.",
		"Como impedir que o domínio dependa da camada de infraestrutura?",
		"Write an architecture decision record comparing a modular monolith with microservices.",
		"Explique o padrão Strategy para substituir condicionais de domínio.",
		"Decide which service owns a domain event and how consumers couple to it.",
		"Como modelar um agregado no Domain-Driven Design?",
		"Compare hexagonal architecture with layered architecture for a billing system.",
		"Como documentar os limites e responsabilidades dos componentes de um sistema?",
	],
	engineering: [
		"Write a failing unit test before fixing the off-by-one error.",
		"Como isolar dependências externas ao testar código legado?",
		"Review test smells caused by mocking every collaborator.",
		"Configure o ESLint para impedir variáveis não utilizadas.",
		"Explain the FIRST principles for deterministic unit tests.",
		"Como usar TDD para construir um cálculo de descontos?",
		"Use Playwright to verify keyboard navigation without flaky sleeps.",
		"Como medir cobertura de testes com Istanbul sem confundir cobertura com qualidade?",
	],
	databases: [
		"Choose a composite Postgres index for equality filters followed by a date range.",
		"Como impedir atualizações perdidas com isolamento de transações?",
		"Explain the difference between a star schema and an operational data model.",
		"Quando escolher documentos em vez de tabelas relacionais?",
		"Diagnose a full table scan in the SQL query execution plan.",
		"Como tratar eventos atrasados em processamento de streams?",
		"Compare snapshot isolation with serializable transactions.",
		"Por que a ordem das colunas de um índice composto afeta uma consulta SQL?",
	],
	web_frontend: [
		"Design the REST API for a payments service, including resource URLs and status codes.",
		"Como criar um formulário com erros acessíveis a leitores de tela?",
		"Explain the WebSocket upgrade handshake and connection lifecycle.",
		"Quando escolher CSS Grid em vez de Flexbox?",
		"Reduce layout shift by reserving space for images in a web page.",
		"Como definir paginação e códigos de erro de uma API REST?",
		"Improve the visual hierarchy and contrast of a checkout form.",
		"Como implementar navegação por teclado em componentes web acessíveis?",
	],
	devops: [
		"Rebase a feature branch before opening a pull request.",
		"Qual a diferença entre Kubernetes Deployment e StatefulSet?",
		"Reduce Docker image size with a multi-stage container build.",
		"Como definir um SLO e calcular o orçamento de erros?",
		"Design a deployment pipeline with rollback after a failed health check.",
		"Como reverter um commit no Git sem reescrever o histórico compartilhado?",
		"Use distributed traces and metrics to investigate a production latency spike.",
		"Como configurar um rollout gradual no Kubernetes?",
	],
	security: [
		"Is this SSH tunnel safe to expose publicly?",
		"Como corrigir XSS em uma caixa de pesquisa que renderiza entrada do usuário?",
		"Threat model a password reset flow and identify replay attacks.",
		"Quais controles do OWASP ASVS verificam autorização no servidor?",
		"Review parameterized SQL queries for injection vulnerabilities.",
		"Como aplicar minimização de dados pessoais segundo o GDPR?",
		"Harden SSH forwarding so only intended clients can reach the service.",
		"Como avaliar riscos de privacidade ao coletar telemetria?",
	],
	automation: [
		"Build an n8n workflow that calls three LLMs and combines their answers.",
		"Como limitar as ferramentas de um agente construído com um Agent SDK?",
		"Configure Hermes Agent to resume an interrupted automation workflow.",
		"Como evitar execuções duplicadas em um fluxo do n8n?",
		"Implement handoffs between LLM agents using an agent SDK.",
		"Como orquestrar três LLMs com o n8n e tratar falhas de uma chamada?",
		"Give Hermes Agent a recurring workflow with bounded tool access.",
		"Como registrar o estado de execução de agentes em um SDK de LLM?",
	],
	frameworks: [
		"Explain React memo, useMemo and reconciliation when a component rerenders.",
		"Por que minha página Next.js 16 renderiza novamente a cada tecla?",
		"Configure dependency injection scopes in Spring Boot.",
		"Como usar signals em um componente Angular?",
		"Fix a Django ORM relation that causes an N+1 query pattern.",
		"Como configurar rotas e middleware no Express 5?",
		"Use Vue computed properties to derive component state.",
		"Como compartilhar estado entre componentes Svelte 5?",
	],
};

/** Mixed-stack requests whose dominant problem belongs to one guide category. */
const TRAIN_BOUNDARIES: Record<LibraryCategoryId, readonly [string, string, string]> = {
	languages: [
		"A React callback passes a TypeScript union to a helper. Explain the language's narrowing rules before considering any component changes.",
		"An HTTP server written in Go copies a slice and both copies change together. Explain the language's memory and slice semantics.",
		"Uma aplicação Django usa um argumento padrão mutável em Python. Corrija a semântica da função, mantendo o framework fora da solução.",
	],
	algorithms: [
		"A React page searches a dependency graph. Choose an algorithm to order its nodes and detect impossible dependency cycles.",
		"A database service must find the top ten values from a large unsorted stream. Focus on the data structure and asymptotic cost.",
		"Um serviço em Kubernetes calcula rotas entre pontos. Escolha o algoritmo de busca conforme os pesos das arestas e prove seu custo.",
	],
	architecture: [
		"Our Express application mixes billing rules with ORM entities. Redesign the dependency boundaries and ownership of domain behavior.",
		"A frontend and a REST service share business concepts. Define bounded contexts and the contracts between them before choosing transports.",
		"Uma aplicação Spring cresceu em módulos acoplados. Defina responsabilidades e fronteiras arquiteturais sem depender de configurações do framework.",
	],
	engineering: [
		"A React checkout has an intermittent browser regression test. Investigate test isolation and deterministic assertions using Playwright.",
		"A SQL adapter has untested error paths. Write characterization tests before changing its implementation and isolate the database boundary.",
		"Um serviço Dockerizado tem testes dependentes da hora atual. Injete um relógio e verifique o comportamento com testes unitários repetíveis.",
	],
	databases: [
		"A Kubernetes-hosted application waits on Postgres row locks. Explain transaction ordering and isolation before changing pod resources.",
		"A NestJS report endpoint is slow because of its SQL access plan. Choose an index based on filtering and ordering, preserving the controller.",
		"Um pipeline de entrega inclui uma migração de dados. Analise a consistência e os bloqueios das transações executadas pela migração.",
	],
	web_frontend: [
		"A Spring controller implements an HTTP API. Define resource URLs, conditional requests and error representations independently of Spring.",
		"A React application embeds an HTML form. Repair label associations, error announcements and keyboard navigation using web standards.",
		"Uma página Next.js contém um layout CSS que transborda. Ajuste o comportamento de Grid e Flexbox sem alterar o ciclo de renderização do framework.",
	],
	devops: [
		"A Django service has a healthy application but broken Kubernetes readiness configuration. Diagnose deployment probes and traffic routing.",
		"A security patch is ready on a Git topic branch. Integrate it with the updated main branch and resolve history conflicts safely.",
		"Um serviço Java precisa de deploy gradual e rollback por métricas. Configure o pipeline e os critérios operacionais de promoção.",
	],
	security: [
		"An SSH forwarding configuration starts successfully but exposes an internal management service. Analyze access restrictions and the threat boundary.",
		"An Express route reads another account's records because it trusts an object ID. Enforce authorization and verify object ownership.",
		"Uma consulta SQL funciona rápido, mas concatena entrada não confiável. Remova a possibilidade de injeção e revise a validação de segurança.",
	],
	automation: [
		"A JavaScript step in n8n calls several model APIs. Coordinate retries and persist workflow progress rather than explaining language syntax.",
		"An LLM agent must delegate part of its task and resume with the returned evidence. Implement the handoff and tool limits using an agent SDK.",
		"Uma automação Hermes consulta uma API REST e chama um LLM. Defina a retomada do fluxo e a prevenção de ações repetidas após falhas.",
	],
	frameworks: [
		"A TypeScript program runs inside Angular and its signal-based component fails to update. Diagnose Angular's reactive component lifecycle.",
		"A Java service loses transactions when a Spring bean invokes its own method. Explain Spring proxy behavior and fix the bean interaction.",
		"Uma página usa JavaScript, mas o defeito está nas dependências de um hook React. Ajuste o effect e sua limpeza conforme o ciclo de vida do componente.",
	],
};

/** Index titles are label evidence, never guessed from agent roles or framework keywords. */
export function generateLibraryDataset(index: LibraryIndex): TrainingRow[] {
	const rows: TrainingRow[] = [];
	for (const category of LIBRARY_CATEGORY_IDS) {
		const guides = index.categories.find((item) => item.id === LIBRARY_DIRECTORIES[category])?.files;
		if (!guides?.length) throw new Error(`No guides for library category ${category}`);
		const count = guides.length * Math.max(6, Math.ceil(60 / guides.length / 6) * 6);
		for (let i = 0; i < count; i++) {
			const guide = guides[i % guides.length];
			const subject = guide.title.replace(/ - (Complete Professional Guide|Guia Completo|The Complete Book)$/, "");
			const variant = Math.floor(i / guides.length);
			const { request, language } = libraryScenario(subject, variant);
			rows.push({
				id: `lib-${category}-${i + 1}`,
				state: { request },
				expected: { library_category: category },
				source: "library",
				split: "train",
				language,
				guide: guide.path,
				label_source: "index-agent-scenario",
			});
		}
		TRAIN_BOUNDARIES[category].forEach((request, i) => {
			rows.push({
				id: `lib-${category}-boundary-${i + 1}`,
				state: { request },
				expected: { library_category: category },
				source: "library",
				split: "train",
				language: i === 2 ? "pt" : "en",
				boundary: true,
				label_source: "agent",
			});
		});
		HELD_OUT[category].forEach((request, i) => {
			rows.push({
				id: `lib-${category}-held-${i + 1}`,
				state: { request },
				expected: { library_category: category },
				source: "library",
				split: i < 4 ? "val" : "test",
				language: i % 2 ? "pt" : "en",
				boundary: true,
				label_source: "agent",
			});
		});
		LIBRARY_SHORT_REQUESTS[category].forEach((request, i) => {
			rows.push({
				id: `lib-${category}-short-${i + 1}`,
				state: { request },
				expected: { library_category: category },
				source: "library",
				split: "train",
				language: i < 14 ? "en" : "pt",
				boundary: i === 13 || i === 19,
				label_source: "agent-short-scenario",
			});
		});
	}
	const unique = new Set(rows.map((row) => row.state.request.toLowerCase().replace(/\s+/g, " ").trim()));
	if (unique.size !== rows.length) throw new Error("Duplicate requests in library dataset");
	return rows;
}
