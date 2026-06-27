# ADR-011: Estratégia de Testes

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

O stack precisa de uma estratégia de testes que cubra: testes unitários de lógica de
domínio, testes de integração de API HTTP, mocking de dependências externas (Keycloak,
RabbitMQ) e métricas de cobertura de código. A estratégia deve ser integrável ao
pipeline de CI (GitHub Actions) e ao processo de build Docker — falhas de teste devem
impedir a geração da imagem de produção.

## Decisão

- **Framework de testes de API**: Test::Mojo (embutido no Mojolicious)
- **Framework de testes unitários**: Test::More (core do Perl)
- **Runner**: `prove` via `carton exec`
- **Mocking**: Test::MockObject para dependências externas
- **Cobertura**: Devel::Cover
- **Protocolo de saída**: TAP (Test Anything Protocol — padrão do Perl)
- **Localização**: diretório `t/` na raiz do projeto, arquivos com extensão `.t`

## Justificativa

**Test::Mojo** é parte do ecossistema Mojolicious (sem dependência adicional) e provê
uma API fluente para testar rotas HTTP sem subir um servidor real — as requisições
atravessam o dispatcher do Mojolicious em memória. Isso inclui suporte a WebSocket e
operações assíncronas.

**prove** é o runner padrão do ecossistema Perl: varre o diretório `t/`, executa cada
arquivo `.t` como processo independente, coleta saída TAP e reporta resultados. O TAP
é legível por GitHub Actions, Jenkins e outros sistemas de CI sem plugin adicional.

**Devel::Cover** instrumenta a execução dos testes e gera relatórios de cobertura
(statement, branch, condition, subroutine) em HTML. A integração com o pipeline de CI
permite bloquear implantações abaixo de um limiar de cobertura configurável.

O princípio de análise estática em tempo de compilação do Perl (`use strict`,
`use warnings`, ou implicitamente via `use v5.38`) funciona como um primeiro nível de
"teste" antes dos testes formais rodarem.

Referências: [Mojolicious](../references/mojolicious.md),
[Devel::Cover](../references/devel-cover.md),
[Perldoc: Tutoriais](../references/perldoc-tutorials.md)

### Estrutura do diretório `t/`

```
t/
├── unit/
│   ├── model/
│   │   └── user.t         ← testes de MyApp::Model::User (Moo)
│   └── service/
│       └── order.t
├── api/
│   ├── health.t            ← GET /healthz
│   ├── users.t             ← CRUD de usuários
│   └── auth.t              ← rotas protegidas com JWT
└── integration/
    └── worker.t            ← worker + RabbitMQ (mock)
```

### Teste de unidade (modelo Moo)

```perl
# t/unit/model/user.t
use strict;
use warnings;
use Test::More;

use MyApp::Model::User;

subtest 'construção válida' => sub {
    my $user = MyApp::Model::User->new(
        id    => 1,
        name  => 'Alice',
        email => 'alice@example.com',
    );

    is $user->id,    1,                    'id correto';
    is $user->name,  'Alice',              'name correto';
    is $user->email, 'alice@example.com',  'email correto';
};

subtest 'as_json retorna hashref correto' => sub {
    my $user = MyApp::Model::User->new(
        id => 2, name => 'Bob', email => 'bob@example.com'
    );

    my $json = $user->as_json;
    is ref($json), 'HASH', 'retorna hashref';
    is $json->{id}, 2,     'id no json';
};

subtest 'email inválido lança exceção' => sub {
    eval { MyApp::Model::User->new(id => 1, name => 'X', email => 'invalido') };
    like $@, qr/Email inválido/, 'lança exceção para email sem @';
};

done_testing;
```

### Teste de API com Test::Mojo

```perl
# t/api/users.t
use strict;
use warnings;
use Test::More;
use Test::Mojo;

# Criar instância da aplicação em modo test (sem servidor real)
my $t = Test::Mojo->new('MyApp');

subtest 'GET /healthz retorna 200' => sub {
    $t->get_ok('/healthz')
      ->status_is(200)
      ->json_is('/status', 'ok');
};

subtest 'GET /api/v1/users sem token retorna 401' => sub {
    $t->get_ok('/api/v1/users')
      ->status_is(401);
};

subtest 'GET /api/v1/users com token válido retorna lista' => sub {
    # Injetar token JWT de teste na stash (mock da validação)
    $t->app->hook(before_dispatch => sub {
        my $c = shift;
        $c->stash('jwt_claims', { sub => 'test-user', email => 't@t.com' })
            if $c->req->headers->authorization;
    });

    $t->get_ok('/api/v1/users', { Authorization => 'Bearer test-token' })
      ->status_is(200);

    ok ref($t->tx->res->json) eq 'ARRAY', 'resposta é um array JSON';
};

subtest 'POST /api/v1/users com body inválido retorna 400' => sub {
    $t->post_ok('/api/v1/users',
        json => { name => 'Sem email' }   # campo 'email' ausente
    )->status_is(400);    # validação automática pelo plugin OpenAPI
};

done_testing;
```

### Teste com mocking de dependência externa

```perl
# t/unit/service/order.t
use strict;
use warnings;
use Test::More;
use Test::MockObject;

use MyApp::Service::OrderProcessor;

subtest 'processar pedido chama pg e publica no rabbitmq' => sub {
    my $mock_db = Test::MockObject->new;
    $mock_db->mock('query', sub { bless { id => 99 }, 'MockResult' });

    my $mock_mq = Test::MockObject->new;
    my $published;
    $mock_mq->mock('publish', sub { $published = $_[1] });

    my $processor = MyApp::Service::OrderProcessor->new(
        db => $mock_db,
        mq => $mock_mq,
    );

    $processor->process({ order_id => 1, user_id => 42 });

    ok defined $published, 'publicou mensagem no broker';
    is $published->{order_id}, 1, 'order_id correto na mensagem';
};

done_testing;
```

### Executando os testes

```bash
# Todos os testes (recursivo)
carton exec prove -lr t/

# Apenas um subdiretório
carton exec prove -lr t/api/

# Com saída verbose (útil para debug)
carton exec prove -lrv t/unit/

# Com relatório de cobertura
PERL5OPT="-MDevel::Cover" carton exec prove -lr t/
carton exec cover                    # gera relatório HTML em cover_db/coverage.html
carton exec cover -report clover     # formato Clover para CI
```

### Integração no Dockerfile (build bloqueado por testes)

```dockerfile
# ── Estágio de teste ────────────────────────────────────────────────────────
FROM build AS test

# Instalar dependências de teste (incluídas no cpanfile sob 'on test => ...')
RUN carton install

# Rodar testes — falha aqui impede a geração da imagem de produção
RUN carton exec prove -lr t/

# ── Estágio de produção (só alcançado se os testes passarem) ──────────────
FROM perl:5.38-slim AS production

# COPY --from=test cria dependência explícita no estágio de teste:
# Docker só constrói esta imagem se o estágio test concluir com sucesso.
COPY --from=test /app/local ./local
COPY . .
CMD ["carton", "exec", "hypnotoad", "-f", "script/my_app.pl"]
```

### Pipeline GitHub Actions

```yaml
# .github/workflows/ci.yml (fragmento relevante para testes)
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: myapp_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 5s

    steps:
      - uses: actions/checkout@v4

      - name: Instalar Perl
        uses: shogo82148/actions-setup-perl@v1
        with:
          perl-version: '5.38'

      - name: Instalar dependências com Carton
        run: |
          cpanm Carton
          carton install

      - name: Aplicar migrations
        run: carton exec perl eng/migrate.pl
        env:
          POSTGRESQL_MIGRATION_URL: postgresql://test:test@localhost/myapp_test

      - name: Rodar testes
        run: carton exec prove -lr t/
        env:
          POSTGRESQL_URL: postgresql://test:test@localhost/myapp_test

      - name: Gerar relatório de cobertura
        run: |
          PERL5OPT="-MDevel::Cover" carton exec prove -lr t/
          carton exec cover -report clover
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Test::Class** | Estilo xUnit verboso; sem integração nativa com Test::Mojo; mais boilerplate que o estilo funcional do Test::More |
| **Plack::Test** | Testa PSGI apps genéricas; sem acesso à stash do Mojolicious nem integração com Test::Mojo hooks |
| **Apenas testes manuais** | Ausência de testes automatizados impede detecção de regressões — incompatível com CI/CD |
| **Perl::Critic (análise estática)** | Útil como ferramenta complementar, mas substitui apenas a análise de estilo, não os testes de comportamento |

## Consequências

**Positivo**:
- Test::Mojo testa rotas HTTP completas em memória — rápido, sem overhead de servidor
- prove produz saída TAP consumível diretamente pelo GitHub Actions
- Testes no estágio Docker impedem que código com falhas chegue à imagem de produção
- Devel::Cover identifica código não testado antes do merge

**Negativo**:
- Testes que dependem de PostgreSQL real requerem serviço de banco no CI (configurado
  via `services` no GitHub Actions — ver exemplo acima)
- Test::MockObject requer manutenção manual dos mocks quando as interfaces reais mudam

**Ações necessárias**:
- Criar diretório `t/` com subdiretórios `unit/`, `api/`, `integration/`
- Adicionar `Test::MockObject` e `Devel::Cover` ao `cpanfile` (seção `on 'test'`)
- Configurar estágio de teste no `Dockerfile`
- Criar workflow `.github/workflows/ci.yml` com serviço PostgreSQL
