---
sidebar_position: 3
title: Carton + cpanm
---

# Carton + cpanm

> **Decisão**: Carton como gerenciador de dependências com snapshot de versões;
> cpanm como motor de instalação.
> [ADR-005 — Gerenciamento de Dependências](/adrs/ADR-005-gerenciamento-de-dependencias)

---

## Por que Carton

O Carton faz pelo Perl o que o Bundler faz pelo Ruby e o npm faz pelo Node.js:
declara, isola e congela dependências. O `cpanfile.snapshot` garante que uma
imagem Docker construída hoje com as mesmas versões exatas do `snapshot` produz
um ambiente idêntico ao construído há seis meses — sem surpresas de atualização
implícita de dependências transitivas.

O `cpanm` (App::cpanminus) substitui o legado `cpan`: é silencioso por padrão,
não requer configuração inicial e é significativamente mais rápido. O Carton o
usa internamente.

---

## Comandos essenciais

```bash
# Instalar todas as dependências (lê cpanfile, gera/atualiza snapshot)
carton install

# Instalar somente o que está no snapshot — modo deployment (CI/Docker)
carton install --deployment

# Executar qualquer comando usando os módulos do Carton (em local/)
carton exec perl script/stega daemon
carton exec perl script/stega routes
carton exec prove -lr t/
carton exec hypnotoad script/stega

# Verificar se o snapshot está atualizado com o cpanfile
carton check

# Ver todas as dependências instaladas
carton list

# Atualizar uma dependência para a versão mais recente (atualiza snapshot)
carton update Some::Module
```

---

## Anatomia do cpanfile

```perl
# cpanfile — manifesto de dependências da Stega

# Versão mínima de Perl — validada pelo Carton em todo carton install
requires 'perl', '5.042';

# Produção — sempre presentes na imagem final
requires 'Mojolicious',                  '9.0';
requires 'Mojolicious::Plugin::OpenAPI', '5.0';
requires 'Mojo::Pg',                     '4.0';
requires 'Moo',                          '2.0';
requires 'namespace::clean';
requires 'Crypt::JWT';
requires 'Mojo::RabbitMQ::Client';
requires 'Net::AMQP::RabbitMQ';
requires 'Minion';
requires 'Minion::Backend::Pg';

# Apenas em testes — não incluídas na imagem de produção
on 'test' => sub {
    requires 'Test::More';
    requires 'Test::MockObject';
    requires 'Devel::Cover';
};

# Apenas em desenvolvimento local — não no CI nem na imagem
on 'develop' => sub {
    requires 'Perl::Critic';
};
```

---

## O que commitar e o que ignorar

| Arquivo/Diretório | Git | Razão |
|------------------|-----|-------|
| `cpanfile` | ✅ commitar | manifesto de dependências declaradas |
| `cpanfile.snapshot` | ✅ commitar | congela versões exatas — reprodutibilidade |
| `local/` | ❌ ignorar | módulos compilados; específicos do SO e do Perl |

`.gitignore` deve ter:
```gitignore
local/
```

---

## Adicionando uma nova dependência

```bash
# 1. Declarar no cpanfile
echo "requires 'Email::MIME';" >> cpanfile

# 2. Instalar e atualizar o snapshot
carton install

# 3. Verificar que o snapshot foi atualizado
git diff cpanfile.snapshot   # mostra a nova entrada

# 4. Commitar os dois arquivos juntos
# (o usuário faz o commit — a IA sugere apenas a mensagem)
```

---

## Uso no Docker — multi-stage build

O multi-stage build usa o Carton no estágio de build (com compilador C para
módulos XS como `DBD::Pg`) e copia apenas `local/` para a imagem de produção:

```dockerfile
# ── Estágio de build ─────────────────────────────────────────────────────────
FROM perl:5.42 AS build

WORKDIR /app

# Instalar Carton globalmente neste estágio
RUN cpanm --notest Carton

# Cache de layer: copiar apenas arquivos de dependência primeiro
COPY cpanfile cpanfile.snapshot ./

# Instalar exatamente as versões do snapshot (sem rede desnecessária em rebuild)
RUN carton install --deployment

# ── Estágio de produção ───────────────────────────────────────────────────────
FROM perl:5.42-slim AS production

WORKDIR /app

# Copiar apenas os módulos compilados
COPY --from=build /app/local ./local

# Copiar o código da aplicação
COPY . .

EXPOSE 8080
CMD ["carton", "exec", "hypnotoad", "-f", "script/stega"]
```

**Por que copiar `cpanfile` e `cpanfile.snapshot` antes do código?** O Docker
invalida o cache de layer a partir da primeira mudança. Se o código mudar mas as
dependências não, o `RUN carton install` usa o cache e o build é instantâneo.

---

## --deployment: a flag mais importante em CI

```bash
# Em ambiente de desenvolvimento — resolve dependências e atualiza snapshot
carton install

# Em CI e Docker — usa APENAS o snapshot, recusa instalar versões diferentes
carton install --deployment
```

A flag `--deployment` garante que o ambiente de CI e a imagem Docker são
*exatamente* o que foi testado localmente. Sem ela, uma versão nova publicada
no CPAN pode entrar silenciosamente no ambiente de produção.

---

## Integração com GitHub Actions

```yaml
# .github/workflows/ci.yml
- name: Instalar Carton
  run: cpanm --notest Carton

- name: Instalar dependências (modo deployment)
  run: carton install --deployment

- name: Rodar testes
  run: carton exec prove -lr t/
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `cpanm Some::Module` direto | Instala globalmente, não entra no `cpanfile` nem no snapshot | Sempre declare no `cpanfile` e rode `carton install` |
| `carton exec` omitido | Perl usa módulos do sistema (versões erradas ou ausentes) | Prefixe todo `perl`, `prove`, `hypnotoad` com `carton exec` |
| `local/` commitado | Binários compilados são específicos do SO — causam falhas entre plataformas | Mantenha `local/` no `.gitignore` |
| Snapshot desatualizado | Desenvolvedor rodou `cpanm` direto e o snapshot não reflete o estado real | `carton check` detecta divergência; resolva com `carton install` |
| Módulo XS falha no build | Compilador C ausente na imagem de produção (`perl:5.42-slim` não tem `gcc`) | XS só é compilado no estágio `build`; apenas `local/` vai para produção |
