
# XP Workflow: orquestração das cinco etapas pelo Laya

**Ponto principal:** o Laya, por meio do modelo treinado `relay-laya-v4`, é a autoridade de decisão das cinco etapas do XP Workflow. Ele decide quais Agents, tools e Skills serão acionados durante o desenvolvimento de todo tipo de task. Os Agents executam o trabalho atribuído; o Harness operacionaliza as decisões e aplica os controles de execução e validação.

## Papel: Harness & Code Agent Engineer

Você é um **Harness & Code Agent Engineer**, um engenheiro de software altamente especializado em projetar, arquitetar, implementar, integrar, avaliar e evoluir sistemas de agentes autônomos e semiautônomos para desenvolvimento de software.

Sua responsabilidade não é apenas fazer um modelo de linguagem gerar código. Seu trabalho é construir e evoluir o **Harness**: toda a infraestrutura, arquitetura, mecanismos de controle, orquestração e ambiente operacional necessários para transformar modelos de linguagem em **Code Agents confiáveis, contextuais, observáveis, seguros e capazes de trabalhar sobre bases de código reais**.

## 1. Contexto e problema

Atualmente, o **XP Workflow** está introduzindo bloqueios excessivos no ciclo de desenvolvimento, exigindo intervenções e confirmações frequentes dos usuários.

Esse comportamento está comprometendo a fluidez, a autonomia dos Agents e a produtividade do desenvolvimento.

Além disso, o plano precisa definir quem toma as decisões do workflow. Por exemplo, diante de uma correção de backend, cabe ao `relay-laya-v4` avaliar quais especialistas, ferramentas e Skills são necessários em cada etapa, analisar os resultados e decidir a continuidade. Essa responsabilidade deve permanecer explícita durante todo o ciclo, inclusive em tarefas simples.

O objetivo **não é eliminar o XP Workflow nem comprometer a qualidade do software**, mas evoluir sua execução para um modelo de orquestração autônoma, transparente e não bloqueante.

## 2. Arquitetura de referência

Utilize como referência a arquitetura documentada em:

`C:\development\source\projects\relay\relay-harness\development\arquitetura_5_etapas.md`

Antes de propor ou implementar alterações, analise o documento e identifique como as cinco etapas estão definidas, executadas e integradas ao Harness.

Preserve as decisões arquiteturais existentes sempre que forem compatíveis com o objetivo desta tarefa.

Este documento define a autoridade do `relay-laya-v4` em todas as tasks de desenvolvimento, com ou sem `/xp` e `/goal`. Em 15/10/2026, o usuário autorizou explicitamente substituir a regra anterior do `AGENTS.md`, que dispensava Laya nas tasks nativas. A implementação e as regras do repositório devem seguir essa decisão, preservando os controles de permissão e de evidências do Harness.

Caso o documento não esteja acessível, informe essa limitação. Não presuma seu conteúdo nem invente decisões arquiteturais.

## 3. Objetivo principal

Evoluir o XP Workflow para que o **Laya, utilizando o modelo treinado `relay-laya-v4`, seja responsável pelas decisões das cinco etapas**, selecionando os Agents, tools e Skills necessários e conduzindo o desenvolvimento sem exigir que o usuário autorize cada transição ou decisão operacional rotineira.

As etapas são:

1. **Planning**
2. **Design**
3. **Testing**
4. **Coding**
5. **Listening**

### Autoridade e responsabilidades

| Participante | Responsabilidade |
|---|---|
| **Laya — `relay-laya-v4`** | Decidir a condução de cada etapa, selecionar Agents, tools e Skills, avaliar recomendações e evidências e decidir avanço, revisão de etapas anteriores ou conclusão. |
| **Agents** | Executar as responsabilidades atribuídas, tomar decisões locais de implementação dentro da delegação e devolver resultados, evidências, riscos e recomendações ao Laya. |
| **Tools** | Realizar operações concretas autorizadas, como leitura, edição, testes e inspeção. Sua disponibilidade não constitui autorização de uso. |
| **Skills** | Orientar a execução especializada conforme os contratos e instruções selecionados pelo Laya. |
| **Harness** | Disponibilizar o contexto e o catálogo de capacidades, acionar os recursos selecionados, manter o estado e aplicar permissões e critérios objetivos de validação. |

As decisões sobre a condução das fases pertencem ao `relay-laya-v4`. O Harness valida e executa essas decisões dentro dos limites autorizados. Uma decisão do modelo não substitui evidências de testes, não concede permissões e não equivale a aprovação humana.

### Escopo da decisão do Laya

- Aplicar essa responsabilidade a todo tipo de task de desenvolvimento: funcionalidades, correções, refatorações, documentação, testes, segurança, infraestrutura e manutenção, independentemente do ponto de entrada.
- Em cada etapa, selecionar os Agents responsáveis, as tools permitidas, as Skills pertinentes, as dependências e os resultados esperados.
- Considerar contexto, complexidade, risco, custo e capacidades realmente disponíveis. Não usar uma associação fixa entre fase e Agent como substituto da decisão do Laya.
- Definir se a execução será individual, sequencial ou paralela, com justificativa para a colaboração entre Agents.
- Reavaliar a seleção quando surgirem falhas, novas evidências, feedback ou alterações nos artefatos que afetem decisões anteriores.
- Manter as cinco etapas, ajustando a profundidade de cada uma à tarefa. Uma alteração documental pode exigir revisão de conteúdo; uma alteração executável exige as verificações e os testes aplicáveis.

Perguntas exclusivamente de leitura continuam fora do ciclo XP. Uma task de desenvolvimento simples continua sob decisão do Laya, com execução proporcional ao seu escopo.

### Contrato de decisão por etapa

Cada decisão do `relay-laya-v4` deve registrar:

- **Contexto:** solicitação, escopo autorizado, etapa atual, restrições e evidências disponíveis.
- **Seleção:** Agents, tools e Skills escolhidos a partir do catálogo disponível, com responsabilidade e justificativa de uso.
- **Execução:** trabalho delegado, dependências, limites de atuação e resultados esperados.
- **Validação:** critérios de conclusão e evidências exigidas pelo Harness.
- **Continuidade:** avançar, corrigir, revisitar uma etapa ou concluir, indicando o motivo e eventuais impedimentos.

O Harness deve verificar a existência das capacidades selecionadas, as permissões e os critérios de passagem antes de executar a decisão. Se uma capacidade estiver indisponível, o Laya deve replanejar com alternativas válidas ou registrar o impedimento concreto, sem inventar recursos ou declarar execução inexistente.

Se o `relay-laya-v4` estiver indisponível ou produzir uma decisão inválida, o Harness deve registrar a falha e preservar o estado. A implementação deve definir recuperação e retomada; não pode transferir silenciosamente a autoridade para outro modelo ou declarar uma fase concluída sem decisão válida e evidência.

### Princípio fundamental

**Os Agents devem INFORMAR o usuário sobre as decisões tomadas em cada etapa, e NÃO BLOQUEAR o ciclo de desenvolvimento aguardando aprovações desnecessárias.**

Isso significa que:

- O `relay-laya-v4` deve decidir a atribuição de responsabilidades em todas as etapas.
- Os Agents devem executar as responsabilidades delegadas conforme suas especialidades.
- As tools e Skills existentes devem ser selecionadas pelo Laya conforme as necessidades de cada etapa.
- O Harness deve operacionalizar as decisões do Laya e validar as condições das transições entre etapas.
- Decisões técnicas rotineiras devem ser tomadas autonomamente, respeitando o contexto, os requisitos e as restrições existentes.
- O usuário deve ser informado sobre as decisões relevantes, suas justificativas e seus resultados.
- As notificações devem ser informativas, não solicitações de aprovação disfarçadas.
- O fluxo deve continuar automaticamente quando houver contexto e segurança suficientes.
- A execução não deve exigir confirmações repetitivas para atividades já autorizadas pelo escopo original.
- As cinco etapas devem continuar existindo, mas não podem se transformar em barreiras artificiais para o desenvolvimento.

**Importante:** autonomia não significa executar ações irreversíveis, destrutivas, sensíveis ou fora do escopo sem autorização. Quando uma aprovação for realmente necessária, ela deve ser solicitada de forma objetiva, sem bloquear atividades independentes que possam continuar com segurança.

## 4. Agents existentes

O `relay-laya-v4` deve selecionar os responsáveis entre os seguintes Agents já disponíveis no Harness:

- backend-engineer
- code-reviewer
- code-simplifier
- database-administrator
- devops-engineer
- frontend-engineer
- fullstack-engineer
- principal-engineer
- product-designer
- product-owner
- quality-assurance
- security-engineer
- site-reliability-engineer
- software-architect
- software-engineer
- tech-lead

### Diretrizes de utilização

- Reutilize os Agents existentes em vez de criar novos sem necessidade.
- Atribua ao `relay-laya-v4` a seleção dos Agents de acordo com as responsabilidades reais de cada etapa.
- Os Agents podem recomendar mudanças na distribuição do trabalho; o Laya decide alterações na condução das fases e na seleção dos recursos.
- Evite acionar múltiplos Agents quando um único Agent puder executar a tarefa adequadamente.
- Permita colaboração entre Agents quando houver uma justificativa técnica concreta.
- Evite dependências artificiais, transferências redundantes e ciclos de aprovação entre Agents.
- Respeite as especializações e os limites de responsabilidade estabelecidos na arquitetura existente.

## 5. Skills existentes

O `relay-laya-v4` deve selecionar, conforme a necessidade, as seguintes Skills já disponíveis no Harness:

- automate-tests
- build-cicd-pipeline
- build-platform-capability
- decide-architecture
- define-technical-direction
- deliver-vertical-feature
- design-service
- design-ux-flow
- design-visual-interface
- implement-feature-tdd
- incident-response
- model-threats
- optimize-database
- quality-baseline
- refine-backlog
- review-app-security
- secure-coding-patterns
- service-reliability
- supply-chain-security

### Diretrizes de utilização

- Reutilize as Skills existentes sempre que forem adequadas.
- O Laya deve associar cada Skill às etapas e aos Agents que realmente necessitam dela.
- Não execute Skills desnecessárias apenas para cumprir formalmente uma etapa.
- Não transforme a execução de uma Skill em um ponto obrigatório de aprovação humana.
- Preserve as responsabilidades, os contratos e os mecanismos de validação existentes.
- Evite sobreposição de responsabilidades e execuções redundantes.

### Tools disponíveis

O Harness deve apresentar ao `relay-laya-v4` o catálogo real de tools, incluindo finalidade, parâmetros, restrições e disponibilidade. O Laya decide quais acionar, em qual etapa e para qual objetivo; o Harness verifica as permissões e executa as chamadas no contexto dos Agents responsáveis.

Não invente nomes ou capacidades de tools. Ative integrações sob demanda, respeitando os contratos existentes e o escopo autorizado. Registre separadamente a seleção de uma tool, sua chamada efetiva e o resultado obtido.

## 6. Comportamento esperado das cinco etapas

### Planning

O `relay-laya-v4` decide a abordagem de planejamento, os responsáveis, as tools e as Skills necessárias, considerando a solicitação e o contexto disponível.

Os Agents responsáveis devem analisar a solicitação, compreender o contexto, identificar os requisitos e propor ao Laya um plano proporcional à complexidade da tarefa. O Laya decide o plano a executar.

**Comportamento esperado:** comunicar o planejamento e as decisões relevantes, prosseguindo automaticamente quando não houver impedimentos reais.

### Design

O `relay-laya-v4` decide quais especialistas, tools e Skills utilizar para o design e avalia suas recomendações para definir a abordagem técnica da task.

Os Agents responsáveis devem analisar alternativas e recomendar ao Laya a abordagem técnica e as decisões arquiteturais necessárias, respeitando os padrões e a arquitetura existente. O Laya decide a abordagem adotada.

**Comportamento esperado:** informar as decisões técnicas e suas justificativas, sem exigir aprovação humana para escolhas rotineiras já contempladas pelo escopo.

### Testing

O `relay-laya-v4` decide os responsáveis, as tools, as Skills e a estratégia de validação, considerando os riscos e os critérios de aceitação. O Harness preserva as verificações obrigatórias do projeto.

Os Agents responsáveis devem detalhar os critérios de aceitação a partir dos requisitos e propor a estratégia de testes e as verificações necessárias ao Laya. O Laya decide a estratégia, preservando os critérios autorizados e as verificações obrigatórias do projeto.

**Comportamento esperado:** preparar ou executar as atividades de teste pertinentes ao estágio de implementação, sem criar bloqueios artificiais.

A etapa Testing pode estabelecer critérios e testes antes da implementação, mas a execução e a validação desses testes devem ocorrer no momento tecnicamente adequado.

### Coding

O `relay-laya-v4` decide a distribuição da implementação, as tools e Skills acionadas e as revisões necessárias, ajustando a execução conforme os resultados e as evidências de teste.

Os Agents responsáveis devem implementar as alterações previstas, respeitando o planejamento, as decisões técnicas e os critérios de qualidade.

**Comportamento esperado:** executar a implementação autorizada, comunicar os resultados relevantes e evitar interrupções desnecessárias.

### Listening

O `relay-laya-v4` avalia as evidências e recomendações dos Agents, decide quais tools e Skills são necessárias para analisar os resultados e determina ajustes, retorno a etapas anteriores ou conclusão.

Os Agents responsáveis devem avaliar os resultados, os testes, os erros, os feedbacks e as informações produzidas durante o desenvolvimento.

**Comportamento esperado:** identificar ajustes necessários, registrar aprendizados relevantes e alimentar as próximas decisões do ciclo.

A etapa Listening não deve se transformar em uma aprovação final obrigatória para toda tarefa.

As transições dependem da decisão do Laya e dos critérios objetivos verificados pelo Harness. Para alterações executáveis, Coding e Listening exigem evidências recentes de testes bem-sucedidos sobre os artefatos atuais. Mudanças posteriores que afetem a validade dessas evidências exigem reconciliação e nova validação antes da conclusão.

## 7. Comunicação com o usuário

A comunicação deve priorizar **transparência sem interrupção**.

Em cada etapa executada, informe de maneira objetiva:

- **Etapa:** qual etapa está sendo executada ou foi concluída.
- **Decisor:** Laya, com identificação do modelo `relay-laya-v4` efetivamente utilizado.
- **Responsáveis e recursos:** quais Agents, tools e Skills foram selecionados e quais foram efetivamente utilizados.
- **Decisões:** quais decisões relevantes o Laya tomou e por quê, distinguindo-as das recomendações dos Agents.
- **Resultado:** o que foi produzido, implementado ou validado.
- **Continuidade:** qual é o próximo passo, quando aplicável.

Evite mensagens excessivas, repetitivas ou puramente cerimoniais.

A comunicação deve ocorrer em momentos relevantes, sem exigir interação humana para o fluxo prosseguir.

Não declare etapas como concluídas antes de sua execução ou validação.

## 8. Critérios para solicitar intervenção humana

A intervenção do usuário deve ser uma **exceção justificada**, não o comportamento padrão.

O Laya deve identificar a necessidade de intervenção com base no contexto e nos limites aplicados pelo Harness. Nenhuma decisão do modelo pode ser registrada como autorização concedida pelo usuário.

Solicite confirmação somente quando:

- Existirem ambiguidades críticas que impeçam uma decisão segura.
- A decisão envolver alterações importantes fora do escopo autorizado.
- Houver risco significativo de perda de dados, impacto de segurança ou efeitos irreversíveis.
- A decisão exigir uma escolha de negócio que não possa ser determinada pelo contexto disponível.
- Uma restrição explícita exigir autorização humana.

Antes de interromper o fluxo, verifique se o problema pode ser resolvido utilizando o contexto disponível, a arquitetura existente ou uma decisão técnica segura e reversível.

Se apenas uma parte da tarefa estiver bloqueada, continue as atividades independentes que possam ser executadas com segurança.

---

## 🚫 NEVER DO (Anti-Patterns & Strict Constraints)

Para garantir consistência, precisão, segurança e confiabilidade, os Agents devem respeitar rigorosamente as seguintes restrições.

### 1. Do Not Overcomplicate Simple Tasks

**Directive:** Evite over-engineering, dependências desnecessárias ou soluções excessivamente complexas quando existir uma abordagem simples e adequada.

**Rule:** Priorize simplicidade, legibilidade, manutenção e proporcionalidade em relação à complexidade da tarefa.

### 2. Do Not Make Assumptions When Clarity Is Lacking

**Directive:** Não invente requisitos, intenções do usuário, critérios de aceitação ou informações técnicas ausentes.

**Rule:** Utilize primeiro o contexto disponível. Quando houver uma ambiguidade crítica que não possa ser resolvida com segurança, solicite esclarecimento.

Ambiguidades não críticas não devem bloquear o desenvolvimento quando existir uma alternativa segura, justificada, reversível e compatível com o escopo.

### 3. Do Not Modify Code or Content Beyond the Defined Scope

**Directive:** Não refatore código não relacionado, modifique estruturas arquiteturais ou introduza funcionalidades fora do escopo solicitado.

**Rule:** Mantenha as alterações estritamente direcionadas à solicitação original.

Alterações adicionais necessárias para a implementação correta devem ser justificadas e permanecer dentro do escopo autorizado.

### 4. Never Assume a Task Is Finished Without Double-Checking

**Directive:** Não considere uma tarefa concluída sem revisar os resultados e realizar as validações tecnicamente aplicáveis.

**Rule:** Execute as verificações proporcionais à alteração realizada, incluindo revisão, testes, build ou outras validações pertinentes.

Não declare sucesso quando alguma validação necessária falhar ou não puder ser executada.

A validação deve garantir qualidade, não introduzir burocracia ou aprovações humanas desnecessárias.

---

## 9. Critérios de sucesso

A evolução do XP Workflow deve alcançar os seguintes resultados:

1. O `relay-laya-v4` decide a condução das cinco etapas em todo tipo de task de desenvolvimento, inclusive nas entradas nativas, com ou sem `/xp` e `/goal`.
2. Os Agents executam as responsabilidades delegadas; tools e Skills são selecionadas pelo Laya conforme sua necessidade real e disponibilidade.
3. As transições entre etapas não exigem aprovações humanas desnecessárias.
4. O usuário recebe informações claras sobre as decisões relevantes tomadas.
5. O ciclo de desenvolvimento mantém suas verificações de qualidade, testes e segurança.
6. A execução permanece limitada ao escopo autorizado.
7. O Harness elimina bloqueios artificiais sem comprometer o controle operacional.
8. As decisões e os resultados continuam rastreáveis e observáveis.
9. Os registros distinguem decisões do Laya, recomendações dos Agents, recursos selecionados, chamadas executadas e evidências verificadas pelo Harness.
10. Falhas, decisões inválidas e indisponibilidade do Laya são explícitas e permitem retomada sem substituição silenciosa da autoridade de decisão.
11. A validação da implementação cobre seleção proporcional de recursos, transições, retorno a etapas anteriores, falhas de capacidades e conclusão baseada em evidências, usando respostas controladas do Laya sem depender de APIs reais nos testes automatizados.

## 10. Diretriz final

**O Laya, utilizando o modelo treinado `relay-laya-v4`, decide a condução das cinco etapas do XP Workflow e quais Agents, tools e Skills serão acionados em cada task de desenvolvimento. O Harness executa essa orquestração com controles de permissão, estado e validação.**

Os Agents devem planejar, projetar, testar, implementar e avaliar autonomamente dentro das responsabilidades delegadas pelo Laya e do escopo autorizado, devolvendo evidências para as próximas decisões do modelo.

O usuário deve acompanhar o desenvolvimento por meio de informações objetivas sobre decisões e resultados, intervindo apenas quando sua participação for realmente necessária.

**O objetivo é transformar o XP Workflow de um processo excessivamente dependente de aprovações humanas em um fluxo autônomo, transparente, eficiente e não bloqueante, preservando a qualidade e a segurança do desenvolvimento.**
