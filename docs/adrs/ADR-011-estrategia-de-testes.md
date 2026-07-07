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
- **Regras de negócio isoladas em objetos de domínio "Policy"**: lógica de permissão
  e transição de estado não vive dentro de Controllers — vive em classes Perl puras
  (sem `Mojo::Base`, sem `Mojo::Pg`) testáveis com `Test::More` puro, sem banco de
  dados nem `Test::Mojo` (ver "Separando regras de negócio de acesso a dados" abaixo)

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
`use warnings`, ou implicitamente via `use v5.42`) funciona como um primeiro nível de
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
│   ├── domain/
│   │   └── order_policy.t ← testes de MyApp::Domain::OrderPolicy (regras de negócio puras)
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
use v5.42;
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

### Separando regras de negócio de acesso a dados: o padrão Policy

Um problema recorrente em aplicações Mojolicious pequenas é a lógica de permissão e
transição de estado ficar espalhada dentro dos Controllers, misturada a chamadas
`$c->pg->db->query(...)`. O resultado: para testar "um agente só pode alterar o status
de um ticket se for o responsável atual", o único teste possível é de integração —
subir um `Test::Mojo`, um PostgreSQL real, popular dados e fazer requisições HTTP. Isso
funciona, mas é lento, exige banco disponível para rodar qualquer teste de regra de
negócio, e frequentemente duplica a mesma checagem em duas rotas (a rota web e a rota
de API costumam reimplementar a mesma permissão de formas ligeiramente diferentes).

A solução é extrair as decisões de permissão para uma classe de domínio **pura**
(sem `Mojo::Base`, sem `Mojo::Pg`, sem estado de instância) que recebe apenas os dados
necessários para decidir — papel do usuário, dono do recurso, estado atual — e devolve
um booleano. Nenhuma dependência externa, portanto testável com `Test::More` sozinho:

```perl
# lib/MyApp/Domain/OrderPolicy.pm
package MyApp::Domain::OrderPolicy;
use v5.42;
use utf8;

sub can_cancel {
    my ($class, %args) = @_;   # role, owner_id, user_id, status
    return 1 if $args{role} eq 'admin';
    return 0 if ($args{status} // '') eq 'shipped';
    return ($args{owner_id} // '') eq ($args{user_id} // '');
}

1;
```

```perl
# t/unit/domain/order_policy.t — nenhuma conexão de banco, roda em milissegundos
use v5.42;
use utf8;
use Test::More;

use MyApp::Domain::OrderPolicy;

subtest 'admin sempre pode cancelar' => sub {
    ok MyApp::Domain::OrderPolicy->can_cancel(
        role => 'admin', owner_id => 1, user_id => 2, status => 'shipped'
    ), 'admin cancela mesmo não sendo dono e mesmo já enviado';
};

subtest 'dono pode cancelar pedido não enviado' => sub {
    ok MyApp::Domain::OrderPolicy->can_cancel(
        role => 'customer', owner_id => 5, user_id => 5, status => 'pending'
    );
};

subtest 'pedido já enviado não pode ser cancelado por quem não é admin' => sub {
    ok !MyApp::Domain::OrderPolicy->can_cancel(
        role => 'customer', owner_id => 5, user_id => 5, status => 'shipped'
    );
};

done_testing;
```

O Controller passa a **chamar** a policy em vez de reimplementar a regra — a mesma
classe é usada pela rota web e pela rota de API, eliminando a duplicação:

```perl
sub cancel {
    my $c    = shift;
    my $user = $c->stash('current_user');
    my $order = $c->pg->db->query('SELECT * FROM orders WHERE id = ?', $c->param('id'))->hash;

    return $c->render(json => { error => 'Sem permissão' }, status => 403)
        unless MyApp::Domain::OrderPolicy->can_cancel(
            role     => $user->{role},
            owner_id => $order->{owner_id},
            user_id  => $user->{id},
            status   => $order->{status},
        );

    $c->pg->db->query('UPDATE orders SET status = ? WHERE id = ?', 'cancelled', $order->{id});
    $c->render(json => { data => { cancelled => 1 } });
}
```

Esse padrão não substitui os testes de integração de API (`t/api/`) — eles continuam
necessários para validar que a rota HTTP de fato aplica a policy, que o JSON de
resposta está correto e que o banco foi atualizado. O ganho é ter a **matriz completa
de combinações de papel × estado** coberta por testes rápidos e determinísticos em
`t/unit/domain/`, reservando os testes de integração para alguns casos representativos
por rota em vez de reimplementar cada combinação também no nível HTTP.

### Teste de API com Test::Mojo

```perl
# t/api/users.t
use v5.42;
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
use v5.42;
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
# HARNESS_PERL_SWITCHES (não PERL5OPT) escopa o Devel::Cover aos processos de teste
# que o prove dispara — e -ignore,local/ exclui as dependências do Carton da contagem.
# Não use `cover -test`: esse atalho invoca `make test` internamente, e projetos
# Carton/Mojolicious não têm Makefile.
HARNESS_PERL_SWITCHES='-MDevel::Cover=-ignore,local/' carton exec prove -lr t/
carton exec cover -report html       # gera relatório HTML em cover_db/coverage.html
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
FROM perl:5.42-slim AS production

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
        image: postgres:17-alpine
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
          perl-version: '5.42'

      - name: Instalar dependências com Carton
        run: |
          cpanm --notest Carton
          carton install

      - name: Aplicar migrations
        run: carton exec perl eng/migrate.pl
        env:
          POSTGRESQL_APP_URL: postgresql://localhost:5432/myapp_test
          POSTGRESQL_APP_MIGRATION_USERNAME: test
          POSTGRESQL_APP_MIGRATION_PASSWORD: test

      - name: Rodar testes
        run: carton exec prove -lr t/
        env:
          POSTGRESQL_APP_URL: postgresql://localhost:5432/myapp_test
          POSTGRESQL_APP_USERNAME: test
          POSTGRESQL_APP_PASSWORD: test

      - name: Gerar relatório de cobertura
        run: |
          HARNESS_PERL_SWITCHES='-MDevel::Cover=-ignore,local/' carton exec prove -lr t/
          carton exec cover -report clover
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Test::Class** | Estilo xUnit verboso; sem integração nativa com Test::Mojo; mais boilerplate que o estilo funcional do Test::More |
| **Plack::Test** | Testa PSGI apps genéricas; sem acesso à stash do Mojolicious nem integração com Test::Mojo hooks |
| **Apenas testes manuais** | Ausência de testes automatizados impede detecção de regressões — incompatível com CI/CD |
| **Perl::Critic (análise estática)** | Útil como ferramenta complementar, mas substitui apenas a análise de estilo, não os testes de comportamento |
| **Testar regras de negócio apenas via `Test::Mojo` + banco real** | Abordagem inicial da Stega (ADR-018): funciona, mas cada regra de permissão exige banco disponível, é mais lenta e tende a duplicar a mesma checagem em rota web e rota de API. Revisado em favor do padrão Policy (ver acima) para a lógica que não depende de I/O — testes de integração continuam existindo para validar a rota HTTP em si |

## Consequências

**Positivo**:
- Test::Mojo testa rotas HTTP completas em memória — rápido, sem overhead de servidor
- prove produz saída TAP consumível diretamente pelo GitHub Actions
- Testes no estágio Docker impedem que código com falhas chegue à imagem de produção
- Devel::Cover identifica código não testado antes do merge
- Regras de negócio em classes Policy puras rodam em milissegundos, sem banco, e
  cobrem a matriz completa de papel × estado sem inflar os testes de integração

**Negativo**:
- Testes que dependem de PostgreSQL real requerem serviço de banco no CI (configurado
  via `services` no GitHub Actions — ver exemplo acima)
- Test::MockObject requer manutenção manual dos mocks quando as interfaces reais mudam
- O padrão Policy exige disciplina para não deixar regras de negócio "vazarem" de volta
  para dentro dos Controllers à medida que a aplicação cresce — requer revisão de
  código atenta a isso

**Ações necessárias**:
- Criar diretório `t/` com subdiretórios `unit/model/`, `unit/domain/`, `api/`,
  `integration/`
- Adicionar `Test::MockObject` e `Devel::Cover` ao `cpanfile` (seção `on 'test'`)
- Configurar estágio de teste no `Dockerfile`
- Criar workflow `.github/workflows/ci.yml` com serviço PostgreSQL
- Extrair regras de permissão e transição de estado hoje embutidas em Controllers para
  classes `MyApp::Domain::*Policy`, começando pelos fluxos com mais combinações de
  papel × estado (ex.: atribuição e mudança de status de ticket na Stega)
