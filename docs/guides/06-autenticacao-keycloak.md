---
sidebar_position: 6
title: "Guia 6 — Autenticação com Keycloak"
---

# Guia 6 — Autenticação Stateless com Keycloak e JWT

> **Referência arquitetural**:
> [ADR-009 — Autenticação e Identidade Keycloak + JWT](/adrs/ADR-009-autenticacao-keycloak-jwt)

---

## O que você vai construir

Ao final deste guia você terá:

- Login web via Keycloak (fluxo OIDC authorization code), com sessão de cookie
- Rotas de API protegidas por JWT Bearer, validado localmente via JWKS — sem chamada
  de rede ao Keycloak a cada requisição
- Sincronização automática do usuário no banco local no primeiro login
- Um modo de desenvolvimento que dispensa o Keycloak rodando, usando tokens HS256

---

## Pré-requisitos

- [Guia 5](/guides/banco-de-dados-e-migrations) concluído (tabela `users` já existe)
- Keycloak **26.6** rodando (`docker compose up -d keycloak` — ver Guia 1) — opcional
  para este guia; a maior parte pode ser seguida só com `TEST_JWT_SECRET`
- `Crypt::JWT` **0.034+** no `cpanfile`

---

## Por que dois fluxos diferentes

A Stega tem duas superfícies — interface web (navegador, sessão de cookie) e API REST
(cliente programático, sem cookie). Ambas terminam validando o mesmo JWT, mas chegam
até ele de formas diferentes:

```
Web:  Login no Keycloak → redirect com code → troca code por token → sessão de cookie
API:  Cliente já tem um token → Authorization: Bearer <token> → validação direta
```

O ponto em comum, e o motivo da ADR-009: **validação local via JWKS**. A API baixa a
chave pública do Keycloak uma vez (cacheada por processo) e valida qualquer token
sem chamar o Keycloak de novo — essencial para não transformar o Keycloak num ponto
único de falha síncrono a cada requisição, e para manter os workers do Hypnotoad
stateless (fator VI do 12-factor).

---

## Passo 1 — Variáveis de ambiente

```bash
# .env
KEYCLOAK_URL=http://localhost:8080            # servidor→servidor (JWKS, troca de token)
KEYCLOAK_FRONTEND_URL=http://localhost:8080    # visível pelo browser (redirects) — omitida se igual a KEYCLOAK_URL
KEYCLOAK_REALM=stega
KEYCLOAK_CLIENT_ID=stega-web
TEST_JWT_SECRET=test_secret_apenas_para_desenvolvimento
```

`KEYCLOAK_FRONTEND_URL` só é necessária quando `KEYCLOAK_URL` aponta para um hostname
que o browser não resolve (por exemplo, `http://keycloak:8080` via DNS interno do
Docker) — nesse caso os redirects enviados ao navegador precisam de uma URL diferente
da usada nas chamadas servidor→servidor.

---

## Passo 2 — Validação de JWT com cache de JWKS

```perl
# lib/Stega.pm (trecho)
use Crypt::JWT qw(decode_jwt);

my $jwks_cache;    # cache por processo — cada worker Hypnotoad carrega uma vez

sub _decode_jwt_token {
    my $token = shift;

    # Lê o alg do header sem validação criptográfica, só para decidir o caminho
    my ($hdr_b64) = split /\./, $token;
    $hdr_b64 =~ tr/-_/+\//;
    $hdr_b64 .= '=' x ((4 - length($hdr_b64) % 4) % 4);
    require MIME::Base64;
    require JSON::PP;
    my $alg = (JSON::PP::decode_json(MIME::Base64::decode_base64($hdr_b64)))->{alg} // '';

    if ($alg eq 'HS256') {
        my $secret = $ENV{TEST_JWT_SECRET}
            or die "TEST_JWT_SECRET não configurada para token HS256";
        return decode_jwt(token => $token, key => $secret, accepted_alg => 'HS256');
    }

    # RS256/RS384/RS512: busca a chave pública via JWKS do Keycloak (cache por processo)
    unless ($jwks_cache) {
        my $keycloak_url = $ENV{KEYCLOAK_URL} or die "KEYCLOAK_URL não configurada";
        my $realm        = $ENV{KEYCLOAK_REALM} // 'stega';

        require Mojo::UserAgent;
        $jwks_cache = Mojo::UserAgent->new
            ->get("$keycloak_url/realms/$realm/protocol/openid-connect/certs")
            ->result->json;
    }

    my ($jwk) = grep { ($_->{use} // '') eq 'sig' } @{$jwks_cache->{keys} // []};
    $jwk //= ($jwks_cache->{keys} // [])->[0];
    die "Nenhuma chave encontrada no JWKS do Keycloak" unless $jwk;

    return decode_jwt(
        token        => $token,
        key          => $jwk,
        accepted_alg => ['RS256', 'RS384', 'RS512'],
    );
}
```

Dois algoritmos, dois caminhos: `HS256` (segredo simétrico, só para desenvolvimento
sem Keycloak) e `RS256`/variantes (chave pública assimétrica, o que o Keycloak emite
de verdade). O helper que os Controllers usam:

```perl
$self->helper(verify_jwt => sub {
    my ($c, $token) = @_;
    my $claims = eval { _decode_jwt_token($token) };
    return (undef, "Token inválido: $@") if $@;
    return ($claims, undef);
});
```

---

## Passo 3 — Fluxo web: login, callback, logout

```perl
# lib/Stega/Controller/Auth.pm
sub login {
    my $c = shift;

    my $keycloak_url = $ENV{KEYCLOAK_FRONTEND_URL} // $ENV{KEYCLOAK_URL};
    my $realm        = $ENV{KEYCLOAK_REALM}         // 'stega';
    my $client_id    = $ENV{KEYCLOAK_CLIENT_ID}     // 'stega-web';
    my $redirect_uri = $c->url_for('/auth/callback')->to_abs;

    my $auth_url = Mojo::URL->new("$keycloak_url/realms/$realm/protocol/openid-connect/auth")
        ->query(
            client_id     => $client_id,
            redirect_uri  => $redirect_uri,
            response_type => 'code',
            scope         => 'openid profile email',
        );

    $c->redirect_to($auth_url);
}

sub callback {
    my $c = shift;

    my $code = $c->param('code') or return $c->redirect_to('/login');

    my $token_url = $ENV{KEYCLOAK_URL} . '/realms/' . ($ENV{KEYCLOAK_REALM} // 'stega')
        . '/protocol/openid-connect/token';

    my $tx = $c->ua->post($token_url => form => {
        grant_type    => 'authorization_code',
        code          => $code,
        redirect_uri  => $c->url_for('/auth/callback')->to_abs,
        client_id     => $ENV{KEYCLOAK_CLIENT_ID}     // 'stega-web',
        client_secret => $ENV{KEYCLOAK_CLIENT_SECRET} // '',
    });
    return $c->render(text => 'Falha ao trocar código por token', status => 502)
        unless $tx->res->is_success;

    # access_token (não id_token) contém realm_access.roles — o Keycloak não inclui
    # esse campo no id_token por padrão.
    my $access_token = $tx->res->json->{access_token} or return $c->redirect_to('/login');

    my ($claims, $err) = $c->verify_jwt($access_token);
    return $c->render(text => "Token inválido: $err", status => 401) if $err;

    my $user = _sync_user($c, $claims);
    $c->session(user_id => $user->{id}, user_role => $user->{role}, expires => time() + 3600);
    $c->redirect_to('/');
}

sub logout {
    my $c = shift;
    $c->session(expires => 1);

    my $keycloak_url = $ENV{KEYCLOAK_FRONTEND_URL} // $ENV{KEYCLOAK_URL};
    my $realm        = $ENV{KEYCLOAK_REALM} // 'stega';

    $c->redirect_to(
        Mojo::URL->new("$keycloak_url/realms/$realm/protocol/openid-connect/logout")
            ->query(
                client_id                => $ENV{KEYCLOAK_CLIENT_ID} // 'stega-web',
                post_logout_redirect_uri => $c->url_for('/login')->to_abs,
            )
    );
}
```

**Atenção ao `id_token` vs `access_token`**: um erro comum é montar a sessão a partir
do `id_token` — o Keycloak não inclui `realm_access.roles` nele por padrão. Sempre
decodifique o `access_token` para extrair papéis.

---

## Passo 4 — Sincronizar usuário no banco

```perl
sub _sync_user {
    my ($c, $claims) = @_;

    my $keycloak_id = $claims->{sub};
    my $roles       = ($claims->{realm_access} // {})->{roles} // [];
    my $role        = (grep { /^(admin|agent|customer)$/ } @$roles)[0] // 'customer';

    return $c->pg->db->query(
        q{INSERT INTO users (keycloak_id, email, display_name, role)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (keycloak_id) DO UPDATE
            SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, role = EXCLUDED.role
          RETURNING id, display_name, role},
        $keycloak_id,
        $claims->{email} // '',
        $claims->{preferred_username} // $claims->{name} // 'Usuário',
        $role,
    )->hash;
}
```

`ON CONFLICT ... DO UPDATE` torna isso um upsert idempotente — login repetido do
mesmo usuário atualiza os dados (nome, papel podem mudar no Keycloak) sem duplicar a
linha. `keycloak_id` é o identificador primário de usuário, não o e-mail — o e-mail
pode ser alterado no Keycloak e não tem `UNIQUE` na Stega por esse motivo.

---

## Passo 5 — Proteger rotas

Rotas web usam sessão de cookie; rotas de API usam o security handler do plugin
OpenAPI (detalhado no Guia 7):

```perl
# Web — under-route que checa a sessão
sub require_web_session {
    my $c = shift;
    my $user_id = $c->session('user_id');
    unless ($user_id) {
        $c->redirect_to('/login');
        return undef;
    }
    $c->stash(current_user => { id => $user_id, role => $c->session('user_role') // 'customer' });
    return 1;
}
```

```perl
# lib/Stega.pm — security handler do OpenAPI, roda em toda rota /api/v1/*
$self->plugin('OpenAPI', {
    url      => $self->home->child('api/stega.yaml'),
    security => {
        bearerAuth => sub {
            my ($c, $definition, $scopes, $cb) = @_;
            my $auth = $c->req->headers->authorization // '';
            my ($token) = ($auth =~ /^Bearer\s+(.+)$/i);
            return $c->$cb('Autenticação necessária') unless $token;

            my ($claims, $err) = $c->verify_jwt($token);
            return $c->$cb('Token inválido') if $err;

            my $role = ($claims->{realm_access} // {})->{roles}[0] // 'customer';
            $c->stash(current_user => { id => $claims->{sub}, role => $role });
            return $c->$cb(undef);
        }
    }
});
```

Ambos os caminhos terminam preenchendo `$c->stash('current_user')` com a mesma forma
— é o que `Stega::Domain::TicketPolicy` (Guia 4) consome, sem se importar por qual
caminho o usuário chegou.

---

## Passo 6 — Testar sem Keycloak rodando

Com `TEST_JWT_SECRET` definido, gere tokens HS256 diretamente:

```perl
use lib 't/lib';
use Stega::Test::Helper qw(make_jwt);

my $token = make_jwt(role => 'agent', sub => 'meu-id', email => 'eu@dev.local');
# Header: Authorization: Bearer $token
```

É assim que toda a suíte de testes automatizados (`t/*.t`) valida rotas protegidas
sem precisar de um Keycloak real em execução — e o mesmo mecanismo funciona contra
uma instância local do `script/stega daemon`, desde que `TEST_JWT_SECRET` esteja
definido **no mesmo processo/terminal que inicia o daemon** — sem isso, `_decode_jwt_token`
recusa qualquer token HS256 com "Token inválido" antes mesmo de comparar a assinatura.

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| `Token inválido` mesmo com token HS256 correto | `TEST_JWT_SECRET` não está definida no processo do `daemon` | `$env:TEST_JWT_SECRET = '...'` (PowerShell) antes de iniciar |
| Papéis (`roles`) vazios após login web | Decodificando o `id_token` em vez do `access_token` | Sempre use `access_token` para extrair `realm_access.roles` |
| Redirect do Keycloak não funciona em Docker | `KEYCLOAK_URL` interno (`http://keycloak:8080`) não resolve no browser | Defina `KEYCLOAK_FRONTEND_URL` separadamente |
| `Nenhuma chave encontrada no JWKS` | Realm errado ou Keycloak ainda inicializando | Confirme `KEYCLOAK_REALM` e aguarde o healthcheck do container |

---

## Próximos passos

Com autenticação funcionando nos dois fluxos, o próximo guia formaliza o contrato:

- **Guia 7 — Contrato de API OpenAPI v3**: validação automática de request/response,
  o `security: bearerAuth` que este guia já usou, e como o schema vira a fonte da
  verdade para o que a API aceita

Explore agora:
- [**ADR-009**](/adrs/ADR-009-autenticacao-keycloak-jwt): a decisão completa,
  incluindo o fluxo `client_credentials` para workers M2M e por que plugins
  `Mojolicious::Plugin::OAuth2`/`OIDC` foram avaliados e não adotados
