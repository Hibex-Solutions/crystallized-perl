# ADR-019: Cabeçalho Padrão de Código Perl

**Status**: Aceita
**Data**: 2026-07-01

## Contexto

Durante a implementação da Stega (ADR-018), surgiram inconsistências no cabeçalho dos
arquivos Perl do projeto: alguns scripts declaravam `use strict; use warnings; use
feature 'say';`, outros usavam `use v5.42;`, e a presença de `use utf8;` era
inconsistente. Essa última lacuna causou bugs reais de codificação de caracteres —
scripts em `eng/` que imprimem texto em português (com acentos e cedilha) para o
terminal produziam saída corrompida ou avisos `Wide character in print` quando
`use utf8;` estava ausente.

O projeto precisa de um padrão único e explícito para todo código Perl (`lib/`,
`eng/`, `t/`, `script/`), de forma que qualquer novo arquivo siga a mesma convenção
sem exigir decisão caso a caso — consistente com o princípio de "stack cohesion"
deste projeto (ver CLAUDE.md).

Dois pontos motivaram a decisão:

1. **`use v5.42;` já habilita `strict` e `warnings` implicitamente.** Desde o Perl
   5.36, uma declaração de versão via `use v5.XX;` (XX ≥ 36) ativa automaticamente
   `strict`, `warnings` e o pacote de features correspondente à versão (`say`,
   `signatures`, etc.) — tornando `use strict; use warnings;` redundante quando
   `use v5.42;` já está presente.
2. **`Mojo::Base` (com ou sem flag `-strict`) já ativa `strict`, `warnings`, `utf8`
   e um pacote de features (`:5.16`)** para qualquer pacote que o importe — o que
   cobre automaticamente todos os Controllers e a classe principal da aplicação
   Mojolicious. O problema de codificação nunca ocorreu nesses arquivos; ocorreu
   nos scripts `eng/*.pl` e em módulos `Moo` — nenhum dos dois herda esse
   comportamento de `Mojo::Base`.

## Decisão

**Todo arquivo Perl do projeto declara `use v5.42;` seguido de `use utf8;`** como
cabeçalho mínimo — exceto arquivos que já herdam esse comportamento de `Mojo::Base`
(ver exceção abaixo). Nenhuma dependência externa (`Modern::Perl` ou similar) é usada
para esse propósito.

### Regra 1 — Arquivos que **não** usam `Mojo::Base` (`eng/*.pl`, `lib/**/Model/*.pm`
com Moo puro, `lib/**/Job/*.pm`, `lib/**/Worker/*.pm`, `t/**/*.t`):

```perl
use v5.42;
use utf8;
```

`use utf8;` é obrigatório mesmo em arquivos `Moo`, porque `use Moo;` ativa `strict` e
`warnings` no pacote consumidor, mas **não** ativa `utf8`.

### Regra 2 — Qualquer processo que imprime para o terminal (`eng/*.pl`, `t/**/*.t`,
`t/lib/**/*.pm`, `script/*`):

Além da Regra 1, esses arquivos adicionam a camada de codificação de saída e
autoflush, já que `use utf8;` decodifica apenas os literais de string do
código-fonte — não afeta como `STDOUT`/`STDERR` codificam os bytes escritos, nem como
são bufferizados:

```perl
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
```

**Revisão 2026-07-02** — a versão original desta regra cobria só `eng/*.pl`. Na
primeira validação real em Windows nativo (berrybrew), `carton exec prove -lr t\`
produziu avisos `Wide character in print` constantes: os arquivos `t/*.t` carregam
Controllers com literais acentuados (`"Sem permissão"`, `"Não encontrado"`), e o
`Test2::Formatter::TAP` escreve isso no `STDOUT` do processo do teste — sem uma
camada de codificação declarada nesse `STDOUT`, o Perl avisa a cada string "wide"
impressa. A regra foi estendida para cobrir qualquer processo que imprime para o
terminal, não só scripts de engenharia — testes incluídos.

O mesmo episódio também expôs um problema de buffering: aplicar `:encoding(UTF-8)`
a um filehandle pode mudar seu modo de buffering (de por-linha para por-bloco) se
`$|` não estiver ligado, fazendo a saída ficar retida até o processo terminar —
visualmente parecendo que o comando "voltou o prompt antes de terminar". `$| = 1;`
(autoflush) elimina essa retenção.

### Regra 3 — Arquivos que herdam de `Mojo::Base` (Controllers, a classe principal
da aplicação — ex.: `use Mojo::Base 'Mojolicious::Controller', -strict;`):

Nenhuma linha adicional é necessária. `Mojo::Base` já aplica `strict`, `warnings`,
`utf8` e a feature bundle correspondente — acrescentar `use v5.42;` seria redundante
e não muda o comportamento em nenhum destes arquivos.

### Não usar `autodie`

`autodie` não faz parte do cabeçalho padrão. Scripts de `eng/` que fazem I/O de
arquivo podem adicioná-lo pontualmente quando fizer sentido (ver
[Alternativas Consideradas](#alternativas-consideradas)), mas não é uma exigência do
projeto.

Referências: [Mojolicious](../references/mojolicious.md),
[Perldoc: Guia de Estilo](../references/perldoc-perlstyle.md),
[Modern Perl: a Perl Tutorial](../references/modern-perl-book.md)

### Exemplo — script de engenharia (`eng/migrate.pl`)

```perl
#!/usr/bin/env perl
# eng/migrate.pl — aplica migrations pendentes ao banco
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;

use FindBin;
use lib "$FindBin::Bin/../lib";
use Mojo::Pg;

my $pg = Mojo::Pg->new(
    $ENV{POSTGRESQL_MIGRATION_URL}
        // 'postgresql://myapp_migrate:dev_password@localhost/myapp'
);

my $migrations = $pg->migrations->name('myapp')
    ->from_dir("$FindBin::Bin/../migrations");
$migrations->migrate;

say 'Migrations aplicadas com sucesso.';
say 'Versão atual: ' . $migrations->active;
```

### Exemplo — modelo de domínio (`lib/MyApp/Model/User.pm`)

```perl
package MyApp::Model::User;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

has id    => (is => 'ro');
has name  => (is => 'rw', required => 1);
has email => (is => 'rw', required => 1);

1;
```

### Exemplo — Controller (nenhuma mudança necessária)

```perl
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller', -strict;   # já cobre strict/warnings/utf8

sub show {
    my $c = shift;
    # ...
}

1;
```

## Justificativa

`use v5.42;` é a forma nativa do Perl (sem dependências externas) de declarar tanto a
versão mínima exigida quanto de habilitar `strict`/`warnings`/features — o mesmo
efeito que `Modern::Perl` oferece, mas usando apenas o core do interpretador.
Manter o cabeçalho no core evita que o projeto acumule uma dependência de CPAN
(`Modern::Perl`) unicamente para açúcar sintático de três linhas, e evita o
descompasso de manutenção entre o ciclo de releases do `Modern::Perl` e o do Perl
core em si (novas features do Perl frequentemente demoram para aparecer em
`Modern::Perl`).

`use utf8;` resolve diretamente o problema de codificação relatado durante a
implementação da Stega: sem essa pragma, literais de string com acentuação em
código-fonte UTF-8 (padrão de todo editor moderno) são interpretados como uma
sequência de bytes, não como texto Unicode — o que corrompe comparações, comprimento
de string e a saída impressa. `use open ':std', ':encoding(UTF-8)';` complementa isso
em qualquer processo que imprime para o terminal — scripts de `eng/`, testes,
`script/*` —, garantindo que a saída em `STDOUT`/`STDERR` seja codificada
corretamente independentemente do terminal do sistema operacional (relevante em
especial no Windows, onde o console nem sempre usa UTF-8 por padrão). `$| = 1;`
evita que essa mesma camada de codificação retenha a saída em buffer até o processo
terminar em vez de imprimi-la conforme é gerada.

A camada HTTP (Mojolicious) e a camada de banco (Mojo::Pg com
`pg_enable_utf8` — ver `Stega->_setup_database`) já tratam UTF-8 corretamente por
conta própria; o cabeçalho padrão cobre exatamente a lacuna que restava: literais de
string no código-fonte e saída de texto em scripts de linha de comando.

Referências: [Perldoc: Guia de Estilo](../references/perldoc-perlstyle.md),
[Mojolicious](../references/mojolicious.md)

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| `use Modern::Perl '2025';` | Adiciona uma dependência de CPAN só para agrupar pragmas que o core do Perl 5.42 já oferece nativamente via `use v5.42;`; descasa do ciclo de releases do Perl core |
| `use strict; use warnings;` explícitos (sem `use v5.42;`) | Redundante — `use v5.42;` já ativa ambos; manter as três linhas é ruído sem ganho, e não declara a versão mínima exigida pelo `cpanfile` |
| `use utf8;` opcional, decidido por arquivo | Foi exatamente essa inconsistência que causou os bugs de codificação relatados; um padrão implícito ("adicione quando lembrar") não é um padrão |
| `use autodie;` no cabeçalho padrão | Muda o comportamento de erro de funções built-in (`open`, `close`, etc.) para todo o projeto, incluindo Controllers que já tratam erros via `eval` e exceções do Mojo::Pg/Crypt::JWT com convenções próprias; adicionaria uma segunda convenção de tratamento de erro em paralelo. Uso pontual em scripts de `eng/` continua permitido |
| `use v5.42;` também em arquivos que usam `Mojo::Base` | Redundante — `Mojo::Base` já ativa `strict`, `warnings`, `utf8` e uma feature bundle; adicionar a linha não muda comportamento, apenas duplica informação |

## Consequências

**Positivo**:
- Elimina a classe de bug que motivou esta ADR (saída corrompida em `eng/*.pl`)
- Cabeçalho de duas linhas (ou três, em scripts que imprimem para o terminal) é fácil
  de lembrar e de revisar em code review
- Nenhuma dependência nova no `cpanfile`
- Consistente com o comportamento que `Mojo::Base` já aplica automaticamente —
  o padrão dos Controllers não muda

**Negativo**:
- Desenvolvedores precisam saber que arquivos com `Mojo::Base` são a exceção à Regra 1
  — documentado nesta ADR e reforçado nos guias
- `use v5.42;` força a versão mínima do interpretador em cada arquivo individualmente;
  se o mínimo do projeto mudar, cada arquivo precisa ser atualizado (mitigado por
  busca e substituição simples, já que o padrão é textual e uniforme)

**Ações necessárias**:
- Atualizar os exemplos de código em ADR-013 para usar `use v5.42;` no lugar de
  `use strict; use warnings; use feature 'say';`
- Aplicar o padrão retroativamente em todo o código da Stega (ADR-018): `eng/*.pl`,
  `lib/Stega/Model/*.pm`, `lib/Stega/Job/*.pm`, `lib/Stega/Worker/*.pm`
- Nenhuma mudança necessária em Controllers ou na classe principal da aplicação
  (já cobertos por `Mojo::Base`)
- Revisão 2026-07-02: estender a Regra 2 (`open ':std', ':encoding(UTF-8)'` +
  `$| = 1;`) para `t/*.t`, `t/lib/**/*.pm` e `script/*` — não só `eng/*.pl`
