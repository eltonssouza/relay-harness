# Documentação técnica: auditoria estática universal

Esta página descreve a arquitetura implementada para a auditoria estática universal no Relay. Para operadores, consulte primeiro o [manual em português](auditoria-manual.pt-BR.md). A [referência completa em inglês](audit.md) contém detalhes adicionais de arquitetura, decisões e operação.

## 1. Escopo e propriedades

A auditoria é um subsistema local e sob demanda do pacote `@relay-harness/coding-agent`. O executor realiza análise estática assistida por modelo sobre um snapshot, valida estruturas e evidências e persiste relatórios locais. Os comandos ficam registrados por padrão (`RELAY_AUDIT_ENABLED=0` antes da inicialização do host os remove) e não leem o alvo antes de `/audit-app`. Sem argumentos, `/audit-app` usa `automaticConfig()` (`src/core/audit/config.ts`): alvo = diretório atual, modelo = provedor/modelo selecionado, snapshot `working-tree` (HEAD Git só se `.git` existir), exclusões de dependências/caches/builds (`AUTOMATIC_EXCLUDES`), saída em `~/.relay/agent/audits/<alvo>-<hash>/` fora do alvo e orçamentos ampliados dentro dos limites do preflight. A configuração derivada passa pelo mesmo `preflight()`; o consentimento de egress é obtido por uma única confirmação que mostra alvo, modelo, saída e teto de custo, e a recusa não lê nem envia nada. Um arquivo de configuração continua disponível como opção avançada.

**A implementação não fornece** sandbox de sistema operacional, execução de testes, acesso ao histórico Git, busca de CVEs atuais, avaliação de conformidade, certificação, geração PDF, publicação remota ou uma garantia de encontrar todas as vulnerabilidades. O uso do SDK e dos fornecedores já existentes não altera as propriedades de segurança desses componentes.

### Drivers e trade-offs

| Prioridade | Decisão | Custo/limitação assumida |
| --- | --- | --- |
| Menor autoridade | Ferramentas limitadas a listagem, leitura e busca literal no snapshot; nenhum shell, escrita geral ou ferramenta de rede. | O modelo não pode executar PoC ou validar comportamento em runtime. |
| Evidência verificável | Hashes dos arquivos originais, linhas/ranges, schemas e recibos do executor. | Mascaramento é heurístico e os trechos apresentados ao modelo são redigidos. |
| Cobertura honesta | Inventário denomina examinados, não verificados, binários, inacessíveis e excluídos. | Exclusões e limites produzem status parcial, não uma conclusão de inaplicabilidade. |
| Recuperabilidade | Checkpoints versionados, lock exclusivo e reutilização de tarefas aceitas. | É preciso manter configuração, recursos e snapshot compatíveis para retomar. |
| Implantação simples | Coordenador no processo Relay e artefatos em diretório local. | Armazenamento, permissões e retenção são responsabilidade do operador. |

## 2. Vistas C4 e fronteiras

### Nível 1 — contexto

```text
Operador
  ├── configura consentimento e seleciona o modelo
  ├── inicia/status/cancela/retoma
  v
Host Relay (fronteira confiável existente)
  ├── worker SDK e coordenador da auditoria
  ├── alvo: dados de entrada não confiáveis, somente snapshot
  ├── diretório privado: artefatos de saída da auditoria
  └── provedor de modelo selecionado: egress autorizado explicitamente
```

O provedor recebe contexto e código redigido de acordo com o escopo. A autorização explícita de egress não deve ser confundida com `external_network_access`, que se refere às capacidades de rede da auditoria e é rejeitado quando habilitado.

### Nível 2 — containers existentes

Não são adicionados processos de serviço, API HTTP, broker, banco de dados ou scheduler implantável. O fluxo utiliza:

1. processo Node/Bun do Relay;
2. SDK/model runtime e credenciais do host existentes;
3. filesystem do projeto, consultado para produzir um snapshot limitado;
4. filesystem local de saída, separado e controlado pelo operador.

### Nível 3 — componentes

```text
packages/coding-agent/src/extensions/audit/index.ts
  comandos de host, validação de argumentos, seleção explícita de modelo
                     |
                     v
src/core/audit/config.ts -> preflight, consentimento, limites e canonicalização
                     |
                     v
src/core/audit/snapshot.ts -> inventário, exclusões, redaction e recibos de leitura
                     |
                     v
src/core/audit/coordinator.ts -> fases, plano, scheduling, limites, checkpoint e cancelamento
             |              |                    |
             v              v                    v
src/core/audit/contracts.ts runtime.ts       store.ts
schemas, gates semânticos   sessões SDK       lock/checkpoint/artifacts
             \              |                    /
              \             v                   /
               -> report.ts -> JSON/Markdown local
```

`packages/coding-agent/resources/audit/` contém cópias aprovadas de schemas, papéis, roteamento, políticas, exemplos e documentação do protocolo. `getAuditResourcesPath()` resolve o recurso através do caminho de recursos já distribuído pelo pacote. O manifesto SHA-256 detecta drift acidental; a atualização é explícita e revisada.

O ponto de composição em `src/extensions/index.ts` registra apenas os comandos `/audit-app*` (removíveis com `RELAY_AUDIT_ENABLED=0`); nenhum alvo é lido antes da confirmação. A integração **não** importa ou ativa o subsistema experimental de delegação validada.

## 3. Configuração e preflight

`readAuditConfig()` aceita JSON ou YAML de até 64 KiB, requer arquivo regular e não segue symlinks. Caminhos relativos no conteúdo são resolvidos a partir da localização do arquivo de configuração. A validação rejeita:

- versão não suportada, chaves desconhecidas, consentimentos ausentes e tipos/tamanhos inválidos;
- divergência entre `{provider,id}` autorizados e modelo ativo;
- rede de ferramentas, testes/sandbox dinâmicos, histórico Git, escrita geral, publicação remota ou PDF;
- padrões de escopo absolutos, com `..`, separadores Windows ou `:`;
- alvos que não sejam diretórios e destinos de saída que contenham o alvo, sejam o próprio alvo, ou usem `.git`, symlink/junction, dispositivo/rede.

A política `snapshot.policy: working-tree` é obrigatória e explícita: arquivos modificados, não rastreados e ignorados podem participar se corresponderem ao escopo. `git_revision: true` autoriza somente a tentativa limitada de ler `HEAD` e uma ref solta; o resultado não lê histórico e pode ficar indisponível em worktrees/packed refs.

Saída dentro do projeto é opcional, exige `allow_output_in_target: true` e designa somente a subpasta de saída. O conteúdo dessa subpasta é excluído do snapshot. Essa permissão não concede capacidades de escrita no alvo.

Limites absolutos adicionais são aplicados pelo preflight. `max_task_cost` e `max_cost` usam custo informado pelo provedor; não são garantias transacionais de cobrança.

## 4. Snapshot, segurança e evidências

### 4.1 Inventário

`createSnapshot()` percorre diretórios em ordem determinística, cede o event loop periodicamente, verifica cancelamento e prazo e interrompe se os limites de arquivos/bytes forem excedidos. Não reduz silenciosamente o denominador.

Somente arquivos regulares, sem hardlinks, com texto UTF-8 e dentro dos limites entram no conteúdo acessível. Links/junctions não são seguidos. Sub-repositórios, binários, arquivos sensíveis, maiores que o limite, inacessíveis e saídas excluídas são registrados com status/razão no inventário. Metadados Git ficam fora do snapshot do worker.

O digest identifica os bytes de origem; o texto entregue às sessões recebe mascaramento heurístico que preserva a posição aproximada das linhas. O digest não é hash do texto redigido. Mascaramento pode falhar; não se deve autorizar egress de dados que não possam ser enviados ao modelo.

### 4.2 Acesso do worker

`createSdkWorker()` cria sessão por tarefa com settings e histórico em memória, `agentDir` sob a pasta de saída e `auditResourceLoader()` vazio: sem descoberta de arquivos `AGENTS.md`, skills, prompts, plugins ou extensão do repositório. O parâmetro SDK `tools` é uma allowlist e precisa conter os nomes das próprias ferramentas personalizadas; passar `tools: []` as desabilitaria.

Allowlist instalada:

| Ferramenta | Permissão |
| --- | --- |
| `audit_list` | Lista fatias limitadas do inventário. |
| `audit_read` | Lê linhas limitadas de um arquivo textual incluído no snapshot. |
| `audit_search` | Busca literal limitada no conteúdo em memória; não interpreta regex/glob fornecido pelo modelo. |

O caminho é relativo POSIX; caminhos absolutos, traversal, drive/UNC, symlink, arquivos excluídos e arquivos fora do snapshot falham. Resultados de ferramentas recebem delimitadores de dados não confiáveis. Isso é isolamento de capacidades dentro do processo confiável Relay, não sandbox de OS contra host/provedor malicioso ou outro processo com as mesmas permissões.

### 4.3 Observações de leitura

O executor registra intervalos `{path,start,end}` realmente fornecidos pela ferramenta `audit_read`. Alegações de cobertura e evidência precisam corresponder a esses recibos; descoberta e threat model precisam indicar arquivos observados. Para `EXAMINADO`, todas as linhas do arquivo precisam ter sido abertas. Evidência de finding precisa ter faixa lida, hash dos bytes originais, localização no snapshot e trecho compatível. O revisor deve reler todos os ranges associados ao status `CONFIRMADO`.

Recibos atestam que o worker recebeu esses bytes através da ferramenta; não provam que o modelo os interpretou corretamente. A avaliação continua sujeita a alucinação e erro de julgamento.

## 5. Roteamento, contratos e revisão

O roteamento imutável tem 20 IDs de domínio (`01`–`20`) e seis papéis especialistas. A descoberta estabelece `yes`, `unknown` ou `no`; `no` precisa de referência observada e não pode decorrer de exclusão. Planejamento é derivado da descoberta e do roteamento local, não do conteúdo do repositório.

Handoff enviado pelo especialista só pode apontar a uma tarefa primária existente cujo papel esteja explicitamente na lista de consulta do domínio. O coordenador verifica identidade, ciclo e limite global e cria tarefa de consulta separada; consultas não podem iniciar outra consulta.

`contracts.ts` aplica AJV 2020-12 aos schemas upstream sem modificá-los, mais regras semânticas de identidade, revisão, evidência, hash, escopo, cobertura, exclusões e rotas. Parsing rejeita JSON truncado, saída maior que limite e estruturas excessivamente profundas/volumosas.

Especialistas produzem somente `POTENCIAL` ou `REQUER_VALIDACAO`; confirmação, descarte e deduplicação são decisões do executor/revisor. Um validador recebe nova sessão, abre os ranges e registra ID, decisão, motivo e método. Rejeição, falta de evidência ou falha de revisão vira limitação/estado parcial, não confirmação implícita. Alegações CVE/CVSS atuais e certificações legais não são confirmadas por este modo estático.

## 6. Persistência, retomada e falhas

`AuditStore` cria um diretório por ID com permissão restrita solicitada, valida nome/caminho, exige lock exclusivo e limita artefatos a arquivos regulares. As escritas passam por arquivo temporário no mesmo diretório, fsync e rename. Checkpoints têm versão e digest; a cópia anterior permite recuperação de checkpoint interrompido. Essa integridade não autentica um invasor local com permissão para reescrever os arquivos e seus hashes.

A retomada requer snapshot/configuração/recursos idênticos; valida tarefas, resultados imutáveis, revisão, artefatos e referências. Tarefa em andamento/interrompida pode ser repetida dentro dos limites. Artefatos aceitos conservam a saída original; veredictos vivem em registros separados. Mudança ou falha em revalidar o alvo invalida a consolidação e impede retomada da execução antiga.

Falha de especialista preserva irmãos bem-sucedidos; erro de limite, cancelamento, falha de persistência/revisão ou arquivos não verificados deixa a execução `PARTIAL`/`FAILED`. Artefatos válidos em outros formatos permanecem disponíveis se a geração de Markdown/JSON falhar. Não se deve interpretar ausência de `report.md` como ausência de resultados: consulte `audit-run.json`, checkpoint e `artifact-manifest.json`.

`/audit-app-status` durante uma execução mostra a memória do processo; status persistido requer o ID (`/audit-app-status audit-<uuid>` no mesmo diretório, para execuções automáticas) ou arquivo de configuração e ID. `/audit-app-resume audit-<uuid>` retoma uma execução automática com o mesmo diretório e modelo. Lock stale só pode ser removido explicitamente quando o PID registrado é comprovadamente inexistente; processos ativos/estado indeterminado falham fechados.

## 7. Relatórios e dados

`report.ts` calcula totais determinísticos a partir dos veredictos aceitos. Finding duplicado continua listado com ID e origem próprios, mas referencia o canônico e não incrementa contagem única. Itens não confirmados, descartados e duplicados ficam em grupos separados.

O modelo de relatório produz texto editorial, não achados/totais/conclusões autoritativos; a narrativa fica identificada como rascunho não verificado. O renderizador determinístico gera os status, contagens, evidências, domínios, limitações e referências disponíveis. Rascunhos de issue são arquivos locais, desativados por padrão e nunca enviados à rede.

Os outputs incluem `effective-config.json`, `resource-version.json`, `inventory.json`, `discovery.json`, `threat-model.json`, resultados por tarefa, registros do validador, `checkpoint.json`, `audit-run.json`, `findings.json`, `strengths.json`, `coverage.json`, recibos/trechos, `metrics.json`, `report.json`, `report.md` e `artifact-manifest.json`. Não se persistem transcrições cruas. A retenção é manual; os artefatos persistem até exclusão pelo operador.

## 8. Threat model (STRIDE)

| ID | Categoria | Vetor e controle implementado | Risco residual |
| --- | --- | --- | --- |
| T-01 | Spoofing | Arquivo/config não confiáveis tentam declarar outro provider/model; preflight exige igualdade com seleção do host. | A autenticação/transporte do provedor é herdada do host. |
| T-02 | Tampering | Worker tenta alterar hash, ID, faixa, escopo, cobertura ou schema; validação semântica rejeita mismatch. | Provedor pode produzir julgamento semântico errado com evidência formalmente válida. |
| T-03 | Repudiation | Tarefa/veredicto sem origem ou recibo; IDs e artefatos locais de fase registram atribuição e decisão. | Sem assinatura remota nem armazenamento imutável contra administrador local. |
| T-04 | Information disclosure | Prompt injection solicita shell, credenciais ou arquivos; allowlist de snapshot, loader vazio e exclusões/redaction limitam exfiltração. | Redaction heurística, provider e outros plugins confiáveis do host continuam na fronteira. |
| T-05 | Denial of service | Repositório com muitas entradas/arquivos, worker lento ou output enorme; limites de arquivos/bytes/tokens/custo/tempo/paralelismo e cancelamento. | Limites e cobranças do provedor podem não ser transacionais; I/O depende de OS/filesystem. |
| T-06 | Elevation of privilege | Handoff ou texto de repositório tenta iniciar ferramenta/consulta arbitrária; rota fixa, allowlist, sem delegação recursiva. | Extensões/host executam com permissões do usuário fora desta sandbox de capacidades. |
| T-07 | Corrupção de estado | Crash/retomada adulterada; lock, schema/identity validation, checkpoint versionado/digests e manifest. | Hash sem chave não detecta adulteração deliberada de mesmo usuário. |

## 9. Instalação, atualização e verificação

Recursos são cópias aprovadas e empacotadas; a aplicação não depende do checkout irmão `agents-skills`. O manifesto registra hash de cada recurso. O script de manutenção roda somente de forma explícita:

```sh
node scripts/update-audit-resources.mjs --check
node scripts/update-audit-resources.mjs /caminho/da/origem-autorizada --authorized
```

Após atualizar, revise o diff de recursos, manifesto e contratos antes de aceitar a atualização. Runs existentes com hash/versão de recursos incompatíveis não são retomados.

A matriz de regressão está em `packages/coding-agent/test/audit-automatic.test.ts` (`/audit-app` sem argumentos de ponta a ponta com modelo roteirizado, recusa de consentimento e opt-out), `audit-boundaries.test.ts`, `audit-contracts.test.ts`, `audit-coordinator.test.ts` e `audit-runtime.test.ts`; inclui sessão SDK real com provider faux. Para gates de pacote e standalone, veja `scripts/coding-agent-consumer.test.mjs` e `scripts/audit-standalone.test.mjs`. Comandos de validação do repositório estão documentados em `AGENTS.md` e `package.json`; avaliações com modelos reais exigiriam consentimento e credenciais próprios e não são substituídas por testes sintéticos.

## 10. ADRs

1. **Coordenador local em vez de microserviços:** o workflow é local e não justifica brokers, DB ou custo operacional distribuído. Custo: responsabilidades de persistência local ficam no pacote.
2. **Worker SDK restrito em vez de shell ou delegação genérica:** reduz autoridade e evita herdar estado; custo: testes dinâmicos e exploração de PoC não são suportados.
3. **Schemas upstream + AJV 2020-12:** mantém compatibilidade de contratos e referências condicionais; custo: dependências runtime adicionais.
4. **Snapshot e checkpoints locais:** operação simples e independente de serviço; custo: ACL, retenção e durabilidade dependem do host/filesystem.
5. **Recursos copiados e fixados por digest:** execução não depende de rede ou checkout vizinho; custo: atualização requer revisão e sincronização de versão.
6. **Relatório estático, sem score/certificação:** impede que contagem ou prosa do modelo seja vendida como garantia; custo: resultados requerem interpretação humana e não substituem análise dinâmica/aconselhamento legal.
