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
cpanm Carton
```

### Setup com berrybrew (Windows)

```powershell
# Instalar o berrybrew (via repositório GitHub ou instalador)
# https://github.com/dnmfarrell/berrybrew

# Listar versões disponíveis do Strawberry Perl
berrybrew available

# Instalar a versão escolhida
berrybrew install 5.42.2_64

# Ativar
berrybrew switch 5.42.2_64

# Verificar
perl -v

# Instalar Carton
cpanm Carton
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
      - POSTGRESQL_URL=postgresql://myapp:dev_password@postgres/myapp
      - POSTGRESQL_MIGRATION_URL=postgresql://myapp:dev_password@postgres/myapp
      - RABBITMQ_HOST=rabbitmq
      - RABBITMQ_USER=guest
      - RABBITMQ_PASSWORD=guest
    ports:
      - "3000:3000"
    command: carton exec perl script/my_app.pl daemon --listen http://*:3000

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB:       myapp
      POSTGRES_USER:     myapp
      POSTGRES_PASSWORD: dev_password

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "15672:15672"    # Management UI para desenvolvimento
```

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
- Docker Compose provê todos os serviços de apoio (PostgreSQL, RabbitMQ) localmente

**Negativo**:
- Setup inicial tem algumas etapas (perlbrew/berrybrew requerem configuração do shell)
- No Windows sem Docker, módulos XS exigem que o Strawberry Perl esteja corretamente
  configurado com o compilador C do MinGW

**Ações necessárias**:
- Criar guia de configuração do ambiente local (Guia 1 da trilha de documentação)
- Documentar a versão mínima de Perl (`requires 'perl', '5.042'` no `cpanfile`)
- Incluir `.gitattributes` no repositório para garantir LF em todos os SO
