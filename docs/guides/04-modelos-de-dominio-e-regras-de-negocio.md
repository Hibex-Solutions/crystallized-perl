---
sidebar_position: 4
title: "Guia 4 — Modelos de Domínio e Regras de Negócio"
---

# Guia 4 — Modelos de Domínio com Moo e Regras de Negócio Testáveis

> **Referências arquiteturais**:
> [ADR-006 — Sistema de OO Moo](/adrs/ADR-006-sistema-de-oo-moo) ·
> [ADR-011 — Estratégia de Testes](/adrs/ADR-011-estrategia-de-testes) ·
> [ADR-020 — Camada de Domínio e Repository](/adrs/ADR-020-dominio-e-repository)

---

## O que você vai construir

Ao final deste guia você terá:

- `lib/Stega/Model/Ticket.pm` — um modelo de domínio Moo, independente de banco de dados
- `lib/Stega/Domain/TicketPolicy.pm` — uma classe de regras de negócio pura (papel ×
  estado → permissão), sem `Mojo::Base`, sem `Mojo::Pg`
- `t/unit/domain/ticket_policy.t` — testes unitários que rodam em milissegundos, sem
  PostgreSQL, cobrindo toda a matriz de permissões documentada em `BUSINESS.md`
- Um Controller que usa a Policy em vez de reimplementar a regra inline

---

## Pré-requisitos

- [Guia 3](/guides/primeira-rota-mojolicious) concluído
- `lib/Stega.pm`, `script/stega` e ao menos um Controller já existentes
- Familiaridade com o cabeçalho padrão de [ADR-019](/adrs/ADR-019-cabecalho-padrao-de-codigo-perl)

---

## Por que separar "modelo" de "regra de negócio"

Um erro comum em aplicações Mojolicious pequenas é deixar a lógica de permissão
dentro do Controller, ao lado das chamadas `$c->pg->db->query(...)`. Funciona no
início, mas tem dois custos que aparecem conforme a aplicação cresce:

1. **Testar uma regra de permissão exige banco de dados.** Para saber se "um agente
   só pode alterar o status de um ticket se for o responsável atual" está correto,
   o único teste possível é subir `Test::Mojo` com PostgreSQL real.
2. **A mesma regra tende a ser reimplementada duas vezes.** A rota web
   (`/tickets/:id/status`) e a rota de API (`PATCH /api/v1/tickets/:id`) costumam
   validar a mesma permissão de formas ligeiramente diferentes — e divergem com o
   tempo sem que ninguém perceba.

A solução é dividir responsabilidades em duas camadas:

```
Stega::Model::Ticket        ← forma dos dados (atributos, construtor, getters)
Stega::Domain::TicketPolicy ← decisões de permissão (papel × estado → booleano)
Stega::Controller::Ticket   ← orquestra: lê request, chama a Policy, consulta o banco
```

Nenhuma das duas primeiras conhece `Mojo::Pg`, `$c->stash` ou HTTP. Isso é o que as
torna testáveis com `Test::More` puro.

---

## Passo 1 — O modelo de domínio: Stega::Model::Ticket

```perl
# lib/Stega/Model/Ticket.pm
package Stega::Model::Ticket;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

has id            => (is => 'ro');
has product_id    => (is => 'ro', required => 1);
has author_id     => (is => 'ro', required => 1);
has assignee_id   => (is => 'rw');
has title         => (is => 'rw', required => 1);
has body          => (is => 'rw', required => 1);
has status        => (is => 'rw', default  => 'open');
has priority      => (is => 'rw', default  => 'medium');
has custom_fields => (is => 'rw');
has created_at    => (is => 'ro');
has updated_at    => (is => 'rw');
has resolved_at   => (is => 'rw');

sub is_open     { $_[0]->status eq 'open' }
sub is_resolved { $_[0]->status eq 'resolved' }
sub is_closed   { $_[0]->status eq 'closed' }
sub is_active   { !$_[0]->is_closed }

sub from_row {
    my ($class, $row) = @_;
    return $class->new(%$row);
}

1;
```

Note o `use v5.42; use utf8;` antes de `use Moo;`. `use Moo;` já ativa `strict` e
`warnings` no pacote que o importa — mas **não** ativa `utf8`. Sem essa linha, um
método como `sub titulo_formatado { "Título: " . $_[0]->title }` teria o literal
`"Título: "` tratado como bytes crus, não como texto Unicode. Ver
[ADR-019](/adrs/ADR-019-cabecalho-padrao-de-codigo-perl) para o padrão completo.

`from_row` converte um `hashref` vindo de `$c->pg->db->query(...)->hash` diretamente
em uma instância — é o único ponto de contato entre este modelo e a camada de dados,
e mesmo assim só na direção "dado → objeto", nunca o inverso.

---

## Passo 2 — A camada de política: Stega::Domain::TicketPolicy

`BUSINESS.md` documenta, por exemplo, a tabela de permissões para alterar status:

| Quem | Pode alterar? | Condição |
|------|---------------|----------|
| `customer` | Não | — |
| `agent` | Sim | Apenas se for o responsável atual |
| `admin` | Sim | Sempre |

Isso vira um método de classe puro — recebe os dados necessários para decidir,
devolve um booleano:

```perl
# lib/Stega/Domain/TicketPolicy.pm
package Stega::Domain::TicketPolicy;
use v5.42;
use utf8;

use constant VALID_STATUSES  => [qw(open in_progress waiting resolved closed)];
use constant ASSIGNABLE_ROLE => 'agent';

sub valid_status {
    my ($class, $status) = @_;
    return !!grep { $_ eq ($status // '') } @{ VALID_STATUSES() };
}

sub can_change_status {
    my ($class, %args) = @_;   # role, assignee_id, user_id
    my $role = $args{role} // '';

    return 1 if $role eq 'admin';
    return 0 unless $role eq 'agent';

    return defined $args{assignee_id}
        && defined $args{user_id}
        && $args{assignee_id} eq $args{user_id};
}

sub valid_assignee_role {
    my ($class, $target_role) = @_;
    return defined $target_role && $target_role eq ASSIGNABLE_ROLE;
}

1;
```

Note o que **não** está aqui: nenhum `$c->pg->db->query`, nenhum `Mojo::Base`,
nenhuma referência a HTTP. `Stega::Domain::TicketPolicy` não sabe que existe uma
API REST — só sabe responder "dado este papel, este responsável e este usuário,
esta ação é permitida?".

---

## Passo 3 — Testando a Policy sem banco de dados

```perl
# t/unit/domain/ticket_policy.t
use v5.42;
use utf8;
use Test::More;

use Stega::Domain::TicketPolicy;

subtest 'can_change_status — BUSINESS.md: Permissões para Alterar Status' => sub {
    ok Stega::Domain::TicketPolicy->can_change_status(
        role => 'admin', assignee_id => undef, user_id => 'u1',
    ), 'admin sempre pode, mesmo sem responsável';

    ok !Stega::Domain::TicketPolicy->can_change_status(
        role => 'customer', assignee_id => 'u1', user_id => 'u1',
    ), 'customer nunca pode, mesmo sendo o autor';

    ok Stega::Domain::TicketPolicy->can_change_status(
        role => 'agent', assignee_id => 'u1', user_id => 'u1',
    ), 'agent pode se for o responsável atual';

    ok !Stega::Domain::TicketPolicy->can_change_status(
        role => 'agent', assignee_id => 'u2', user_id => 'u1',
    ), 'agent não pode se não for o responsável atual';
};

done_testing;
```

Rode apenas esse arquivo:

```bash
carton exec prove -lv t/unit/domain/ticket_policy.t
```

Sem `docker compose up`, sem `carton exec perl eng/migrate.pl` — o teste inteiro
roda em memória. Essa é a diferença prática entre este teste e os de
`t/010_tickets_api.t`: aqui cada combinação de papel × estado é uma linha de
`Test::More`, não uma requisição HTTP completa contra um banco real.

---

## Passo 4 — Usando a Policy no Controller

O Controller chama a Policy em vez de reimplementar a regra — e a mesma chamada
serve tanto a rota web quanto a de API, eliminando a duplicação:

```perl
# lib/Stega/Controller/Ticket.pm (trecho)
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller', -strict;

use Stega::Domain::TicketPolicy;
use Stega::Domain::Ticket;
use Stega::Repository::Pg::Ticket;

sub update_status {
    my $c = shift;

    my $id     = $c->param('id');
    my $status = $c->param('status') // '';
    my $user   = $c->stash('current_user');
    my $role   = $user->{role} // '';

    return $c->render(text => 'Status inválido', status => 400)
        unless Stega::Domain::TicketPolicy->valid_status($status);

    my $repo   = Stega::Repository::Pg::Ticket->new(db => $c->pg->db);
    my $ticket = $repo->find($id);
    return $c->reply->not_found unless $ticket;

    return $c->render(text => 'Sem permissão para alterar status', status => 403)
        unless Stega::Domain::TicketPolicy->can_change_status(
            role        => $role,
            assignee_id => $ticket->{assignee_id},
            user_id     => $user->{id},
        );

    Stega::Domain::Ticket->new(repository => $repo)
        ->change_status(ticket => $ticket, status => $status, actor_id => $user->{id});

    $c->redirect_to("/tickets/$id");
}

1;
```

O Controller ainda orquestra I/O (consulta e grava no banco) — isso é esperado, é o
papel dele. O que muda é *como*: ele nunca chama `$c->pg->db->query(...)` diretamente
(esse SQL vive em `Stega::Repository::Pg::Ticket`, ver Guia 5 e ADR-020); e a
**decisão** de permitir ou negar não vive nem aqui nem no Repository — vive em
`Stega::Domain::TicketPolicy`, uma classe que qualquer teste unitário consegue
instanciar sem infraestrutura. O Guia 5 detalha o Repository; a seção seguinte deste
guia detalha quando a escrita em si (não só a autorização) também precisa de uma
classe de Domain própria.

---

## Quando criar uma nova classe de Policy

Nem toda regra de negócio precisa de uma classe própria — um `if` simples e local
ao Controller é suficiente para lógica que não se repete e não tem múltiplas
combinações a testar. Considere extrair uma Policy quando:

- A mesma checagem aparece em mais de uma rota (web e API, por exemplo)
- Há uma matriz de combinações (papel × estado, papel × recurso) que vale a pena
  testar exaustivamente
- A regra está documentada em `BUSINESS.md` como uma decisão de produto — nesse
  caso, a Policy é o lugar natural para essa documentação virar código verificável

Na Stega, `Stega::Domain::TicketPolicy` também cobre as regras de comentários
internos, atribuição de responsável e gestão de produtos — todas descritas em
`BUSINESS.md` e testadas em `t/unit/domain/ticket_policy.t` sem tocar o banco.

---

## Policy decide quem; Domain+Repository decide se e executa

`TicketPolicy` responde uma pergunta específica: *dado o papel de um usuário, ele tem
permissão para esta ação?* Existe uma segunda pergunta que Policy não responde: *a
ação em si é válida, dado o estado atual dos dados?* — por exemplo, "não é permitido
criar dois produtos com o mesmo slug". Isso depende de consultar o que já existe, não
só do papel do usuário.

Para esse segundo tipo de regra, o stack define um padrão complementar — **Domain +
Repository** ([ADR-020](/adrs/ADR-020-dominio-e-repository)): uma classe de domínio
por entidade recebe um **Repository** injetado no construtor (o contrato de acesso a
dados, definido como `Moo::Role`), valida a operação contra o estado atual e, se
válida, executa:

```perl
# lib/Stega/Domain/Product.pm
package Stega::Domain::Product;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

has repository => (is => 'ro', required => 1);

sub create {
    my ($self, %attrs) = @_;

    die "Slug é obrigatório\n" unless length($attrs{slug} // '');
    die "Já existe um produto com este slug\n"
        if $self->repository->find_by_slug($attrs{slug});

    return $self->repository->insert(%attrs);
}

1;
```

Em teste, o Repository real (`Stega::Repository::Pg::Product`, que envolve
`$c->pg->db`) é trocado por uma implementação **Fake** em memória — não por
`Test::MockObject`. A razão: validar "rejeita slug duplicado" exige estado real
entre chamadas dentro do mesmo teste (inserir, depois buscar) — simular isso com
`Test::MockObject` exigiria capturar um array em closures manualmente, o que já é
reimplementar uma Fake, só que sem a garantia de contrato que
`with 'Stega::Repository::Product';` oferece. `Test::MockObject` continua sendo a
ferramenta certa para o que já fazia bem: verificar uma interação pontual com um
serviço externo (RabbitMQ, uma chamada HTTP), não para simular um repositório com
estado.

A Fake reside em `t/lib/`, não em `lib/` — é código que só existe para dar suporte a
testes, seguindo a mesma convenção que `t/lib/Stega/Test/Helper.pm` já estabelece
neste projeto:

```perl
# t/lib/Stega/Test/Repository/Product.pm
package Stega::Test::Repository::Product;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

with 'Stega::Repository::Product';   # mesmo contrato do Repository real

has _rows => (is => 'ro', default => sub { [] });

sub find_by_slug { my ($self, $slug) = @_; (grep { $_->{slug} eq $slug } @{ $self->_rows })[0] }
sub insert       { my ($self, %attrs) = @_; push @{ $self->_rows }, { %attrs }; return { %attrs }; }

1;
```

```perl
# t/unit/domain/product.t — sem banco, sem Test::Mojo
use v5.42;
use utf8;
use Test::More;
use lib 't/lib';

use Stega::Domain::Product;
use Stega::Test::Repository::Product;

subtest 'rejeita slug duplicado' => sub {
    my $repo   = Stega::Test::Repository::Product->new(seed => [{ slug => 'stega-demo' }]);
    my $domain = Stega::Domain::Product->new(repository => $repo);

    eval { $domain->create(slug => 'stega-demo') };
    like $@, qr/slug/, 'rejeita slug já existente';
};

done_testing;
```

O Controller usa as duas camadas em sequência — primeiro autoriza, depois valida e
executa:

```perl
sub api_create {
    my $c = shift;
    my $role = ($c->stash('current_user') // {})->{role} // '';

    return $c->render(json => { error => 'Apenas admins' }, status => 403)
        unless Stega::Domain::TicketPolicy->can_manage_products($role);   # autorização

    my $domain = Stega::Domain::Product->new(
        repository => Stega::Repository::Pg::Product->new(db => $c->pg->db),
    );
    my $product = eval { $domain->create(%{ $c->req->json }) };           # validação + execução
    return $c->render(json => { error => $@ }, status => 422) if $@;

    $c->render(json => { data => $product }, status => 201);
}
```

Nem toda entidade precisa dessa camada — `Product` na Stega ganhou porque tinha uma
regra de duplicidade real (e um bug real: a ausência dela deixava a violação da
constraint `UNIQUE` do banco estourar como erro 500 não tratado). Uma entidade que só
faz um upsert simples, sem regra de negócio própria, não se beneficia da cerimônia
extra — mantenha o SQL direto no Controller até que uma regra real apareça.

`Ticket` e `Comment` passaram pelo mesmo crivo depois do piloto em `Product` e também
ganharam a camada: `Ticket` porque criar um ticket para um produto inativo era aceito
silenciosamente (BUSINESS.md documentava a regra, o código não a impunha) e atribuir a
alguém sem papel `agent` também não era validado; `Comment` porque comentar em um
`ticket_id` inexistente estourava um erro 500 de violação de chave estrangeira, igual
ao bug original do slug duplicado. Nos dois casos, o Repository passou a cobrir também
as leituras da entidade (não só a escrita validada) — ver a "Revisão 2026-07-03" na
ADR-020 para o raciocínio completo dessa extensão de escopo.

---

## Estrutura após este guia

```
lib/Stega/
├── Model/
│   └── Ticket.pm              ← forma dos dados (Moo)
├── Domain/
│   ├── TicketPolicy.pm        ← autorização: quem pode agir (regras puras)
│   └── Product.pm             ← validação de negócio + execução (usa Repository)
├── Repository/
│   ├── Product.pm             ← contrato (Moo::Role)
│   └── Pg/
│       └── Product.pm         ← implementação real (produção)
└── Controller/
    ├── Ticket.pm               ← orquestra request → Policy → banco
    └── Product.pm              ← orquestra request → Policy → Domain → Repository

t/
├── lib/Stega/Test/Repository/
│   └── Product.pm              ← Fake do Repository — só em teste, nunca em lib/
└── unit/domain/
    ├── ticket_policy.t         ← sem banco, roda em milissegundos
    └── product.t                ← sem banco, usa a Fake acima
```

---

## Próximos passos

Com regras de negócio isoladas e testáveis, os próximos guias adicionam:

- **Banco de dados**: `Mojo::Pg` e migrations versionadas (ADR-016)
- **Autenticação**: middleware JWT que popula `current_user` no stash (ADR-009)
- **Contrato de API**: validação automática de request/response com OpenAPI v3 (ADR-015)

Explore agora:
- [**ADR-006**](/adrs/ADR-006-sistema-de-oo-moo): por que Moo e não Moose ou `class` nativo
- [**ADR-011**](/adrs/ADR-011-estrategia-de-testes): a estratégia completa de testes,
  incluindo o padrão Policy detalhado acima
- [**ADR-020**](/adrs/ADR-020-dominio-e-repository): o padrão Domain + Repository,
  quando usá-lo e por que a Fake fica em `t/lib/` em vez de `Test::MockObject`
