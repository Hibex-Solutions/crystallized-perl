---
sidebar_position: 4
title: Moo + Moo::Role
---

# Moo + Moo::Role

> **Decisão**: Moo como sistema de OO para modelos de domínio e serviços;
> `Mojo::Base` para controllers Mojolicious.
> [ADR-006 — Sistema de OO Moo](/adrs/ADR-006-sistema-de-oo-moo)

---

## Por que Moo

O Moo oferece a mesma experiência declarativa do Moose — atributos com `has`,
composição com `with`, construtores automáticos, validação de tipos — sem as
dependências XS que tornam o Moose pesado em containers. Sem XS: build Docker
mais rápido, imagem menor e startup de Pod Kubernetes mais rápido.

A API do Moo é compatível com Moose: se o projeto precisar de introspecção
avançada (metaclasse, `around`/`before`/`after` em escala), a migração é
transparente — basta trocar `use Moo` por `use Moose`.

---

## Onde usar Moo vs. Mojo::Base

| Tipo de objeto | Sistema | Módulo base |
|---------------|---------|-------------|
| Controladores HTTP | `Mojo::Base` | `use Mojo::Base 'Mojolicious::Controller'` |
| Classe principal da app | `Mojo::Base` | `use Mojo::Base 'Mojolicious'` |
| Modelos de domínio | `Moo` | `use Moo` |
| Serviços e integrações | `Moo` | `use Moo` |
| Roles (comportamentos) | `Moo::Role` | `use Moo::Role` |

---

## Anatomia de uma classe Moo

```perl
# lib/Stega/Model/Ticket.pm
package Stega::Model::Ticket;
use Moo;
use namespace::clean;   # remove do namespace público funções importadas (has, with...)

# Atributo obrigatório, somente leitura
has 'id' => (
    is       => 'ro',
    required => 1,
);

# Atributo com valor padrão lazy (calculado na primeira leitura)
has 'status' => (
    is      => 'ro',
    default => 'open',
);

# Atributo com validação inline
has 'priority' => (
    is  => 'ro',
    isa => sub {
        my $val = shift;
        die "priority inválida: $val\n"
            unless grep { $val eq $_ } qw(low medium high critical);
    },
    default => 'medium',
);

# Atributo construído a partir de outros (lazy builder)
has 'display_name' => (
    is      => 'ro',
    lazy    => 1,
    builder => '_build_display_name',
);

sub _build_display_name {
    my $self = shift;
    return sprintf('[#%d] %s', $self->id, $self->title);
}

# Método de instância
sub is_open  { $_[0]->status eq 'open' }
sub is_closed { $_[0]->status eq 'closed' }

sub as_json {
    my $self = shift;
    return {
        id       => $self->id,
        title    => $self->title,
        status   => $self->status,
        priority => $self->priority,
    };
}

1;
```

---

## Roles — composição sem herança múltipla

```perl
# lib/Stega/Role/HasTimestamps.pm
package Stega::Role::HasTimestamps;
use Moo::Role;
use namespace::clean;

has 'created_at' => (
    is      => 'ro',
    default => sub { time() },
);

has 'updated_at' => ( is => 'rw' );

sub touch { $_[0]->updated_at(time()) }

1;
```

```perl
# lib/Stega/Role/HasAuditLog.pm
package Stega::Role::HasAuditLog;
use Moo::Role;
use namespace::clean;

has 'events' => (
    is      => 'ro',
    default => sub { [] },
);

sub add_event {
    my ($self, $type, $payload) = @_;
    push @{$self->events}, { type => $type, payload => $payload, at => time() };
}

1;
```

```perl
# lib/Stega/Model/Ticket.pm — compondo os Roles
package Stega::Model::Ticket;
use Moo;
with 'Stega::Role::HasTimestamps';   # adiciona created_at, updated_at, touch()
with 'Stega::Role::HasAuditLog';     # adiciona events, add_event()
use namespace::clean;

has 'title'  => ( is => 'ro', required => 1 );
has 'status' => ( is => 'rw', default => 'open' );

1;
```

---

## Modificadores de atributos

```perl
has 'name' => (
    is       => 'rw',         # rw: leitura e escrita; ro: somente leitura
    required => 1,            # obrigatório no construtor
    isa      => sub { ... },  # validação: die para valor inválido
    default  => 'valor',      # valor padrão (escalar ou sub { })
    lazy     => 1,            # calculado na primeira leitura
    builder  => '_build_name', # método construtor do valor lazy
    coerce   => sub { lc $_[0] }, # transforma o valor antes de armazenar
    clearer  => 'clear_name', # gera método para resetar para undef
    predicate => 'has_name',  # gera método para checar se foi definido
    trigger  => sub {         # chamado quando o valor é definido/alterado
        my ($self, $new) = @_;
        $self->add_event('name_changed', { name => $new });
    },
);
```

---

## Integração com controllers Mojolicious

```perl
# lib/Stega/Controller/Ticket.pm
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';

use Stega::Model::Ticket;   # importa o modelo Moo

sub show {
    my $self = shift;

    my $row = $self->pg->db->query(
        'SELECT id, title, status, priority FROM tickets WHERE id = ?',
        $self->param('id')
    )->hash;

    return $self->render(json => { error => 'not_found' }, status => 404)
        unless $row;

    # Instancia o modelo Moo a partir dos dados do banco
    my $ticket = Stega::Model::Ticket->new(%{$row});

    $self->render(json => $ticket->as_json);
}

1;
```

---

## Convenções do stack

```perl
# Sempre use namespace::clean após os imports
package Foo;
use Moo;
use Some::Util qw(helper_func);
use namespace::clean;   # remove 'helper_func' do namespace público de Foo
                        # evita que $obj->helper_func funcione acidentalmente

# Construtores são always chamados com hash nomeado (nunca lista posicional)
my $ticket = Stega::Model::Ticket->new(
    id       => 42,
    title    => 'Erro no login',
    priority => 'high',
);

# Nunca construa um Moo object assim:
# my $ticket = Stega::Model::Ticket->new(42, 'Erro no login', 'high');  # ERRADO
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `has 'x' => 'ro'` (forma curta) | Moo aceita, mas é incomum — pode confundir | Sempre use `has 'x' => (is => 'ro')` |
| `default` com valor mutável | `default => []` compartilha a mesma arrayref entre instâncias | `default => sub { [] }` — sempre sub para refs |
| Role com atributo `required` | Roles não deveriam ter `required` — dificulta quem compõe | Coloque `required` nas classes, não nos Roles |
| `with` antes de `has` | Pode causar conflitos de atributo silenciosos | Declare `with` depois de todos os `has` próprios da classe |
| Moo em controllers | Controllers Mojo têm comportamento especial no lifecycle | Sempre `Mojo::Base` em controllers, nunca `Moo` |
