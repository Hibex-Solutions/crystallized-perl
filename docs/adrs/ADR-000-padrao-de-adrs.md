# ADR-000: Padrão de Registro de Decisões Arquiteturais

**Status**: Aceita  
**Data**: 2026-06-26

## Contexto

O projeto precisa de um mecanismo formal para registrar decisões arquiteturais
significativas, incluindo motivação, alternativas avaliadas e consequências. Sem um
padrão definido, as decisões ficam espalhadas em discussões informais e perdem
rastreabilidade ao longo do tempo.

Como o conteúdo do projeto é em português (pt-BR), as seções dos documentos de decisão
devem também estar em português, garantindo coerência com o restante da documentação.

## Decisão

**Formato de registro**: Architectural Decision Records (ADR)

**Localização**: `docs/adrs/`

**Nomenclatura de arquivos**: `ADR-NNN-nome-textual.md`
- `NNN`: número sequencial com três dígitos, iniciando em `000`
- `nome-textual`: slug em português com hífens, descrevendo a decisão em poucas palavras
- Exemplos: `ADR-000-padrao-de-adrs.md`, `ADR-001-nome-do-projeto.md`

**Seções obrigatórias** (nesta ordem):

| # | Seção | Conteúdo esperado |
|---|-------|-------------------|
| 1 | Título `# ADR-NNN: Título` | Nome da decisão |
| 2 | `**Status**` e `**Data**` | Estado atual e data de aceitação |
| 3 | `## Contexto` | Por que esta decisão precisa ser tomada |
| 4 | `## Decisão` | O que foi decidido |
| 5 | `## Justificativa` | Por que esta opção; deve citar ao menos uma referência de `docs/references/` |
| 6 | `## Alternativas Consideradas` | Tabela com alternativas e motivos de rejeição |
| 7 | `## Consequências` | Resultados positivos e negativos; ações necessárias |

**Valores de Status**:
- `Aceita` — decisão em vigor
- `Substituída por ADR-NNN` — decisão substituída; manter o arquivo para histórico
- `Obsoleta` — decisão não se aplica mais; manter para histórico

**Template**:

```markdown
# ADR-NNN: Título

**Status**: Aceita | Substituída por ADR-NNN | Obsoleta  
**Data**: YYYY-MM-DD

## Contexto
Por que esta decisão precisa ser tomada?

## Decisão
O que foi decidido.

## Justificativa
Por que esta opção sobre as alternativas. Deve citar ao menos uma referência de
`docs/references/`.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| ... | ... |

## Consequências
Resultados positivos e negativos desta decisão.
```

### Arquivos de Referência (`docs/references/`)

Toda ADR deve ter sua `## Justificativa` ancorada em ao menos uma fonte externa
documentada em `docs/references/`. A relação é **bidirecional**:

- A ADR cita a referência na `## Justificativa` com link relativo:
  `[nome-do-arquivo](../references/nome-do-arquivo.md)`
- O arquivo de referência lista de volta a ADR na seção `## Referenciada em`

Essa bidirecionalidade garante rastreabilidade nos dois sentidos: dado uma decisão,
sabe-se em quais fontes ela se apoia; dada uma fonte, sabe-se quais decisões ela
fundamenta.

**Localização**: `docs/references/`

**Nomenclatura de arquivos**: `slug-da-fonte.md` (sem prefixo numérico; o tipo é
indicado pelo metadado `**Tipo**`)

**Template dos arquivos de referência**:

```markdown
# [Título da Fonte](URL)

**Tipo**: Livro | Documentação Oficial | Post | RFC | Palestra | Portal Oficial | Repositório Open Source | Referência da Comunidade | Referência de Metodologia  
**Autor(es)**: Nome  
**Publicado**: AAAA ou AAAA-MM-DD  
**Acessado**: AAAA-MM-DD

## Relevância
Um parágrafo explicando o que esta fonte contribui para a definição do stack.

## Referenciada em
- ADR-NNN: Título da ADR
- Guia: nome-do-guia
```

## Justificativa

- ADRs são o padrão consolidado para documentação de decisões arquiteturais, com amplo
  suporte de ferramentas e familiaridade na comunidade de desenvolvimento de software
- O prefixo `ADR-` no nome do arquivo torna os arquivos auto-descritivos ao serem listados
  em qualquer interface (terminal, GitHub, IDE) — sem precisar abrir o arquivo para
  entender do que se trata
- O diretório `docs/adrs/` (plural) segue a mesma convenção de `docs/references/`,
  mantendo consistência no projeto
- Seções em português garantem coerência com o idioma de todo o conteúdo do projeto
- A numeração a partir de `000` reserva a posição inicial para esta própria ADR de padrão,
  que precede conceitualmente todas as demais

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| Seções em inglês | Inconsistente com o idioma do projeto (pt-BR) |
| Arquivos sem prefixo `ADR-` no nome | Menos auto-descritivos; requerem contexto adicional para identificação |
| Diretório `docs/adr/` (sem 's') | Inconsistente com a convenção plural adotada em `docs/references/` |
| Numeração a partir de `001` | ADR-000 como padrão é semântico — o padrão precede e fundamenta todas as demais ADRs |

## Consequências

- **Positivo**: Todas as decisões seguem o mesmo formato, facilitando leitura e manutenção
- **Positivo**: O prefixo `ADR-` no nome do arquivo torna a listagem do diretório imediatamente legível
- **Positivo**: Esta própria ADR (ADR-000) serve como exemplo vivo do padrão que define
- **Negativo**: Mudanças futuras neste padrão exigem atualizar todas as ADRs existentes
