---
sidebar_position: 12
title: Testes — Test::Mojo + prove
---

# Testes — Test::Mojo + prove + Devel::Cover

> **Decisão**: Test::Mojo para testes de API HTTP; Test::More para testes unitários;
> `prove` como runner TAP; Devel::Cover para cobertura.
> [ADR-011 — Estratégia de Testes](/adrs/ADR-011-estrategia-de-testes)

---

## Por que Test::Mojo

O Test::Mojo vem embutido no Mojolicious (zero dependência adicional) e testa
rotas HTTP completas **em memória** — as requisições atravessam o dispatcher da
aplicação sem levantar um servidor real. Isso garante testes rápidos e sem portas
em uso, executáveis em qualquer ambiente.

O `prove` é o runner padrão do ecossistema Perl: varre `t/`, executa cada arquivo
`.t` como processo independente e coleta saída TAP — consumível nativamente pelo
GitHub Actions sem plugins.

---

## Estrutura de diretórios

```
t/
├── unit/
│   ├── model/
│   │   ├── ticket.t          ← Stega::Model::Ticket (Moo)
│   │   ├── comment.t
│   │   └── product.t
│   └── service/
│       └── notification.t
├── api/
│   ├── health.t              ← GET /healthz
│   ├── tickets.t             ← CRUD de tickets
│   ├── comments.t
│   ├── products.t
│   └── auth.t                ← rotas protegidas com JWT
└── integration/
    └── worker.t              ← NotificationWorker com RabbitMQ mockado
```

---

## Teste unitário — modelo Moo

```perl
# t/unit/model/ticket.t
use strict;
use warnings;
use Test::More;

use Stega::Model::Ticket;

subtest 'construção com atributos válidos' => sub {
    my $ticket = Stega::Model::Ticket->new(
        id       => 1,
        title    => 'Erro no login',
        priority => 'high',
    );

    is $ticket->id,       1,            'id correto';
    is $ticket->title,    'Erro no login', 'title correto';
    is $ticket->priority, 'high',       'priority correta';
    is $ticket->status,   'open',       'status padrão é open';
    ok $ticket->is_open,               'is_open() retorna verdadeiro';
    ok !$ticket->is_closed,            'is_closed() retorna falso';
};

subtest 'priority inválida lança exceção' => sub {
    eval { Stega::Model::Ticket->new(id => 1, title => 'X', priority => 'urgente') };
    like $@, qr/priority inválida/, 'exceção para priority fora do enum';
};

subtest 'as_json retorna hashref serializável' => sub {
    my $ticket = Stega::Model::Ticket->new(id => 2, title => 'Bug');
    my $json   = $ticket->as_json;

    is ref($json), 'HASH', 'retorna hashref';
    is $json->{id}, 2,     'id no hashref';
    ok exists $json->{status}, 'status presente';
};

done_testing;
```

---

## Teste de API com Test::Mojo

```perl
# t/api/tickets.t
use strict;
use warnings;
use Test::More;
use Test::Mojo;

my $t = Test::Mojo->new('Stega');

# Injetar claims JWT — dispensa Keycloak real nos testes
$t->app->hook(before_dispatch => sub {
    my $c = shift;
    return unless $c->req->url->path =~ m{^/api/v1/};
    if (my ($token) = ($c->req->headers->authorization // '') =~ /^Bearer (.+)/) {
        $c->stash('jwt_claims', {
            sub   => 'test-uuid-agent',
            email => 'agent@stega.local',
            role  => 'agent',
        });
    }
});

# Helper para request autenticada
sub auth_get  { $t->get_ok($_[0],  { Authorization => 'Bearer test' }) }
sub auth_post { $t->post_ok($_[0], { Authorization => 'Bearer test' }, json => $_[1]) }

subtest 'GET /healthz — sem autenticação' => sub {
    $t->get_ok('/healthz')->status_is(200)->json_is('/status', 'ok');
};

subtest 'GET /api/v1/tickets — autenticado retorna 200' => sub {
    auth_get('/api/v1/tickets')->status_is(200)->json_is([], 'lista vazia inicial');
};

subtest 'GET /api/v1/tickets — sem token retorna 401' => sub {
    $t->get_ok('/api/v1/tickets')->status_is(401);
};

subtest 'POST /api/v1/tickets — body inválido retorna 400' => sub {
    auth_post('/api/v1/tickets', { product_id => 1 })   # falta title e body
        ->status_is(400);
};

subtest 'POST /api/v1/tickets — válido cria e retorna 201' => sub {
    auth_post('/api/v1/tickets', {
        product_id => 1,
        title      => 'Falha ao exportar PDF',
        body       => 'O botão de exportação retorna erro 500 ao clicar.',
        priority   => 'high',
    })->status_is(201)
      ->json_has('/id', 'id retornado');
};

done_testing;
```

---

## Teste com mocking de dependência externa

```perl
# t/integration/worker.t
use strict;
use warnings;
use Test::More;
use Test::MockObject;

use Stega::Worker::NotificationWorker;

subtest 'dispatch de ticket.status_changed envia e-mail' => sub {
    my $email_sent;

    # Mock do módulo de envio de e-mail
    my $mock_mailer = Test::MockObject->new;
    $mock_mailer->mock('send', sub { $email_sent = $_[1] });

    # Substituir o mailer real pelo mock
    local *Stega::Worker::NotificationWorker::_send_email = sub {
        $email_sent = shift;
    };

    # Simular processamento de mensagem
    Stega::Worker::NotificationWorker::_dispatch(
        'ticket.status_changed',
        { ticket_id => 42, new_status => 'resolved', actor_id => 'uuid' }
    );

    ok defined $email_sent, 'e-mail foi "enviado"';
    is $email_sent->{ticket_id}, 42, 'ticket_id correto na mensagem';
};

done_testing;
```

---

## Executando os testes

```bash
# Todos os testes (recursivo, com relatório resumido)
carton exec prove -lr t/

# Subdiretório específico
carton exec prove -lr t/api/

# Um arquivo específico com saída verbose
carton exec prove -lv t/api/tickets.t

# Saída verbosa completa (mostra todos os subtest)
carton exec prove -lrv t/

# Em paralelo (reduz tempo de CI)
carton exec prove -lrj4 t/   # 4 processos paralelos
```

---

## Cobertura de código com Devel::Cover

```bash
# Instrumentar e rodar os testes
PERL5OPT="-MDevel::Cover" carton exec prove -lr t/

# Gerar relatório HTML
carton exec cover

# Relatório disponível em: cover_db/coverage.html

# Formato Clover para CI (GitHub Actions, Jenkins)
carton exec cover -report clover

# Ver sumário no terminal
carton exec cover -report text
```

Adicionar ao `.gitignore`:
```
cover_db/
```

---

## Integração com GitHub Actions

```yaml
# .github/workflows/ci.yml (fragmento)
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB:       stega_test
          POSTGRES_USER:     stega_migrate
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - uses: shogo82148/actions-setup-perl@v1
        with:
          perl-version: '5.42'

      - name: Instalar Carton
        run: cpanm --notest Carton

      - name: Instalar dependências
        run: carton install --deployment

      - name: Aplicar migrations
        run: carton exec perl eng/migrate.pl
        env:
          POSTGRESQL_MIGRATION_URL: postgresql://stega_migrate:test@localhost/stega_test

      - name: Rodar testes
        run: carton exec prove -lr t/
        env:
          POSTGRESQL_URL: postgresql://stega_migrate:test@localhost/stega_test

      - name: Gerar cobertura
        run: |
          PERL5OPT="-MDevel::Cover" carton exec prove -lr t/
          carton exec cover -report clover
        env:
          POSTGRESQL_URL: postgresql://stega_migrate:test@localhost/stega_test
```

---

## Convenções de teste do stack

| Convenção | Razão |
|-----------|-------|
| `done_testing` (sem número de testes) | Flexível — não exige atualização ao adicionar subtests |
| `subtest 'descrição' => sub { ... }` | Agrupa testes relacionados com saída TAP hierárquica |
| Um arquivo `.t` por rota ou modelo | Facilita rodar um subconjunto; falhas isoladas não travam tudo |
| Mock de JWT em todos os testes de API | Testes de API não dependem do Keycloak — rodam offline |
| `Test::MockObject` para deps externas | RabbitMQ e e-mail não são chamados em testes de unidade |

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `Test::Mojo->new('Stega')` sem banco | Se o controller acessa `$self->pg` imediatamente no startup, falha sem PostgreSQL | Configure banco de teste ou use `MOJO_MODE=test` para desabilitar conexões no startup |
| Hook `before_dispatch` acumulado | Em múltiplos `subtest`, o hook é adicionado várias vezes — chama o mock múltiplas vezes | Defina o hook uma vez, fora dos `subtest` |
| Testes que dependem de ordem | Banco compartilhado entre testes causa estado residual | Use transações por teste: `begin` no início, `rollback` no fim |
| `prove` sem `-l` | Módulos em `lib/` não são encontrados sem `-l` (adiciona `lib/` ao `@INC`) | Sempre `prove -l` ou `prove -lr` (recursivo) |
| Cobertura de 100% como meta | `Devel::Cover` pode incentivar testes triviais apenas para cobrir linhas | Foque em comportamento: fluxos de erro, edge cases, integrações |
