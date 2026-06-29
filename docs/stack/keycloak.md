---
sidebar_position: 8
title: Keycloak + JWT
---

# Keycloak + JWT

> **Decisão**: Keycloak como servidor de identidade; `Crypt::JWT` para validação
> de tokens JWT no servidor; OIDC para autenticação web, JWT Bearer para a API.
> [ADR-009 — Autenticação Keycloak + JWT](/adrs/ADR-009-autenticacao-keycloak-jwt)

---

## Por que Keycloak

Keycloak é um servidor de identidade open-source que implementa OAuth 2.0 e
OpenID Connect (OIDC). Gerenciar usuários, papéis e sessões no próprio código
da aplicação multiplica complexidade: bcrypt, rotação de chaves, tokens de
refresh, recuperação de senha, MFA. Delegar ao Keycloak elimina toda essa
camada do código da Stega.

A Stega usa dois fluxos de autenticação:
- **Interface web**: OIDC Authorization Code Flow → cookie de sessão
- **API REST**: JWT Bearer (stateless) — o cliente obtém um token diretamente
  do Keycloak e o inclui em cada requisição

---

## Imagem Docker para desenvolvimento

```yaml
# compose.yml
services:
  keycloak:
    image: quay.io/keycloak/keycloak:25.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN:          admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/health/ready || exit 1"]
      interval: 10s
      retries: 10
```

---

## Configuração do Realm no Keycloak

Para desenvolvimento, configure manualmente via `http://localhost:8080`:

1. Criar Realm: `stega`
2. Criar Client: `stega-api` (tipo `openid-connect`, `confidential`)
3. Criar atributo personalizado de usuário: `role` com valores `customer`, `agent`, `admin`
4. Mapear `role` como claim no JWT: **Client Scopes → roles → Mappers → Add mapper**

O token JWT resultante contém:
```json
{
  "sub": "uuid-do-usuario",
  "email": "alice@example.com",
  "role": "agent",
  "iss": "http://localhost:8080/realms/stega",
  "aud": "stega-api",
  "exp": 1751000000
}
```

---

## Validação de JWT na API

```perl
# lib/Stega.pm — hook de autenticação
use Crypt::JWT qw(decode_jwt);
use Mojo::UserAgent;

sub startup {
    my $self = shift;

    # Busca as chaves públicas do Keycloak uma vez e faz cache
    my $jwks_url = sprintf('%s/realms/%s/protocol/openid-connect/certs',
        $ENV{KEYCLOAK_URL}   // 'http://localhost:8080',
        $ENV{KEYCLOAK_REALM} // 'stega',
    );

    my $jwks = Mojo::UserAgent->new->get($jwks_url)->result->json;
    $self->helper(jwks => sub { $jwks });

    # Hook: validar JWT em todas as rotas /api/v1
    $self->hook(before_dispatch => sub {
        my $c = shift;
        return unless $c->req->url->path =~ m{^/api/v1/};
        return if $c->req->url->path eq '/healthz';

        my $auth = $c->req->headers->authorization // '';
        my ($token) = $auth =~ /^Bearer\s+(.+)$/;

        unless ($token) {
            $c->render(json => { error => 'unauthorized' }, status => 401);
            return $c->rendered;
        }

        eval {
            my $claims = decode_jwt(
                token     => $token,
                kid_keys  => $c->app->jwks,
                verify_iss => $ENV{JWT_ISSUER} // "http://localhost:8080/realms/stega",
                verify_aud => $ENV{JWT_AUDIENCE} // 'stega-api',
            );
            $c->stash('jwt_claims', $claims);
        };
        if ($@) {
            $c->render(json => { error => 'invalid_token' }, status => 401);
            $c->rendered;
        }
    });

    # ... rotas
}
```

---

## Controle de acesso por papel

```perl
# lib/Stega/Controller/Product.pm
package Stega::Controller::Product;
use Mojo::Base 'Mojolicious::Controller';

# Middleware de autorização reutilizável
sub _require_role {
    my ($c, @allowed_roles) = @_;
    my $claims = $c->stash('jwt_claims') or return 0;
    my $role   = $claims->{role} // '';

    return 1 if grep { $role eq $_ } @allowed_roles;

    $c->render(json => { error => 'forbidden' }, status => 403);
    return 0;
}

sub create {
    my $self = shift;
    return unless _require_role($self, 'admin');

    my $body = $self->req->json;
    # ... criar produto
    $self->render(json => { ok => 1 }, status => 201);
}

sub list {
    my $self = shift;
    # agents e admins podem listar produtos
    return unless _require_role($self, 'agent', 'admin');

    # ...
}

1;
```

---

## Fluxo OIDC para a interface web

```perl
# lib/Stega/Controller/Auth.pm
package Stega::Controller::Auth;
use Mojo::Base 'Mojolicious::Controller';

my $KEYCLOAK_BASE  = $ENV{KEYCLOAK_URL}      // 'http://localhost:8080';
my $REALM          = $ENV{KEYCLOAK_REALM}    // 'stega';
my $CLIENT_ID      = $ENV{KEYCLOAK_CLIENT_ID} // 'stega-api';

# GET /login — redireciona para Keycloak
sub login {
    my $self = shift;
    my $auth_url = sprintf(
        '%s/realms/%s/protocol/openid-connect/auth?client_id=%s&response_type=code&scope=openid+email&redirect_uri=%s',
        $KEYCLOAK_BASE, $REALM, $CLIENT_ID,
        $self->url_for('/auth/callback')->to_abs
    );
    $self->redirect_to($auth_url);
}

# GET /auth/callback — recebe code, troca por token, cria sessão
sub callback {
    my $self = shift;
    my $code = $self->param('code') or return $self->redirect_to('/login');

    # Trocar code por token
    my $token_url = "$KEYCLOAK_BASE/realms/$REALM/protocol/openid-connect/token";
    my $tx = $self->ua->post($token_url, form => {
        grant_type    => 'authorization_code',
        code          => $code,
        client_id     => $CLIENT_ID,
        redirect_uri  => $self->url_for('/auth/callback')->to_abs,
    });

    my $tokens = $tx->result->json;

    # Decodificar claims do access_token
    my $claims = decode_jwt(token => $tokens->{access_token}, decode_payload => 1);

    # Criar/sincronizar usuário local
    $self->pg->db->insert('users',
        {
            keycloak_id  => $claims->{sub},
            email        => $claims->{email},
            display_name => $claims->{name} // $claims->{email},
            role         => $claims->{role} // 'customer',
        },
        { on_conflict => \' (keycloak_id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role' }
    );

    # Armazenar token na sessão
    $self->session(access_token => $tokens->{access_token});
    $self->redirect_to('/');
}

# GET /logout
sub logout {
    my $self = shift;
    my $logout_url = "$KEYCLOAK_BASE/realms/$REALM/protocol/openid-connect/logout";
    $self->session(expires => 1);  # invalida sessão local
    $self->redirect_to($logout_url);
}

1;
```

---

## Variáveis de ambiente obrigatórias

```bash
# .env
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=stega
KEYCLOAK_CLIENT_ID=stega-api
JWT_ISSUER=http://localhost:8080/realms/stega
JWT_AUDIENCE=stega-api
```

Em produção, `KEYCLOAK_URL` aponta para o serviço Keycloak no cluster Kubernetes
ou para uma instância gerenciada (AWS Cognito com OIDC-compatible, Auth0, etc.)

---

## Testes com JWT falso

```perl
# t/api/tickets.t — injetar token sem Keycloak real
my $t = Test::Mojo->new('Stega');

# Substituir o hook de autenticação por um que aceita qualquer Bearer
$t->app->hook(before_dispatch => sub {
    my $c = shift;
    return unless $c->req->url->path =~ m{^/api/v1/};
    if ($c->req->headers->authorization =~ /^Bearer /) {
        $c->stash('jwt_claims', {
            sub   => 'test-user-uuid',
            email => 'test@stega.local',
            role  => 'agent',
        });
    }
});

$t->get_ok('/api/v1/tickets', { Authorization => 'Bearer test' })
  ->status_is(200);
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Validar apenas a assinatura | Um token expirado válido em assinatura passa | Sempre verifique `exp` — `Crypt::JWT` faz isso automaticamente |
| JWKS sem cache | Buscar JWKS a cada requisição adiciona latência e pode falhar | Cachear o JWKS no startup; atualizar via background job se necessário |
| `verify_aud` ausente | Um token de outro client do mesmo Realm seria aceito | Sempre `verify_aud` com o `client_id` correto |
| Cookie de sessão sem `secure` | Token vaza em conexão HTTP | `$app->secrets(['...']); $app->sessions->secure(1)` em produção |
| Sincronizar todos os campos | Campos do Keycloak mudam (nome, email) — a cópia local envelhece | Sincronize em cada callback OIDC (`ON CONFLICT DO UPDATE`) |
