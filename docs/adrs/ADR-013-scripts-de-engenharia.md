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

Scripts de engenharia do projeto residem em `eng/` e são escritos em **Perl**:

- **Linux / macOS**: scripts executados diretamente via `shebang`
- **Windows (PowerShell)**: wrapper `.ps1` que delega ao script `.pl` correspondente

A estrutura de arquivos segue a convenção:

```
eng/
├── migrate.pl       ← aplicar migrations pendentes
├── migrate.ps1      ← wrapper Windows para migrate.pl
├── seed.pl          ← popular banco com dados de desenvolvimento
├── seed.ps1
├── setup.pl         ← verificar e configurar o ambiente local
└── setup.ps1
```

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

### Wrapper PowerShell

O wrapper `.ps1` é minimalista: apenas delega ao script `.pl`, passando todos os
argumentos recebidos:

```powershell
# eng/migrate.ps1
# Wrapper Windows: delega ao script Perl correspondente
perl "$PSScriptRoot\migrate.pl" @args
```

`$PSScriptRoot` garante que o caminho seja absoluto independentemente de onde o
usuário está no terminal. `@args` repassa todos os argumentos sem modificação.

### Exemplo: script de migration

O script usa `POSTGRESQL_MIGRATION_URL` (credencial DDL, com privilégios de CREATE/ALTER/DROP)
e carrega todos os arquivos `migrations/*.sql` em ordem lexicográfica via `Mojo::File`
(ver ADR-016 para a convenção de múltiplos arquivos e separação de credenciais):

```perl
#!/usr/bin/env perl
# eng/migrate.pl — aplica migrations pendentes ao banco

use v5.42;
use lib 'lib';
use Mojo::File qw(path);
use Mojo::Pg;

my $pg = Mojo::Pg->new(
    $ENV{POSTGRESQL_MIGRATION_URL}
        // 'postgresql://myapp_migrate:dev_password@localhost/myapp'
);

# Carrega e concatena todos os arquivos .sql em ordem lexicográfica
my $sql = path('migrations')->list
    ->grep(sub { /\.sql$/ })
    ->sort
    ->map(sub  { $_->slurp })
    ->join("\n");

$pg->migrations->name('myapp')->from_string($sql)->migrate;

say 'Migrations aplicadas com sucesso.';
say 'Versão atual: ' . $pg->migrations->version;
```

### Exemplo: script de seed (dados de desenvolvimento)

```perl
#!/usr/bin/env perl
# eng/seed.pl — popula o banco com dados para desenvolvimento local

use v5.42;
use lib 'lib';
use Mojo::Pg;

my $pg = Mojo::Pg->new(
    $ENV{POSTGRESQL_URL} // 'postgresql://myapp_app:dev_password@localhost/myapp'
);

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

my @checks = (
    [ 'Perl >= 5.42'   => sub { $] >= 5.042 } ],
    [ 'Carton'         => sub { scalar(`carton --version 2>&1`) && !$? } ],
    [ 'Docker'         => sub { scalar(`docker info 2>&1`)     && !$? } ],
    [ 'POSTGRESQL_URL' => sub { defined $ENV{POSTGRESQL_URL} } ],
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
| Wrapper com mesmo nome | `eng/generate-report.ps1` |
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

## Consequências

**Positivo**:
- Uma única linguagem (Perl) cobre aplicação e automação de engenharia
- Wrapper `.ps1` é trivial (3 linhas) — não há lógica duplicada
- Scripts são testáveis com o mesmo framework de testes da aplicação
- `DEVELOPMENT.md` pode documentar todos os scripts em um único lugar

**Negativo**:
- Desenvolvedores Windows precisam lembrar de usar o wrapper `.ps1` em vez de chamar
  o `.pl` diretamente (embora `perl eng\script.pl` também funcione no PowerShell)
- Scripts que usam módulos da aplicação (`use lib 'lib'`) precisam ser executados
  da raiz do repositório

**Ações necessárias**:
- Criar `eng/migrate.pl` e `eng/migrate.ps1` como scripts iniciais do projeto
- Criar `eng/setup.pl` e `eng/setup.ps1` para verificação do ambiente
- Documentar os scripts disponíveis em `DEVELOPMENT.md` (ver ADR-012)
- Garantir que scripts em `eng/` tenham permissão de execução (`chmod +x`)
  nos sistemas Unix — isso pode ser configurado no Git com `git update-index --chmod=+x`
