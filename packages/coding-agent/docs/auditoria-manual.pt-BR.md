# Manual de uso: auditoria estática universal

Este manual explica como executar e operar a auditoria estática integrada ao Relay. Para arquitetura, contratos, ameaças, persistência e detalhes de implementação, consulte a [documentação técnica em português](auditoria-tecnica.pt-BR.md) e a [referência completa em inglês](audit.md).

## O que a funcionalidade faz

A auditoria cria um snapshot local do repositório, analisa esse snapshot em 20 domínios, valida as evidências com uma sessão revisora independente e salva relatórios locais. As sessões usam o SDK do Relay e o modelo que você selecionou e autorizou na confirmação do `/audit-app` (ou no arquivo de configuração).

Ela **não** executa comandos ou código do repositório, não faz testes dinâmicos, não publica issues, não usa histórico Git e não gera PDF. Não é certificação, parecer jurídico nem garantia de ausência de vulnerabilidades. Uma análise estática com status `COMPLETED` continua sujeita a falsos positivos e falsos negativos.

## Antes de começar

1. Use uma versão do Relay que contenha a integração.
2. Não altere o repositório durante a auditoria.
3. Selecione com `/model` um provedor/modelo autorizado a receber o código e o contexto necessários à análise. A autorização também vale para modelos locais.

A redação de segredos é heurística; não garante que todos os dados sensíveis sejam removidos. Se os dados do repositório não puderem ser enviados ao modelo selecionado, **não confirme** a auditoria.

## Executar automaticamente

Inicie o Relay no diretório do repositório e execute:

```text
/audit-app
```

Não é preciso variável de ambiente nem arquivo de configuração. O Harness configura a auditoria sozinho:

| Configuração | Valor automático |
| --- | --- |
| Alvo | Diretório atual do Relay |
| Modelo | O provedor/modelo selecionado; uma única confirmação mostra alvo, modelo, diretório dos relatórios e teto de custo antes de qualquer leitura ou envio |
| Snapshot | `working-tree` (inclui arquivos modificados, não rastreados e ignorados); identidade do HEAD Git só quando `.git` existe |
| Exclusões | Dependências, caches e saídas de build (`node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `coverage`, `.next`, `target`, ...), registradas como excluídas no inventário; credenciais e metadados Git são sempre excluídos |
| Relatórios | `~/.relay/agent/audits/<alvo>-<hash>/audit-<uuid>/`, fora do repositório |
| Orçamentos | Dentro dos limites do preflight: 10 min por tarefa, 4 h por execução, 200 mil tokens por tarefa, 2 milhões por execução, teto de custo 10 |

Se você recusar a confirmação, nada é lido nem enviado. Ao final, o Relay mostra o status e o caminho do `report.md`.

Os comandos ficam registrados por padrão e só leem o alvo depois da confirmação do `/audit-app`. Para removê-los, defina `RELAY_AUDIT_ENABLED=0` **antes de iniciar** o Relay. Eles não habilitam delegação experimental nem concedem ao worker ferramentas de shell ou escrita.

## Configuração avançada (opcional)

Use um arquivo apenas para auditar outro diretório ou mudar escopo, orçamentos ou contexto. Salve como `audit.yaml` em um local controlado, de preferência fora do repositório. Os caminhos `repository_path` e `output_root` são relativos **ao diretório do arquivo de configuração**.

```yaml
version: '3.0'
project:
  name: meu-projeto
  repository_path: ../meu-repositorio

# Consentimento explícito para examinar a working tree, incluindo arquivos
# modificados, não rastreados e ignorados que correspondam a `include`.
snapshot:
  policy: working-tree
  git_revision: false # true permite ler somente HEAD/ref solto, nunca histórico

scope:
  include: ['**/*']
  exclude: ['node_modules/**', 'dist/**', '.next/**', 'vendor/**']
  output_root: ./relatorios-auditoria
  runtime_testing: false
  sandbox_authorized: false
  external_network_access: false
  git_history_analysis: false
  allow_write_to_target: false
  allow_publish_github_issues: false

model:
  authorized: true # autoriza enviar contexto/código redigido a este modelo
  provider: SEU_PROVEDOR_SELECIONADO
  id: SEU_ID_EXATO_DE_MODELO

context:
  target_jurisdictions: []
  regulated_industries: []
  personal_data_processing: unknown # yes | no | unknown

execution:
  max_parallel_specialists: 1 # de 1 a 4
  max_retries: 1 # de 0 a 2
  max_task_ms: 120000
  max_run_ms: 1800000
  max_task_tokens: 16000
  max_task_cost: 2
  max_task_tool_calls: 40
  max_task_output_bytes: 65536
  max_tokens: 200000
  max_cost: 10
  max_tool_calls: 200
  max_output_bytes: 262144
  max_handoffs: 20
  generate_issues_drafts: false
```

Substitua o nome, os caminhos e os identificadores do modelo. `provider` e `id` precisam corresponder exatamente ao modelo atualmente selecionado no Relay. A execução falha se houver divergência; não há fallback automático.

A configuração é validada estritamente. Chaves desconhecidas e opções não suportadas são rejeitadas. Os limites máximos são: 4 especialistas em paralelo; 600.000 ms por tarefa; 86.400.000 ms por execução; 200.000 tokens por tarefa e 2.000.000 por execução; 1.000 chamadas de ferramenta por tarefa e 10.000 por execução; 1 MiB de saída por tarefa e 1 MiB total; 100 handoffs; 2 tentativas adicionais conforme `max_retries`; snapshot de 100.000 arquivos, 1 MiB por arquivo e 100 MiB total. O valor `max_cost` é um limite com base no custo reportado pelo provedor, **não** uma garantia de cobrança ou limite transacional do provedor.

### Saída dentro do repositório (evite se possível)

Prefira `output_root` externo. Caso precise gravar em uma subpasta do repositório, informe a pasta exata e adicione:

```yaml
scope:
  output_root: ./meu-repositorio/relatorios-auditoria
  allow_output_in_target: true
```

A saída autorizada é excluída do snapshot. Essa opção **não** autoriza modificar arquivos-fonte; `allow_write_to_target: true` continua sendo rejeitado. Raiz do repositório, diretórios ancestrais, `.git`, links/junctions e caminhos de rede/dispositivo não são destinos válidos.

## Executar e controlar

Execute `/audit-app` sem argumentos (ou `/audit-app "C:/caminho com espaços/audit.yaml"` com a configuração avançada).

O processo roda em segundo plano. O Relay informa o identificador `audit-<uuid>` e, ao final, o status e o caminho do `report.md`. Consulte o andamento:

```text
/audit-app-status
```

Para consultar uma execução persistida, no mesmo diretório do Relay:

```text
/audit-app-status audit-<uuid>
```

Com a configuração avançada, informe o mesmo arquivo: `/audit-app-status "C:/caminho/audit.yaml" audit-<uuid>`.

Cancelar mantém checkpoints e resultados parciais:

```text
/audit-app-cancel
/audit-app-cancel audit-<uuid>
```

O encerramento da sessão do Relay também solicita cancelamento. Uma chamada já em andamento no provedor pode demorar para terminar; o controle de orçamento não garante limite de cobrança do provedor.

## Retomar uma execução

No mesmo diretório e com o mesmo modelo, use o identificador fornecido pela execução interrompida:

```text
/audit-app-resume audit-<uuid>
```

Com a configuração avançada, informe o mesmo arquivo: `/audit-app-resume "C:/caminho/audit.yaml" audit-<uuid>`.

A retomada verifica o hash do snapshot, a versão/hash dos recursos, a configuração e os resultados persistidos. Tarefas concluídas compatíveis podem ser reutilizadas; tarefas interrompidas ou bloqueadas podem ser tentadas novamente. Se o repositório tiver mudado, não reutilize a execução: inicie uma nova.

Se o processo morreu e deixou um lock, só solicite recuperação após verificar que o processo original não está ativo:

```text
/audit-app-resume audit-<uuid> --recover-stale-lock
```

A opção não força a remoção de locks ativos ou cujo estado não possa ser verificado. Não use a recuperação como forma de rodar duas instâncias sobre a mesma pasta.

## Entender status e relatórios

- `COMPLETED`: as etapas obrigatórias terminaram sem limitações que invalidem a completude definida pela implementação. **Não** significa auditoria exaustiva ou certificação.
- `PARTIAL`: houve itens não verificados, falha/limite/interrupção, mudança do alvo, revisão ausente ou formato de saída que não pôde ser gerado. Consulte as limitações e a cobertura.
- `FAILED`: não foi possível produzir resultado de auditoria utilizável. Verifique as mensagens do Relay e os artefatos disponíveis.
- Status intermediários indicam a fase atual da execução.

Os arquivos ficam em `~/.relay/agent/audits/<alvo>-<hash>/audit-<uuid>/` (ou `output_root/audit-<uuid>/` com a configuração avançada). Os principais são:

| Arquivo | Conteúdo |
| --- | --- |
| `report.md` | Relatório legível por pessoas, limitações e referências locais. |
| `report.json` | Totais e estrutura determinística dos achados, cobertura e status. |
| `findings.json` | Candidatos e decisões, inclusive itens não confirmados/descartados. |
| `coverage.json` | Situação e contagens por tarefa/domínio. |
| `inventory.json` | Inventário do snapshot, hashes e itens omitidos. |
| `evidence-*.json` | Trechos redigidos observados e referência à evidência de origem. |
| `audit-run.json` | Estado, tarefas, autorizações declaradas e referências. |
| `checkpoint.json` | Estado verificável usado para retomada; não edite manualmente. |
| `artifact-manifest.json` | Hashes dos artefatos finais. |
| `issue-draft-*.md` | Rascunhos locais opcionais; nunca são publicados. |

`CONFIRMADO` exige evidência relida por uma sessão revisora independente. `POTENCIAL` e `REQUER_VALIDACAO` não são achados confirmados. Duplicatas mantêm sua origem e apontam para o registro canônico. Totais de confirmação não incluem potenciais, itens descartados ou duplicatas.

O inventário distingue arquivos examinados, não verificados, binários, grandes demais, inacessíveis, links, metadados Git e exclusões. Exclusão ou ausência de evidência **não** significa que um domínio não se aplica. Leia sempre as seções “Coverage” e “Limitations”.

## Privacidade, segurança e retenção

- O repositório e as instruções encontradas nele são dados não confiáveis, não comandos para o worker.
- A análise usa somente o snapshot redigido. O worker possui leitura/listagem/busca limitadas a essa cópia; não recebe ferramentas de shell, rede, escrita, plugins, MCP ou instruções automáticas do repositório.
- A extensão não é um sandbox do sistema operacional. Provedores e extensões do host continuam pertencendo à fronteira de confiança do Relay.
- O manifesto detecta alterações acidentais nos recursos, não adulteração deliberada por outro processo com as mesmas permissões.
- Arquivos de relatório permanecem no disco até você removê-los. Escolha permissões adequadas para a pasta de saída e aplique a política de retenção da sua organização.

Para problemas de empacotamento ou manutenção dos recursos, consulte a [referência técnica](auditoria-tecnica.pt-BR.md). Para a documentação completa original do protocolo, consulte [`audit.md`](audit.md).
