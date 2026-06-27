# Security Policy

## Versões Suportadas

Apenas a versão atual da documentação (branch `main`) recebe correções de segurança.
Versões anteriores não são mantidas.

| Versão | Suportada |
|--------|-----------|
| main   | ✓         |

## Reportando uma Vulnerabilidade

Este é um projeto de documentação — ele não distribui software executável.
Contudo, o repositório pode conter configurações de CI/CD, scripts de build e
exemplos de código que, se mal configurados, representam risco.

### Como reportar

Prefira o canal privado do GitHub:

1. Acesse a aba **Security** do repositório
2. Clique em **Report a vulnerability**
3. Descreva o problema com o máximo de detalhes possível

Alternativamente, envie um e-mail para **opensource@hibex.co** com o assunto
`[SECURITY] crystallized-perl — <descrição curta>`.

**Não abra uma issue pública para vulnerabilidades de segurança.**

### O que esperar

- Confirmação de recebimento em até **5 dias úteis**
- Avaliação do impacto e plano de resposta em até **15 dias úteis**
- Crédito público ao pesquisador (se desejado) após a correção

## Escopo

São consideradas vulnerabilidades neste projeto:

- Configurações de CI/CD que exponham segredos ou permitam execução de código arbitrário
- Exemplos de código Perl que demonstrem práticas inseguras sem aviso explícito
- Links para fontes externas comprometidas ou substituídas por conteúdo malicioso

Fora do escopo: erros tipográficos, imprecisões técnicas na documentação, e escolhas
de design que não representem risco de segurança.
