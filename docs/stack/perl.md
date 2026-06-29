---
sidebar_position: 1
title: Perl 5.42
---

# Perl 5.42

> **Decisão**: Perl 5.42 é a versão mínima do stack.
> A declaração `requires 'perl', '5.042'` no `cpanfile` faz o Carton validar
> isso automaticamente em toda instalação. Versões estáveis futuras (5.44+)
> são suportadas — 5.42 é o piso, não um pino fixo.

---

## Por que Perl 5.42

O Perl 5.42 é a versão estável mais recente, [recomendada oficialmente pelo
perl.org](https://www.perl.org/get.html), e oferece o ecossistema mais
completo: imagem Docker oficial (`perl:5.42`), suporte integral no perlbrew e
berrybrew, e todos os módulos CPAN relevantes testados contra ela.

Destaques relevantes para o stack em relação a versões anteriores:

- **`use v5.42;`** — desde a versão 5.36, a pragma de versão ativa `strict` e
  `warnings` automaticamente. Em scripts e utilitários `eng/`, uma linha
  substitui as três tradicionais.
- **Palavra-chave `class` estável** (desde 5.40) — o sistema de OO nativo saiu
  do estado experimental. O stack continua usando Moo por maturidade, suporte a
  roles e ampla base instalada no CPAN, mas `class` é a direção de longo prazo
  da linguagem.
- **Compatibilidade com o ecossistema** — Mojolicious, Moo, Mojo::Pg e demais
  módulos do stack testam ativamente contra as versões mais recentes.

A versão mínima está declarada como `5.042` (não `5.42`) porque o `cpanfile` usa
a notação numérica do módulo `version`, onde `5.42` e `5.042` são
representações equivalentes da mesma versão. Versões estáveis posteriores
(5.44, 5.46…) são compatíveis — o stack não impõe um teto.

**Referências**: [perl.org](https://www.perl.org) ·
[perl5/perl5 no GitHub](https://github.com/Perl/perl5) ·
[Modern Perl (livro)](/references/modern-perl-book)

---

## Convenções obrigatórias no stack

### Cabeçalho padrão de todo arquivo `.pm`

```perl
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';   # controllers
# — ou —
use Moo;                                     # modelos de domínio
use namespace::clean;
```

`use Mojo::Base` e `use Moo` ativam `strict` e `warnings` implicitamente.
Nunca use `use strict; use warnings` manualmente em módulos do stack — é redundante.

### Scripts e pontos de entrada

```perl
#!/usr/bin/env perl
use Mojo::Base -strict;   # ativa strict + warnings + utf8 em uma linha
```

### Proibições explícitas

| Padrão proibido | Alternativa moderna |
|----------------|---------------------|
| `use base 'Foo'` | `use Mojo::Base 'Foo'` ou `use parent 'Foo'` |
| Chamadas de método indiretas: `new Foo` | `Foo->new` |
| `open(FILE, ">arquivo")` | `open(my $fh, '>', 'arquivo')` |
| `$_` em tutoriais como "simplificação" | variável nomeada explícita |
| `use 5.010` (versão antiga) | `use v5.42` ou `requires 'perl', '5.042'` |
| `our @EXPORT` com `Exporter` | Funções via `Moo` ou sem exportação |

---

## Instalação da versão correta

### Linux / macOS — perlbrew

```bash
perlbrew install perl-5.42.2
perlbrew switch perl-5.42.2
perl -v   # confirma: version 42, subversion 2
```

### Windows — berrybrew

```powershell
berrybrew install 5.42.2_64
berrybrew switch 5.42.2_64
perl -v
```

### Docker

```dockerfile
FROM perl:5.42
# A imagem oficial já inclui perl 5.42.x e cpanm
```

---

## Padrões de código adotados no stack

### Referências e acessos

```perl
# Hashref — sempre com chave entre chaves
my $config = { host => 'localhost', port => 5432 };
my $host   = $config->{host};

# Arrayref
my $ids = [1, 2, 3];
my $first = $ids->[0];

# Deref em loop
for my $ticket (@{$tickets}) { ... }

# Alternativa com array slice de hashref
my @titles = map { $_->{title} } @{$tickets};
```

### Chamadas de método encadeadas (Mojolicious)

```perl
# Estilo fluente do Test::Mojo
$t->get_ok('/healthz')
  ->status_is(200)
  ->json_is('/status', 'ok');

# Mojo::UserAgent — chamada não-bloqueante
my $tx = $self->ua->get('https://api.exemplo.com/data');
my $data = $tx->result->json;
```

### Operadores modernos

```perl
# Definedness check (//= é atribuição com defined-or)
my $port = $config->{port} // 5432;
$config->{timeout} //= 30;

# String repetition vs. list repetition
my $line = '-' x 40;
my @zeros = (0) x 5;

# Wantarray para contexto (use com parcimônia)
sub items { wantarray ? @list : \@list }
```

### Tratamento de erros

```perl
# Exceptions — die com objeto ou string
eval {
    my $result = $self->pg->db->query($sql, @params);
};
if (my $err = $@) {
    $self->app->log->error("Query falhou: $err");
    return $self->render(json => { error => 'internal' }, status => 500);
}

# Alternativa com Try::Tiny (não no stack por padrão)
# use Try::Tiny;
# try { ... } catch { ... };
```

---

## Ferramentas de qualidade de código

```bash
# Verificação estática básica (sempre disponível)
perl -c lib/Stega/Controller/Ticket.pm

# Testes com TAP
carton exec prove -lr t/

# Cobertura de testes
PERL5OPT="-MDevel::Cover" carton exec prove -lr t/
carton exec cover   # gera relatório HTML em cover_db/

# Perl::Critic (análise de estilo — não obrigatório, mas útil)
cpanm Perl::Critic
perlcritic lib/
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `@array` em contexto escalar | Retorna contagem de elementos, não o primeiro | Use `$array[0]` para o primeiro elemento |
| `undef` vs. string vazia | `undef // ''` é verdadeiro, `undef \|\| ''` também | Use `//` para verificar definição, `\|\|` para verificar veracidade |
| Modificação de `$_` em um loop aninhado | Clobbers o `$_` externo | Sempre use variável nomeada: `for my $x (@list)` |
| `local/` ausente do `$PATH` | `carton exec` foi esquecido | Prefixe todos os comandos com `carton exec` |
| CRLF em scripts | Scripts falham dentro de containers | `.gitattributes` com `eol=lf` (ver [ADR-012](/adrs/ADR-012-estrutura-minima-de-projeto)) |
