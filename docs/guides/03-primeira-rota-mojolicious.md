---
sidebar_position: 3
title: "Guia 3 — Primeira Rota com Mojolicious"
---

# Guia 3 — Primeira Rota com Mojolicious

> **Referência arquitetural**:
> [ADR-004 — Framework Web Mojolicious](/adrs/ADR-004-framework-web-mojolicious)

---

## O que você vai construir

Ao final deste guia você terá:

- `lib/Stega.pm` — a classe principal da aplicação
- `script/stega` — o ponto de entrada Mojolicious
- `lib/Stega/Controller/Health.pm` — controller do endpoint de saúde
- `GET /healthz` respondendo `{"status":"ok"}` — padrão para probes do Kubernetes
- `GET /api/v1/tickets` respondendo uma lista vazia (estrutura da API da Stega)
- Um teste automatizado cobrindo as duas rotas

---

## Pré-requisitos

- [Guia 1](/guides/ambiente-de-desenvolvimento) e [Guia 2](/guides/estrutura-minima-de-projeto) concluídos
- Estrutura de diretórios criada (`lib/`, `script/`, `t/`)
- `carton install` executado com sucesso

---

## Como o Mojolicious organiza uma aplicação

Uma aplicação Mojolicious segue esta hierarquia:

```
Stega.pm                  ← classe principal (herda Mojolicious)
  └─ startup()            ← ponto central de configuração
       ├─ plugins         ← OpenAPI, autenticação, helpers
       ├─ routes          ← mapa de URL → controller#ação
       └─ hooks           ← before_dispatch, after_render, etc.

Stega::Controller::*      ← um módulo por grupo de rotas
  └─ ação()               ← método chamado pela rota

script/stega              ← ponto de entrada (thin wrapper)
```

Controllers **não usam Moo** — herdam de `Mojolicious::Controller` via
`Mojo::Base`. Modelos de domínio (próximos guias) usam `Moo`.
Veja [ADR-006](/adrs/ADR-006-sistema-de-oo-moo) e
[ADR-004](/adrs/ADR-004-framework-web-mojolicious).

---

## Passo 1 — Classe principal: lib/Stega.pm

```perl
# lib/Stega.pm
package Stega;
use Mojo::Base 'Mojolicious';

sub startup {
    my $self = shift;

    # Carrega configuração do arquivo stega.conf (se existir)
    my $config = $self->plugin('Config', { default => {} });

    my $r = $self->routes;

    # Endpoint de saúde — sem autenticação (ADR-010: Kubernetes probes)
    $r->get('/healthz')->to('health#check');

    # Prefixo da API versionada
    my $api = $r->under('/api/v1');
    $api->get('/tickets')->to('ticket#list');
}

1;
```

**Por que `startup` em vez de um construtor?** O Mojolicious chama `startup()`
após inicializar seu próprio estado interno. Configurar rotas e plugins em `new()`
causa erros difíceis de diagnosticar.

---

## Passo 2 — Script de entrada: script/stega

```perl
#!/usr/bin/env perl
# script/stega
use Mojo::Base -strict;

use lib 'lib';
use Stega;

Stega->new->start;
```

Torne o script executável:

```bash
chmod +x script/stega
```

O método `start` do Mojolicious detecta automaticamente o comando passado na
linha de comando (`daemon`, `hypnotoad`, `minion`, `routes`, etc.).

---

## Passo 3 — Controller de saúde: lib/Stega/Controller/Health.pm

```perl
# lib/Stega/Controller/Health.pm
package Stega::Controller::Health;
use Mojo::Base 'Mojolicious::Controller';

sub check {
    my $self = shift;
    $self->render(json => { status => 'ok' });
}

1;
```

A convenção de nomenclatura Mojolicious mapeia `'health#check'` para:
- Módulo: `Stega::Controller::Health`
- Método: `check`

---

## Passo 4 — Controller de tickets: lib/Stega/Controller/Ticket.pm

```perl
# lib/Stega/Controller/Ticket.pm
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';

sub list {
    my $self = shift;

    # Por ora retorna lista vazia — banco e modelos serão adicionados nos
    # próximos guias (ADR-016, ADR-006)
    $self->render(json => []);
}

1;
```

---

## Passo 5 — Rodar a aplicação em modo de desenvolvimento

```bash
carton exec perl script/stega daemon --listen http://*:3000
```

O servidor de desenvolvimento (`daemon`) tem recarga automática de código — alterações
nos arquivos `.pm` são detectadas sem reinicialização.

Saída esperada:

```
[2026-06-28 10:00:00.00000] [32301] [info] Listening at "http://*:3000"
Server available at http://127.0.0.1:3000
```

Verifique as rotas registradas:

```bash
carton exec perl script/stega routes
```

```
/healthz    GET  health#check
/api/v1/tickets  GET  ticket#list
```

Teste manualmente:

```bash
curl -s http://localhost:3000/healthz
# {"status":"ok"}

curl -s http://localhost:3000/api/v1/tickets
# []
```

---

## Passo 6 — Escrever os primeiros testes

Os arquivos de teste usam prefixo numérico para garantir ordem de execução determinística.
O nome após o número descreve o que é testado:

```perl
# t/001_health.t
use strict;
use warnings;
use Test::More;
use Test::Mojo;

my $t = Test::Mojo->new('Stega');

$t->get_ok('/healthz')
  ->status_is(200)
  ->json_has('/status');

done_testing;
```

```perl
# t/010_tickets_api.t
use strict;
use warnings;
use Test::More;
use Test::Mojo;

my $t = Test::Mojo->new('Stega');

subtest 'GET /api/v1/tickets — sem autenticação retorna 401' => sub {
    $t->get_ok('/api/v1/tickets')
      ->status_is(401)
      ->json_has('/error');
};

done_testing;
```

Rodar os testes:

```bash
carton exec prove -lr t/
```

Saída esperada:

```
t/001_health.t      .. ok
t/010_tickets_api.t .. ok
All tests successful.
```

**Como o Test::Mojo funciona?** As requisições atravessam o dispatcher do
Mojolicious em memória — sem servidor HTTP real e sem portas em uso.
Isso torna os testes rápidos e sem efeitos colaterais.

---

## Passo 7 — Servidor de produção com Hypnotoad

Em produção (e para simular o ambiente Kubernetes localmente), use o Hypnotoad:

```bash
# Iniciar
carton exec hypnotoad script/stega

# Parar
carton exec hypnotoad --stop script/stega

# Reimplantar sem interrupção (envia SIGUSR2 à instância existente)
carton exec hypnotoad script/stega
```

Configure o Hypnotoad em `stega.conf`:

```perl
# stega.conf
{
    hypnotoad => {
        listen  => ['http://*:8080'],
        workers => 4,
        pid_file => '/tmp/hypnotoad.pid',
    }
}
```

A porta 8080 é o padrão para containers — o Service do Kubernetes aponta para ela.

---

## Estrutura após este guia

```
crystallized-perl-stega/
├── .gitattributes
├── .gitignore
├── cpanfile
├── cpanfile.snapshot
├── DEVELOPMENT.md
├── script/
│   └── stega                    ← ponto de entrada
├── lib/
│   ├── Stega.pm                 ← classe principal
│   └── Stega/
│       └── Controller/
│           ├── Health.pm        ← GET /healthz
│           └── Ticket.pm        ← GET /api/v1/tickets (stub)
├── t/
│   ├── 001_health.t
│   └── 010_tickets_api.t
└── local/                       ← módulos do Carton (não commitado)
```

---

## Padrões que o stack exige

| Padrão | Por quê |
|--------|---------|
| `use Mojo::Base -strict` em scripts | Ativa `strict`, `warnings` e `utf8` em uma linha |
| Controllers herdam `Mojolicious::Controller` | Dá acesso a `$self->render`, `$self->param`, `$self->stash` |
| Modelos de domínio usam `Moo` | Separação de responsabilidades — controllers são thin adapters |
| `GET /healthz` sempre presente | Kubernetes usa para Liveness e Readiness Probes |
| API sob `/api/v1` | Permite versionar sem quebrar clientes existentes |

---

## Próximos passos

Com a estrutura de roteamento estabelecida, os próximos guias adicionam:

- **Banco de dados**: conectar ao PostgreSQL via Mojo::Pg e aplicar migrations (ADR-016)
- **Modelos Moo**: implementar `Stega::Model::Ticket` com atributos tipados (ADR-006)
- **Autenticação**: middleware JWT para proteger as rotas `/api/v1` (ADR-009)

Explore agora:
- [**Stack — Mojolicious**](/stack/mojolicious): referência rápida do framework
- [**ADR-004**](/adrs/ADR-004-framework-web-mojolicious): os critérios de escolha
  do Mojolicious sobre Catalyst, Dancer2 e Plack/PSGI
