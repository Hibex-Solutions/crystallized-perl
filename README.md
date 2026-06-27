<div align="center">
  <a href="https://hibex-solutions.github.io/crystallized-perl">
    <img src="assets/images/banner.png" alt="Crystallized Perl" width="100%" />
  </a>
</div>

# Crystallized Perl

Stack completo e opinativo para serviços de internet modernos em Perl.

[![CI](https://github.com/Hibex-Solutions/crystallized-perl/actions/workflows/ci.yml/badge.svg)](https://github.com/Hibex-Solutions/crystallized-perl/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-online-informational)](https://hibex-solutions.github.io/crystallized-perl)

---

> Um stack completo e opinativo para construir serviços de internet modernos em Perl —
> aplicações web, APIs HTTP e workers em background — fundamentado em referências reais
> e decisões arquiteturais documentadas.

---

## What This Stack Covers

- Aplicações web com HTML server-rendered e SPAs com backend Perl
- APIs HTTP: REST, GraphQL e WebSocket
- Workers em background e filas de jobs (processamento assíncrono)
- Autenticação, autorização e gerenciamento de sessões
- Observabilidade: logging, métricas e rastreamento distribuído
- Containerização com Docker e deploy cloud-native (Kubernetes ou equivalentes)
- Pipelines de CI/CD automatizados
- Estratégia de testes: unitários, integração e end-to-end
- Ferramental de desenvolvimento e ambiente local com Docker Compose

## What This Stack Does NOT Cover

- Sistemas operacionais, módulos de kernel ou drivers de dispositivo
- Engines de jogos ou gráficos em tempo real
- Ciência de dados, aprendizado de máquina ou pipelines de dados
- Desenvolvimento genérico de frameworks ou bibliotecas Perl
- ETL batch ou data warehousing
- Aplicações desktop ou GUI

## Foundations

Cada escolha tecnológica deste stack rastreia ao menos uma fonte autoritativa
externa, documentada em [`docs/references/`](docs/references/).
Nenhuma decisão é justificada por "senso comum" — cada uma tem uma ADR.

| Referência | Tipo | Relevância para o stack |
|------------|------|------------------------|
| [perl.org](docs/references/perl-org.md) | Portal Oficial | Documentação e ecossistema oficial da linguagem |
| [Modern Perl](docs/references/modern-perl-book.md) | Livro | Idiomas e boas práticas Perl contemporâneos |
| [The Twelve-Factor App](docs/references/twelve-factor-app.md) | Metodologia | Princípios guia para aplicações cloud-native |
| [Docker](docs/references/docker.md) | Documentação Oficial | Containerização — base da infraestrutura do stack |
| [Mojolicious](docs/references/mojolicious.md) | Documentação Oficial | Framework web Perl moderno (candidato ao stack) |
| [Kubernetes](docs/references/kubernetes.md) | Documentação Oficial | Orquestração de containers (candidato ao stack) |

Ver [`docs/references/`](docs/references/) para as 28 fontes completas.

## Technology Stack

| Camada | Tecnologia | ADR |
|--------|-----------|-----|
| Linguagem | Perl 5.38+ | — |
| Framework web | A definir | ADR pendente |
| ORM / Acesso a BD | A definir | ADR pendente |
| Template engine | A definir | ADR pendente |
| Fila de jobs | A definir | ADR pendente |
| HTTP client | A definir | ADR pendente |
| Testes | A definir | ADR pendente |
| Containerização | Docker | [ADR-001](docs/adrs/ADR-001-nome-do-projeto.md) |
| Orquestração | A definir | ADR pendente |
| CI/CD | GitHub Actions | — |
| Site de docs | Docusaurus | — |

Decisões de stack são registradas como ADRs em [`docs/adrs/`](docs/adrs/).
Cada entrada "A definir" será substituída por um link para a ADR correspondente
quando a decisão for tomada e documentada.

## Documentation

O site completo da documentação está em:

**[hibex-solutions.github.io/crystallized-perl](https://hibex-solutions.github.io/crystallized-perl)**

Estrutura da documentação neste repositório:

| Diretório | Conteúdo |
|-----------|---------|
| [`docs/adrs/`](docs/adrs/) | Architectural Decision Records — cada decisão significativa tem uma ADR |
| [`docs/references/`](docs/references/) | 28 fontes externas anotadas que fundamentam as decisões |
| `docs/guides/` | Tutoriais passo a passo (em desenvolvimento) |
| `docs/stack/` | Referência por camada tecnológica (em desenvolvimento) |

## Contributing

Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir um pull request.

Em especial:
- Erros de conteúdo → use o template **Content Correction**
- Novos guias → abra uma issue antes de escrever
- Nova ADR → leia [ADR-000](docs/adrs/ADR-000-padrao-de-adrs.md) primeiro
- Contestar ADR existente → abra uma issue com evidência e proposta de substituição

Ao contribuir, você concorda em seguir nosso [Código de Conduta](CODE_OF_CONDUCT.md).

## License

MIT © 2026 [Hibex Solutions](https://github.com/Hibex-Solutions)

Ver [LICENSE](LICENSE) para o texto completo.
