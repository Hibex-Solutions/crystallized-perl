# ADR-007: Banco de Dados Relacional — PostgreSQL

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

O stack precisa de um banco de dados relacional para persistência de dados estruturados.
Além dos dados relacionais clássicos, a mesma instância de banco deve suportar dados
semi-estruturados (documentos JSON flexíveis) sem exigir um segundo serviço de banco
de dados — princípio de redução de backing services que simplifica operações em
ambientes Kubernetes.

## Decisão

**PostgreSQL** como único banco de dados do stack, servindo tanto dados relacionais
(via SQL clássico) quanto dados de documento (via tipo nativo `JSONB`).

## Justificativa

O PostgreSQL é o banco de dados open source mais avançado disponível. Para o contexto
do stack, três características são determinantes:

**1. JSONB nativo com indexação e operadores de query**  
O tipo `JSONB` do PostgreSQL armazena documentos JSON em formato binário indexável.
Com índices GIN é possível executar queries eficientes sobre campos de documentos
heterogêneos — eliminando a necessidade do MongoDB como serviço separado na
infraestrutura (ver ADR-017).

**2. Conformidade ACID e tipos de dados robustos**  
Tipos como `TIMESTAMPTZ`, `UUID`, `INET`, arrays e enums reduzem a lógica de validação
na aplicação. Transações ACID garantem consistência mesmo em operações complexas que
envolvem múltiplas tabelas e colunas JSONB simultaneamente.

**3. Ecossistema Perl de primeira classe**  
O `DBD::Pg` (driver DBI para PostgreSQL) é mantido ativamente e suporta todas as
funcionalidades do PostgreSQL moderno. O `Mojo::Pg` (camada async sobre DBD::Pg)
integra naturalmente com o event loop do Mojolicious (ver ADR-016).

Referências: [PostgreSQL](../references/postgresql.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

### Configuração via variável de ambiente

Conforme o fator III do 12-factor (configuração no ambiente), a conexão ao PostgreSQL
é sempre passada via variável de ambiente, nunca hardcoded:

```bash
# Formato de URL (preferido — uma única variável)
POSTGRESQL_URL=postgresql://user:password@host:5432/database

# Ou variáveis separadas (alternativa)
PGHOST=localhost
PGPORT=5432
PGDATABASE=myapp
PGUSER=myapp_user
PGPASSWORD=secret
```

### Docker Compose para desenvolvimento

O serviço PostgreSQL no Docker Compose define o usuário administrador inicial.
Em desenvolvimento, esse usuário único é usado para simplificar a configuração local.
Em produção, dois usuários com privilégios distintos são provisionados:
`myapp_migrate` (DDL) e `myapp_app` (DML) — ver ADR-016 para os comandos GRANT
e a separação de credenciais.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB:       myapp
      POSTGRES_USER:     myapp_user
      POSTGRES_PASSWORD: dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myapp_user -d myapp"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
```

### Versão mínima

PostgreSQL 14 ou superior — versão mínima que suporta todos os operadores JSONB,
`GENERATED ALWAYS AS` e melhorias de performance no planner usados nos guias.
Recomendado: PostgreSQL 16 (imagem `postgres:16-alpine` para containers leves).

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **MySQL / MariaDB** | Suporte a JSON menos robusto (sem GIN indexes em JSON, tipagem menos rigorosa); `STRICT_MODE` requer configuração extra; menor fidelidade de tipos |
| **SQLite** | Sem suporte a concorrência adequada para produção distribuída; sem JSONB; não adequado para múltiplos workers simultâneos |
| **CockroachDB** | Compatível com protocolo PostgreSQL mas adiciona complexidade operacional significativa de cluster distribuído desnecessária para o escopo |
| **MongoDB** | Serviço separado a gerenciar; licença SSPL (versões 4+) restritiva para uso em SaaS; o PostgreSQL JSONB cobre o caso de uso de documentos sem novo serviço |

## Consequências

**Positivo**:
- Um único serviço de banco de dados cobre dados relacionais e documentais
- Backups, monitoramento e operações de manutenção consolidados em um único sistema
- JSONB + GIN indexes cobrem casos de uso de documento sem MongoDB
- Ecossistema Perl (DBD::Pg, Mojo::Pg) maduro e mantido

**Negativo**:
- Módulo `DBD::Pg` tem dependências XS (requer `libpq` e compilador C no estágio de
  build Docker) — obrigatório o multi-stage build
- Administração de PostgreSQL requer conhecimento específico (vacuum, explain analyze,
  configuração de memória)

**Ações necessárias**:
- Definir cliente de acesso async (Mojo::Pg — ADR-016)
- Definir estratégia para dados de documento (PostgreSQL JSONB — ADR-017)
- Incluir `healthcheck` no serviço postgres do Docker Compose
- Declarar `DBD::Pg` no `cpanfile` como dependência de produção
