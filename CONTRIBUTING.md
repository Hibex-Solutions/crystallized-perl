# Contribuindo com o Crystallized Perl

Obrigado pelo interesse em contribuir! Este documento explica como participar
do projeto de forma efetiva.

## Tipos de Contribuição

### Reportar um erro de conteúdo

Encontrou informação incorreta, desatualizada ou um link quebrado?

1. Abra uma issue usando o template **Content Correction**
2. Descreva o erro, a localização exata (arquivo + seção) e a correção sugerida
3. Se possível, inclua a fonte que justifica a correção

### Propor um novo guia

Guias ficam em `docs/guides/`. Cada guia é um tutorial autocontido.

Antes de escrever:

1. Abra uma issue usando o template **Feature Request** descrevendo o guia proposto
2. Confirme que o tema está dentro do [escopo do projeto](README.md#o-que-este-stack-cobre)
3. Liste quais ADRs existentes fundamentam as escolhas tecnológicas do guia

Requisitos que todo guia deve cumprir:

- Pré-requisitos listados no topo
- Versões exatas de todas as ferramentas (sem ranges como `>=1.0`)
- Seção "O que você vai construir" com um resultado concreto
- Link para ao menos uma ADR que justifique uma escolha tecnológica
- Seção "Próximos passos" ao final

### Propor uma nova ADR

ADRs ficam em `docs/adrs/` e seguem o padrão definido em
[ADR-000](docs/adrs/ADR-000-padrao-de-adrs.md). Leia ADR-000 integralmente antes
de escrever qualquer ADR.

Para propor uma nova decisão arquitetural:

1. Abra uma issue descrevendo a decisão e as alternativas que você considerou
2. Aguarde discussão — decisões arquiteturais afetam todo o stack
3. Se houver consenso, abra um PR com a ADR seguindo o template de ADR-000
4. Inclua ao menos um arquivo de referência em `docs/references/` que suporte a decisão

### Contestar uma ADR existente

Se você acredita que uma decisão existente está errada ou desatualizada:

1. Abra uma issue descrevendo o problema com evidência (fontes externas)
2. Proposta de substituição: nova ADR com `Status: Substituída por ADR-NNN`
3. Não edite ADRs aceitas diretamente — o histórico de decisões deve ser preservado

## Processo de Pull Request

1. Faça um fork do repositório e crie um branch descritivo:
   `feat/guia-autenticacao`, `fix/correcao-adr-002`, `docs/nova-referencia-xyz`

2. Antes de abrir o PR, certifique-se de que o site de documentação constrói
   sem erros:
   ```sh
   npm install
   npm run build
   ```

3. Abra o PR usando o template disponível. PRs sem template preenchido podem
   ser fechados sem revisão.

4. Todo PR deve:
   - Construir o site sem erros (`npm run build` passa)
   - Ter título claro em português descrevendo a mudança
   - Referenciar a issue relacionada (se houver)

## Idioma

Todo o conteúdo de documentação é em **português (pt-BR)**.

- Nomes de arquivos e slugs: em português com hífens (`guia-autenticacao.md`)
- Código Perl nos exemplos: comentários em português
- Mensagens de commit: em português
- Issues e PRs: em português

A exceção são os arquivos de configuração técnica (GitHub Actions YAML,
`package.json`, etc.), que permanecem em inglês por convenção.

## Estilo de Escrita

- Escreva para um desenvolvedor sênior avaliando o stack — sem jargão de marketing
- Afirmações técnicas devem ter fonte: cite a referência em `docs/references/`
- Versões de ferramentas sempre fixadas (não use "última versão" ou ranges)
- Evite "fácil", "simples", "rápido" sem benchmarks que os sustentem

## Dúvidas

Abra uma issue com o label `question`. Não use issues para suporte a problemas
de configuração do seu ambiente local.
