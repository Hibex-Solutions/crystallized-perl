# ADR-005: Gerenciamento de Dependências — Carton + cpanm

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Aplicações Perl dependem de módulos do CPAN. Sem uma ferramenta de gerenciamento, a
instalação de módulos ocorre globalmente no sistema (ou no ambiente Perl compartilhado),
não é reprodutível entre máquinas e é propensa a conflitos entre projetos. Em ambientes
de container e Kubernetes, a reprodutibilidade entre o estágio de build e o de execução
não é opcional: a mesma versão de cada módulo deve estar presente em todos os ambientes,
do laptop do desenvolvedor à imagem de produção.

O fator II da metodologia 12-factor exige que as dependências sejam declaradas
explicitamente e isoladas — nunca assumindo que um módulo está disponível no ambiente
de execução.

## Decisão

**Carton** como gerenciador de dependências do projeto, com **cpanm** (App::cpanminus)
como motor de instalação.

- As dependências do projeto são declaradas no arquivo `cpanfile` na raiz do repositório.
- O arquivo `cpanfile.snapshot` (gerado pelo Carton) é versionado no Git junto com o
  código — ele congela as versões exatas de todos os módulos, incluindo dependências
  transitivas.
- A pasta `local/` (onde os módulos são instalados) é excluída do Git via `.gitignore`.
- A aplicação e os scripts são sempre executados com o prefixo `carton exec`.

## Justificativa

O Carton funciona como o Bundler (Ruby) ou npm (Node.js): declara, isola e congela
dependências do projeto sem tocar no Perl do sistema. O `cpanfile.snapshot` é o
mecanismo de reprodutibilidade — uma imagem Docker construída hoje a partir do mesmo
snapshot produzirá um ambiente bit-a-bit idêntico ao construído há seis meses.

O `cpanm` (App::cpanminus) substitui o cliente `cpan` original, que é considerado
legado no Modern Perl: `cpanm` é significativamente mais rápido, silencioso por padrão
e não exige configuração inicial. O Carton o usa internamente.

Em imagens Docker, a estratégia de multi-stage build usa o Carton no estágio de
construção (onde compiladores C estão presentes para módulos XS como `DBD::Pg`) e
copia apenas a pasta `local/` resultante para a imagem final, mantendo-a limpa e sem
ferramentas de build.

Referências: [Carton](../references/carton.md),
[CPAN](../references/cpan.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

### Estrutura do `cpanfile`

```perl
# Versão mínima do Perl
requires 'perl', '5.042';

# Dependências de produção
requires 'Mojolicious',                 '9.0';
requires 'Mojolicious::Plugin::OpenAPI';        # contrato de API (ADR-015)
requires 'Moo',                         '2.0';
requires 'namespace::clean';                    # limpa importações do escopo público (ADR-006)
requires 'Mojo::Pg',                    '4.0';
requires 'Crypt::JWT';
requires 'Mojo::RabbitMQ::Client';             # publicação não-bloqueante (ADR-008)
requires 'Net::AMQP::RabbitMQ';                # consumo em worker síncrono (ADR-008)

# Dependências de desenvolvimento e teste (não vão na imagem de produção)
on 'test' => sub {
    requires 'Test::More';
    requires 'Test::MockObject';
    requires 'Devel::Cover';
};
```

### Ciclo de uso

```bash
# Instalar e gerar/atualizar o snapshot
carton install

# Adicionar dependência nova e atualizar snapshot
echo "requires 'Some::Module';" >> cpanfile
carton install

# Rodar a aplicação usando os módulos do Carton
carton exec perl script/my_app.pl daemon

# Rodar em produção com Hypnotoad
carton exec hypnotoad script/my_app.pl

# Rodar testes
carton exec prove -lr t/
```

### Uso no Docker (multi-stage build)

```dockerfile
# ── Estágio de build ─────────────────────────────────────────────────────────
FROM perl:5.42 AS build

WORKDIR /app

# cpanm instala o próprio Carton globalmente neste estágio
RUN cpanm --notest Carton

# Copiar apenas os arquivos de dependência primeiro (cache de layer)
COPY cpanfile cpanfile.snapshot ./

# Instalar dependências de produção em local/ usando o snapshot
RUN carton install --deployment

# ── Estágio de produção ───────────────────────────────────────────────────────
FROM perl:5.42-slim AS production

WORKDIR /app

# Copiar apenas o diretório de módulos instalados
COPY --from=build /app/local ./local

# Copiar o código da aplicação
COPY . .

CMD ["carton", "exec", "hypnotoad", "-f", "script/my_app.pl"]
```

A flag `--deployment` no `carton install` usa exclusivamente o `cpanfile.snapshot`,
recusando instalar versões diferentes das fixadas — o que garante que a imagem de
produção seja exatamente o que foi testado.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| `cpan` (comando legado) | Sem snapshot, instalação global, interativo, lento — considerado legado no Modern Perl |
| `cpanm` standalone (sem Carton) | Instala módulos mas não gera snapshot; sem reprodutibilidade garantida entre ambientes |
| `local::lib` sem Carton | Isola módulos mas sem gestão de snapshot; compatível com Carton (usado internamente) |
| `Dist::Zilla` | Voltado para autores de módulos CPAN (distribuição), não para gerenciamento de dependências de aplicações |

## Consequências

**Positivo**:
- Reprodutibilidade total: mesmas versões em dev, CI e produção
- Isolamento: módulos em `local/`, sem afetar o Perl do sistema
- Multi-stage Docker builds são limpos e seguros
- `cpanfile` é legível, versionável e auditável

**Negativo**:
- `carton exec` deve prefixar todos os comandos de execução — esquecê-lo causa erros
  difíceis de diagnosticar (módulo não encontrado)
- O `cpanfile.snapshot` pode ficar desatualizado se um desenvolvedor instalar módulos
  diretamente com `cpanm` sem passar pelo Carton

**Ações necessárias**:
- Adicionar `local/` ao `.gitignore`
- Incluir `cpanfile` e `cpanfile.snapshot` no controle de versão
- Configurar o pipeline de CI para rodar `carton install --deployment` antes dos testes
