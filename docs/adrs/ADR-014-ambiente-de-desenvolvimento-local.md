# ADR-014: Ambiente de Desenvolvimento Local

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

Desenvolvedores precisam de uma versão específica de Perl (5.42) instalada
localmente sem interferir no Perl do sistema operacional — que frequentemente está
desatualizado, é gerenciado pelo SO e não deve ser modificado. A equipe pode trabalhar
em Linux, macOS e Windows, e cada plataforma tem seu próprio mecanismo de gerenciamento
de versões Perl.

Adicionalmente, o ambiente local deve ser o mais próximo possível do ambiente de
produção (containers Docker/Kubernetes) para satisfazer o fator X da metodologia
12-factor (paridade entre dev e produção).

## Decisão

Três caminhos suportados, em ordem crescente de paridade com produção:

| Plataforma | Ferramenta |
|-----------|-----------|
| Linux / macOS | **perlbrew** |
| Windows | **berrybrew** (gerencia versões do Strawberry Perl) |
| Qualquer plataforma | **Docker Compose** (ambiente 100% idêntico à produção) |

O Docker Compose com a imagem de desenvolvimento é a opção recomendada para paridade
máxima. As ferramentas nativas (perlbrew/berrybrew) são adequadas para quem prefere
um Perl instalado diretamente no sistema.

## Justificativa

**perlbrew** (Linux/macOS): gerenciador de versões Perl mais maduro e documentado para
sistemas Unix. Instala o Perl compilado em `~/perl5/perlbrew/` sem requerer `sudo`,
permite múltiplas versões simultâneas e não interfere no Perl do SO.

**berrybrew** (Windows): tradução do conceito do perlbrew para Windows. Gerencia versões
do Strawberry Perl — a distribuição Perl para Windows que inclui compilador C (MinGW)
e as ferramentas necessárias para o CPAN, o que é obrigatório para instalar módulos
XS como `DBD::Pg`.

**Docker Compose**: a opção que elimina diferenças de plataforma completamente. O
desenvolvedor executa exatamente o mesmo binário de Perl da produção, com as mesmas
dependências do sistema, dentro de um container Linux. Resolve o problema de CRLF/LF
entre Windows e Linux e garante paridade total com os Pods do Kubernetes.

Referências: [Perlbrew](../references/perlbrew.md),
[berrybrew](../references/berrybrew.md),
[Docker](../references/docker.md),
[The Twelve-Factor App](../references/twelve-factor-app.md)

### Setup com perlbrew (Linux/macOS)

```bash
# Instalar o perlbrew
# (\curl: barra invertida bypassa aliases do shell, garante o binário real)
\curl -L https://install.perlbrew.pl | bash

# Inicializar (adicionar ao shell profile)
source ~/perl5/perlbrew/etc/bashrc

# Instalar o Perl na versão mínima do stack
# --notest pula o suite de testes do interpretador (adequado para dev)
perlbrew --notest install perl-5.42.2
perlbrew switch perl-5.42.2

# Verificar
perl -v

# Instalar o cpanm e depois o Carton
perlbrew install-cpanm
cpanm --notest Carton
```

### Setup com berrybrew (Windows)

O berrybrew original (`dnmfarrell/berrybrew`) teve sua manutenção transferida para
Steve Bertrand — **`stevieb9/berrybrew`** é o repositório oficial e ativamente mantido
hoje; o próprio README do repositório original aponta para lá. Use sempre
`stevieb9/berrybrew` como fonte de instalação.

A instalação não é feita via `cpanm`/CPAN (berrybrew gerencia o próprio Perl, então
não pode depender de um Perl já instalado). Duas formas suportadas:

```powershell
# Opção A — instalador (mais simples): baixar e executar berrybrewInstaller.exe
# a partir de https://github.com/stevieb9/berrybrew

# Opção B — clonar o repositório e configurar o PATH manualmente
# (execute como Administrador — berrybrew precisa alterar o PATH de sistema)
git clone https://github.com/stevieb9/berrybrew
cd berrybrew
bin\berrybrew.exe config

# Atualizar e listar versões disponíveis do Strawberry Perl
# (fetch é necessário — o cache local de versões geralmente está desatualizado
# numa instalação nova e não mostra versões recentes sem essa atualização)
berrybrew fetch
berrybrew available

# Instalar a versão escolhida
berrybrew install 5.42.2_64

# Ativar
berrybrew switch 5.42.2_64

# Verificar
perl -v

# Instalar Carton — --notest evita que a suíte de testes de uma dependência
# transitiva (ex.: Parse::PMFile) bloqueie a instalação por falhas do ambiente
cpanm --notest Carton
```

### Setup com Docker Compose (recomendado para paridade máxima)

```yaml
# docker-compose.yml (fragmento do serviço de desenvolvimento)
services:
  app:
    build:
      context: .
      target: build          # usa o estágio de build com compiladores
    volumes:
      - .:/app               # monta o código local no container
    environment:
      # Em desenvolvimento, um único usuário privilegiado serve ambas as conexões.
      # Em produção, myapp_app (DML) e myapp_migrate (DDL) são usuários distintos — ver ADR-016.
      # POSTGRESQL_APP_URL nunca carrega credencial (ver Revisão 2026-07-04 da ADR-016)
      - POSTGRESQL_APP_URL=postgresql://postgres:5432/myapp
      - POSTGRESQL_APP_USERNAME=myapp
      - POSTGRESQL_APP_PASSWORD=dev_password
      - POSTGRESQL_APP_MIGRATION_USERNAME=myapp
      - POSTGRESQL_APP_MIGRATION_PASSWORD=dev_password
    ports:
      - "3000:3000"
    command: carton exec perl script/my_app.pl daemon --listen http://*:3000

  postgres-app:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB:       myapp
      POSTGRES_USER:     postgres
      POSTGRES_PASSWORD: postgres_dev
```

Filas (jobs internos via Minion e eventos multi-consumidor via PgQue, ver
ADR-022/ADR-023) usam instâncias PostgreSQL próprias (`db-jobs`/`db-events`) —
omitidas deste fragmento por brevidade; ver o `compose.yml` completo da Stega
(ADR-018) para o exemplo com as quatro instâncias.

```bash
# Iniciar o ambiente completo
docker compose up

# Rodar testes dentro do container
docker compose exec app carton exec prove -lr t/
```

### Atenção ao CRLF no Windows

Ao usar Docker em Windows com containers Linux, arquivos com quebras de linha CRLF
(padrão Windows) causam erros em scripts shell e Perl executados dentro do container.
Configurar o Git para não converter automaticamente:

```bash
git config --global core.autocrlf false
```

E adicionar ao repositório um `.gitattributes`:

```
* text=auto eol=lf
*.pl text eol=lf
*.pm text eol=lf
*.t  text eol=lf
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| Perl do sistema operacional | Versão frequentemente desatualizada (ex.: macOS vem com Perl 5.18); modificar o Perl do SO é arriscado e não recomendado |
| `plenv` (Unix) | Alternativa ao perlbrew com conceito similar (inspirado no pyenv/rbenv); funcional, mas com menor documentação no ecossistema Perl |
| Docker-only sem perlbrew/berrybrew | Válido, mas impede workflows sem Docker (edição rápida, scripts isolados) |

## Consequências

**Positivo**:
- Desenvolvedores têm a versão exata de Perl declarada no stack
- Ambiente isolado não afeta o Perl do sistema
- Docker Compose provê todos os serviços de apoio (as instâncias PostgreSQL,
  Keycloak) localmente

**Negativo**:
- Setup inicial tem algumas etapas (perlbrew/berrybrew requerem configuração do shell)
- No Windows sem Docker, módulos XS exigem que o Strawberry Perl esteja corretamente
  configurado com o compilador C do MinGW
- **Revisão 2026-07-08**: independente de módulos XS, o worker do Minion
  (`carton exec perl script/stega minion worker`, ADR-008) não roda em Windows
  nativo sob nenhuma circunstância — `Minion.pm::worker()` recusa operar
  (`croak 'Minion workers do not support fork emulation'`) em qualquer Perl com
  `$Config{d_pseudofork}` verdadeiro (Strawberry/berrybrew usam fork emulado via
  ithreads, sem `fork()` real do SO). Confirmado ao validar a migração da
  ADR-022 em ambiente nativo — não é causado por ela, é uma restrição do
  próprio Minion, presente desde a adoção original na ADR-008. Único processo
  da Stega com essa exceção: os demais (`script/stega daemon`, `script/worker`,
  `script/pgque_ticker`, scripts de `eng/`) rodam nativamente sem ressalva.
  Requer Caminho C (Docker Compose) ou WSL2 especificamente para esse processo;
  testes que dependem dele (`t/030_webhooks.t`, `t/070_notifications.t`) se
  autodescartam nesse ambiente com `plan skip_all => ... if
  $Config{d_pseudofork}`. Resolver isso de vez (não só contornar) é pendência
  registrada na [ADR-024](ADR-024-jobs-assincronos-multiplataforma.md)
  (`Proposta`, sem decisão ainda)

**Ações necessárias**:
- Criar guia de configuração do ambiente local (Guia 1 da trilha de documentação)
- Documentar a versão mínima de Perl (`requires 'perl', '5.042'` no `cpanfile`)
- Incluir `.gitattributes` no repositório para garantir LF em todos os SO
