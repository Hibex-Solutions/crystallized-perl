# ADR-006: Sistema de Orientação a Objetos — Moo

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Aplicações Mojolicious são orientadas a objetos: controladores herdam de
`Mojolicious::Controller`, modelos encapsulam lógica de domínio, serviços abstraem
integrações externas. O Perl tem OO nativo (via `bless`), mas é verboso e propenso a
erros boilerplate. Sistemas como Moose e Moo fornecem uma sintaxe declarativa que
automatiza a criação de construtores, acessores e a composição via Roles.

A escolha do sistema de OO afeta diretamente o tempo de startup dos containers (crítico
para Pods no Kubernetes que precisam de startup rápido) e a complexidade das imagens
Docker (módulos XS exigem compilador C no estágio de build).

## Decisão

**Moo** como sistema de OO para modelos de domínio, serviços e repositórios.
Controladores Mojolicious continuam usando `Mojo::Base` (padrão nativo do Mojolicious).

Para **value objects simples sem roles** (DTOs, estruturas de resposta, wrappers sem
comportamento compartilhado), o `class` nativo do Perl 5.42+ é uma alternativa válida
e preferível quando não há dependência de `Moo::Role`. A escolha é guiada pela
necessidade de roles: onde há roles, Moo; onde não há, `class` é mais idiomático.

## Justificativa

O Moo oferece a mesma experiência declarativa do Moose — atributos com `has`, Roles
com `with`, construtores automáticos, validação de atributos — sem as dependências XS
que tornam o Moose pesado em containers. A ausência de XS tem dois efeitos práticos:

1. **Build de imagem mais rápido**: módulos Pure Perl instalados via Carton não exigem
   compilador C, reduzindo o tempo de `carton install` no estágio de build do Docker.
2. **Imagem final menor**: sem bibliotecas C compiladas adicionais além do `DBD::Pg`
   (que já é XS obrigatório pelo driver do PostgreSQL).

O **tempo de startup do Moo é significativamente menor que o do Moose**, o que impacta
positivamente a velocidade de inicialização de novos Pods no Kubernetes durante
escalabilidade horizontal.

A API do Moo é compatível com Moose: se o projeto crescer e precisar de recursos
avançados de introspecção (metaclasse, `around`, `before`, `after` em escala), a
migração é transparente — basta trocar `use Moo` por `use Moose`.

Referências: [Moo](../references/moo.md),
[Perldoc: Tutorial OO (perlootut)](../references/perldoc-perlootut.md),
[Modern Perl](../references/modern-perl-book.md)

### Classe de domínio com Moo

```perl
# lib/MyApp/Model/User.pm
package MyApp::Model::User;
use Moo;
use namespace::autoclean;

# Atributo obrigatório, somente leitura
has 'id' => (
    is       => 'ro',
    required => 1,
);

# Atributo com valor padrão
has 'name' => (
    is      => 'rw',
    default => 'Anônimo',
);

# Atributo com validação
has 'email' => (
    is  => 'ro',
    isa => sub {
        die "Email inválido\n" unless $_[0] =~ /\@/;
    },
);

# Método de instância
sub as_json {
    my $self = shift;
    return {
        id    => $self->id,
        name  => $self->name,
        email => $self->email,
    };
}

1;
```

### Role para comportamentos compartilhados

```perl
# lib/MyApp/Role/Timestamped.pm
package MyApp::Role::Timestamped;
use Moo::Role;
use namespace::autoclean;

has 'created_at' => ( is => 'ro', default => sub { time() } );
has 'updated_at' => ( is => 'rw' );

1;
```

```perl
# lib/MyApp/Model/Post.pm
package MyApp::Model::Post;
use Moo;
with 'MyApp::Role::Timestamped';   # compõe o Role
use namespace::autoclean;

has 'title'   => ( is => 'ro', required => 1 );
has 'content' => ( is => 'rw' );

1;
```

### Integração com controladores Mojolicious

Controladores **não usam Moo** — eles usam `Mojo::Base`, que é o mecanismo de herança
nativo do Mojolicious:

```perl
# lib/MyApp/Controller/User.pm
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller';

# Controlador usa MyApp::Model::User (Moo) para lógica de domínio
use MyApp::Model::User;

sub show {
    my $self = shift;
    my $id   = $self->param('id');

    my $user = MyApp::Model::User->new(
        id    => $id,
        name  => 'Alice',
        email => 'alice@example.com',
    );

    $self->render(json => $user->as_json);
}

1;
```

### Resumo das convenções

| Tipo de objeto | Sistema de OO |
|---------------|--------------|
| Controladores (HTTP handlers) | `use Mojo::Base 'Mojolicious::Controller'` |
| Modelos de domínio | `use Moo` |
| Serviços e integrações | `use Moo` |
| Roles (comportamentos) | `use Moo::Role` |
| Classe principal da app | `use Mojo::Base 'Mojolicious'` |
| Value objects simples (sem roles) | `use v5.42; class Foo { ... }` |

## Alternativas Consideradas

| Alternativa | Observação |
|-------------|-----------|
| **`class` nativo (Perl 5.42+)** | Estável desde 5.40, sem dependências CPAN. **Adotado parcialmente**: válido para value objects simples sem roles. **Bloqueador para uso geral**: não há suporte nativo a roles — e a Stega usa roles extensivamente (`HasTimestamps`, `HasAuditLog`). Previsto para revisão quando o suporte a roles chegar na linguagem |
| **Moose** | Pesado (múltiplas deps XS), startup mais lento — impacta negativamente o boot de containers; vantagens de introspecção avançada não são necessárias para o escopo atual |
| **OO manual (`bless`)** | Verboso, propenso a boilerplate inconsistente entre classes, sem Roles, sem construtores automáticos — inadequado para um projeto com múltiplos modelos de domínio |
| **Class::Tiny** | Muito minimalista: sem suporte a Roles, sem validação de atributos, sem `isa` — insuficiente para o nível de organização exigido pelo stack |
| **Mojo::Base para tudo** | Mojo::Base é otimizado para o framework Mojolicious, não para OO de domínio; não tem Roles nem validação de atributos |

## Consequências

**Positivo**:
- Sintaxe declarativa limpa para todos os objetos de domínio
- Roles permitem composição de comportamentos sem herança múltipla
- Sem deps XS: build Docker mais rápido, imagem menor
- API compatível com Moose garante migração possível sem reescrita

**Negativo**:
- Equipe deve manter a convenção de usar `Mojo::Base` em controladores e `Moo` nos
  modelos — misturar os dois erroneamente é um erro silencioso mas confuso

**Ações necessárias**:
- Adicionar `namespace::autoclean` ao `cpanfile` (mantém o namespace do pacote limpo
  removendo funções importadas do escopo público após a compilação)
- Documentar no guia de desenvolvimento a distinção entre controladores (`Mojo::Base`)
  e modelos (`Moo`)
