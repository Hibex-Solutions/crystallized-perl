# ADR-013: Scripts de Engenharia em Perl

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Todo projeto de software acumula tarefas auxiliares que não fazem parte da aplicação
em si: aplicar migrations manualmente, popular o banco com dados de desenvolvimento,
gerar relatórios de cobertura, verificar configurações do ambiente, executar limpezas.
A abordagem padrão nessas situações costuma ser scripts shell (Bash no Unix/macOS,
PowerShell no Windows) — o que obriga a manter dois conjuntos de scripts para cobrir
todas as plataformas da equipe.

O stack Crystallized Perl já exige que toda a equipe conheça Perl. Usar Perl também
para as tarefas de engenharia elimina a necessidade de manter scripts duplicados e
mantém a equipe em um único ecossistema de ferramentas.

## Decisão

Scripts de engenharia do projeto residem em `eng/` e são escritos em **Perl**, com um
único ponto de entrada por script — sem wrapper `.ps1` por plataforma (ver
"Revisão 2026-07-01" abaixo):

```
eng/
├── migrate.pl       ← aplicar migrations pendentes
├── seed.pl          ← popular banco com dados de desenvolvimento
└── setup.pl         ← verificar e configurar o ambiente local
```

Todo script é invocado da mesma forma em qualquer sistema operacional:

```bash
carton exec perl eng/migrate.pl
```

### Revisão 2026-07-01 — remoção do wrapper `.ps1`

A versão original desta ADR previa um wrapper `eng/<script>.ps1` de três linhas por
script, delegando ao `.pl` correspondente, com o objetivo de dar ao Windows uma
ergonomia parecida com `./eng/migrate.pl` do Unix. Na prática, isso se mostrou uma
camada sem benefício real e com um risco concreto:

- O comando documentado e efetivamente usado no dia a dia (`DEVELOPMENT.md`, CI,
  `Dockerfile`, InitContainer do Kubernetes) sempre foi `carton exec perl eng/script.pl`
  — o mesmo comando em qualquer plataforma. O wrapper nunca era o caminho principal,
  apenas um atalho alternativo documentado "ou".
- `perl eng\migrate.pl` já funciona nativamente em qualquer shell do Windows
  (PowerShell ou `cmd.exe`) sem exigir wrapper algum — a suposta necessidade de
  paridade Unix/Windows não se sustenta, já que o Perl em si já é a camada
  multiplataforma.
- O wrapper implementado na Stega (`perl "$PSScriptRoot\migrate.pl" @args`) **não**
  prefixava `carton exec` — divergindo do comando documentado e do único caminho que
  garante o uso das dependências isoladas em `local/` (ver ADR-005). Um desenvolvedor
  que confiasse no wrapper por engano rodaria o script contra módulos globais do
  sistema, se existirem, produzindo comportamento não determinístico e difícil de
  diagnosticar.
- Cada script novo exige manter dois arquivos sincronizados manualmente (`.pl` e
  `.ps1`), dobrando o número de arquivos em `eng/` sem dobrar a funcionalidade.

**Decisão revisada**: eliminar o padrão de wrapper `.ps1`. Todo script de engenharia
tem um único arquivo `.pl`, sempre invocado com `carton exec perl eng/<script>.pl` —
comando idêntico em Linux, macOS e Windows.

## Justificativa

### Perl como linguagem de scripts de engenharia

Usar Perl nos scripts de engenharia tem quatro vantagens diretas para o stack:

1. **Único ecossistema**: desenvolvedores que conhecem Perl para a aplicação conhecem
   Perl para os scripts. Sem contexto de switching entre linguagens.
2. **Acesso nativo ao stack**: scripts podem usar `Mojo::Pg` para migrations, `Moo`
   para lógica de setup, o mesmo `cpanfile` de dependências. Não há wrapper de shell
   intermediando chamadas à aplicação.
3. **Portabilidade real**: Perl roda em Linux, macOS e Windows (via Strawberry Perl)
   com o mesmo código — a necessidade de wrapper PowerShell é apenas de ponto de
   entrada, não de lógica.
4. **Testável**: scripts Perl podem ser testados com `Test::More` como qualquer outro
   módulo, se necessário.

### Shebang portável

O shebang obrigatório em todos os scripts `.pl` de `eng/`:

```perl
#!/usr/bin/env perl
```

`/usr/bin/env perl` resolve o `perl` ativo no `PATH` — ou seja, a versão gerenciada
pelo perlbrew ou berrybrew do desenvolvedor, não o Perl do sistema operacional. Isso
garante que o script sempre rode com a versão declarada em `cpanfile`.

**Pré-requisito**: o desenvolvedor deve ter ativado a versão correta antes de executar
scripts (`perlbrew switch` ou `berrybrew switch`). Este requisito é documentado em
`DEVELOPMENT.md` (ver ADR-012).

### Cabeçalho padrão

Todo script em `eng/` segue o cabeçalho definido em ADR-019 — `use v5.42;` habilita
`strict`/`warnings` implicitamente, `use open ':std', ':encoding(UTF-8)';` garante
que a saída impressa em `STDOUT`/`STDERR` seja codificada corretamente em qualquer
terminal, e `$| = 1;` desliga o buffering dessa saída (sem isso, a camada de
`:encoding` pode reter a saída em bloco até o processo terminar em vez de
imprimi-la conforme é gerada):

```perl
use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
```

### Exemplo: script de migration

O script usa `POSTGRESQL_APP_MIGRATION_USERNAME`/`_PASSWORD` (credencial DDL, com
privilégios de CREATE/ALTER/DROP) e delega ao `Mojo::Pg::Migrations->from_dir`
nativo — nenhum loader customizado (ver ADR-016 para a convenção de diretórios,
separação de credenciais e o formato explícito de variáveis — Revisão 2026-07-04):

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
use Mojo::URL;

my $conn = Mojo::URL->new($ENV{POSTGRESQL_APP_URL} // 'postgresql://localhost:5432/db-app');
$conn->userinfo(($ENV{POSTGRESQL_APP_MIGRATION_USERNAME} // 'myapp_migrate') . ':'
    . ($ENV{POSTGRESQL_APP_MIGRATION_PASSWORD} // 'dev_password'));

my $pg = Mojo::Pg->new($conn);

my $migrations = $pg->migrations->name('myapp')
    ->from_dir("$FindBin::Bin/../migrations");
$migrations->migrate;

say 'Migrations aplicadas com sucesso.';
say 'Versão atual: ' . $migrations->active;
```

### Exemplo: script de seed (dados de desenvolvimento)

```perl
#!/usr/bin/env perl
# eng/seed.pl — popula o banco com dados para desenvolvimento local

use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;
use lib 'lib';
use Mojo::Pg;
use Mojo::URL;

my $conn = Mojo::URL->new($ENV{POSTGRESQL_APP_URL} // 'postgresql://localhost:5432/db-app');
$conn->userinfo(($ENV{POSTGRESQL_APP_USERNAME} // 'myapp_app') . ':'
    . ($ENV{POSTGRESQL_APP_PASSWORD} // 'dev_password'));

my $pg = Mojo::Pg->new($conn);

my $db = $pg->db;

# Idempotente: não insere se já existir
my $count = $db->query('SELECT COUNT(*) AS n FROM users')->hash->{n};
if ($count > 0) {
    say "Banco já populado ($count usuários). Nenhuma ação necessária.";
    exit 0;
}

$db->query(
    'INSERT INTO users (email, name, role) VALUES (?, ?, ?)',
    'admin@example.com', 'Administrador', 'admin'
);

say 'Dados de desenvolvimento inseridos.';
```

### Exemplo: script de verificação de ambiente

```perl
#!/usr/bin/env perl
# eng/setup.pl — verifica se o ambiente local está configurado corretamente

use v5.42;
use utf8;
use open ':std', ':encoding(UTF-8)';
$| = 1;

my @checks = (
    [ 'Perl >= 5.42'   => sub { $] >= 5.042 } ],
    [ 'Carton'         => sub { scalar(`carton --version 2>&1`) && !$? } ],
    [ 'Docker'         => sub { scalar(`docker info 2>&1`)     && !$? } ],
    [ 'POSTGRESQL_APP_URL' => sub { defined $ENV{POSTGRESQL_APP_URL} } ],
);

my $ok = 1;
for my $check (@checks) {
    my ($name, $fn) = @$check;
    if ($fn->()) {
        say "  [OK] $name";
    } else {
        say "  [FALHA] $name";
        $ok = 0;
    }
}

exit($ok ? 0 : 1);
```

### Convenções de nomenclatura

| Convenção | Exemplo |
|-----------|---------|
| Nome em kebab-case | `eng/generate-report.pl` |
| Verbo no nome (ação clara) | `migrate`, `seed`, `setup`, `check`, `generate` |
| Idempotente quando possível | re-executar sem efeitos colaterais indesejados |
| Saída informativa no stdout | `say "Ação concluída."` |
| Erros em stderr + exit não-zero | `warn "Erro: ..."; exit 1` |

### Localização em `eng/`

O diretório `eng/` não conflita com nenhuma convenção da comunidade Perl:

- `lib/` — módulos da aplicação (convenção padrão CPAN/Perl)
- `script/` — ponto de entrada Mojolicious (convenção Mojolicious)
- `t/` — testes (convenção padrão Perl)
- `bin/` — executáveis instaláveis (convenção CPAN, para módulos distribuídos)
- `eng/` — scripts de engenharia do projeto (sem conflito, análogo ao `script/` de outros ecossistemas)

Scripts em `eng/` **não são instalados** pelo CPAN/Carton — são ferramentas internas
do projeto, não da distribuição.

Referências: [Perlbrew](../references/perlbrew.md),
[berrybrew](../references/berrybrew.md),
[The Twelve-Factor App](../references/twelve-factor-app.md),
[Mojolicious](../references/mojolicious.md)

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Bash + PowerShell paralelos** | Duplica a lógica; Bash não roda nativamente no Windows sem WSL; PowerShell não roda nativamente no Linux sem instalação adicional |
| **Makefile** | Requer `make` instalado (ausente por padrão no Windows); sintaxe não familiar para equipes Perl-first; não aproveita o ecossistema da stack |
| **npm scripts (package.json)** | Introduz Node.js como dependência de ferramentas sem nenhum benefício; inconsistente com a stack Perl |
| **Scripts em `script/`** | Misturaria scripts de aplicação (Mojolicious) com scripts de engenharia; convenção Mojolicious espera apenas o ponto de entrada da app em `script/` |
| **Docker exec como wrapper** | Requer Docker em execução para tarefas que poderiam ser locais; dificulta uso em ambientes de CI sem Docker-in-Docker |
| **Wrapper `.ps1` por script (decisão original desta ADR)** | Nunca foi o caminho documentado como principal; o wrapper implementado na Stega divergiu do comando real (`carton exec perl eng/script.pl`) por omitir `carton exec`, mascarando o uso de dependências fora de `local/`; dobra o número de arquivos em `eng/` sem ganho de portabilidade, já que `perl eng\script.pl` já funciona nativamente em qualquer shell do Windows — ver "Revisão 2026-07-01" |

## Consequências

**Positivo**:
- Uma única linguagem (Perl) cobre aplicação e automação de engenharia
- Um único arquivo por script — não há dois arquivos para manter sincronizados
- Scripts são testáveis com o mesmo framework de testes da aplicação
- `DEVELOPMENT.md` pode documentar todos os scripts em um único lugar, com um único
  comando de invocação válido em qualquer plataforma

**Negativo**:
- Scripts que usam módulos da aplicação (`use lib 'lib'`) precisam ser executados
  da raiz do repositório

**Ações necessárias**:
- Criar `eng/migrate.pl` e `eng/setup.pl` como scripts iniciais do projeto
- Documentar os scripts disponíveis em `DEVELOPMENT.md` (ver ADR-012), sempre com o
  comando `carton exec perl eng/<script>.pl`
- Garantir que scripts em `eng/` tenham permissão de execução (`chmod +x`)
  nos sistemas Unix — isso pode ser configurado no Git com `git update-index --chmod=+x`
