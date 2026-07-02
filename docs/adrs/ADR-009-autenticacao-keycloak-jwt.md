# ADR-009: Autenticação e Identidade — Keycloak + JWT

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

APIs e workers precisam de autenticação stateless compatível com o fator VI do
12-factor (processos sem estado). Sessões armazenadas em arquivo ou memória local
vinculam requisições a uma instância específica do Pod — o que é incompatível com a
escala horizontal do Kubernetes. A solução deve:

- Validar identidade sem chamada de rede por requisição (performance em escala)
- Suportar comunicação machine-to-machine (workers chamando APIs)
- Ser operável como serviço self-hosted em Kubernetes (sem dependência de SaaS pago)

## Decisão

**Keycloak** como Identity Provider (IdP) externo, **JWT** como formato de token de
acesso, **Crypt::JWT** para validação local do token usando a chave pública do Keycloak
obtida via endpoint JWKS.

## Justificativa

O Keycloak é o provedor de identidade open source líder do ecossistema cloud-native.
Implementa OpenID Connect e OAuth 2.0, roda como container em Kubernetes e é adotado
por organizações que precisam de controle total sobre dados de identidade.

**Validação local via JWKS** é o padrão de performance para JWT: a API baixa a chave
pública do Keycloak uma vez (no startup) e valida todos os tokens localmente — sem
chamada de rede ao Keycloak em cada requisição. A rotação de chaves do Keycloak é
tratada via refresh periódico do JWKS.

**Crypt::JWT** é o módulo Perl para codificação e decodificação de JWT (RS256, ES256,
HS256), com suporte a validação de `exp`, `iss`, `aud` e claims customizados.

O fluxo **client_credentials** do OAuth 2.0 cobre a comunicação machine-to-machine:
um worker ou microserviço obtém um token de acesso do Keycloak usando suas próprias
credenciais (`client_id` + `client_secret`) e usa esse token para chamar APIs
protegidas.

Referências: [Keycloak](../references/keycloak.md),
[The Twelve-Factor App](../references/twelve-factor-app.md),
[Mojolicious](../references/mojolicious.md)

### Fluxo de autenticação de usuário final

```
Usuário → Login no Keycloak → Recebe JWT access token
JWT access token → Authorization: Bearer <token> na requisição à API
API → valida token localmente com chave pública do Keycloak (JWKS)
API → extrai claims (sub, email, roles) do payload do JWT
```

### Fluxo machine-to-machine (workers e microserviços)

```
Worker → POST /realms/{realm}/protocol/openid-connect/token
         com grant_type=client_credentials, client_id, client_secret
Worker recebe → access token JWT
Worker → Authorization: Bearer <token> na chamada à API
```

### Configuração via variáveis de ambiente

```bash
# URL usada pelo servidor para chamadas servidor→servidor ao Keycloak
# (troca de código por token, busca de chave pública via JWKS)
KEYCLOAK_URL=https://auth.example.com

# URL do Keycloak visível pelo browser (redirects de login e logout).
# Necessária quando KEYCLOAK_URL aponta para um hostname interno (ex: Docker networking)
# que o browser não consegue resolver. Se omitida, usa KEYCLOAK_URL.
KEYCLOAK_FRONTEND_URL=https://auth.example.com

KEYCLOAK_REALM=myapp
KEYCLOAK_CLIENT_ID=myapp-api
KEYCLOAK_CLIENT_SECRET=secret  # apenas para workers/M2M com client confidencial
```

### Carregamento do JWKS e validação de JWT

O JWKS pode ser carregado no startup (mais eficiente) ou na primeira validação
(mais simples). Recomenda-se carregá-lo no startup e cacheá-lo no processo —
isso evita uma chamada HTTP ao Keycloak em cada requisição:

```perl
# lib/MyApp.pm
use Mojo::Base 'Mojolicious';
use Mojo::UserAgent;
use Crypt::JWT qw(decode_jwt);

my $jwks_cache;   # cache por processo (cada worker Hypnotoad tem o seu)

sub startup {
    my $self = shift;

    $self->helper(verify_jwt => sub {
        my ($c, $token) = @_;

        my $claims = eval { _decode_jwt($token) };
        return (undef, "Token inválido: $@") if $@;
        return ($claims, undef);
    });
}

sub _decode_jwt {
    my $token = shift;

    # Lê o alg do header sem validação criptográfica
    my ($hdr_b64) = split /\./, $token;
    $hdr_b64 =~ tr/-_/+\//;
    $hdr_b64 .= '=' x ((4 - length($hdr_b64) % 4) % 4);
    require MIME::Base64; require JSON::PP;
    my $alg = JSON::PP::decode_json(MIME::Base64::decode_base64($hdr_b64))->{alg} // '';

    if ($alg eq 'HS256') {
        my $secret = $ENV{TEST_JWT_SECRET} or die "TEST_JWT_SECRET não configurada";
        return decode_jwt(token => $token, key => $secret, accepted_alg => 'HS256');
    }

    # RS256/RS384/RS512: usa cache do JWKS para evitar HTTP por requisição
    unless ($jwks_cache) {
        my $url = $ENV{KEYCLOAK_URL} . '/realms/' . ($ENV{KEYCLOAK_REALM} // 'app')
                . '/protocol/openid-connect/certs';
        $jwks_cache = Mojo::UserAgent->new->get($url)->result->json;
    }

    my ($jwk) = grep { ($_->{use} // '') eq 'sig' } @{$jwks_cache->{keys} // []};
    $jwk //= ($jwks_cache->{keys} // [])->[0];
    die "Nenhuma chave no JWKS" unless $jwk;

    # Crypt::JWT aceita um hash JWK diretamente no parâmetro 'key'
    return decode_jwt(
        token        => $token,
        key          => $jwk,
        accepted_alg => ['RS256', 'RS384', 'RS512'],
    );
}

1;
```

### Acessando claims nos controladores

```perl
# lib/MyApp/Controller/User.pm
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller';

sub profile {
    my $self   = shift;
    my $claims = $self->stash('jwt_claims');

    # Sub (subject) é o ID do usuário no Keycloak
    my $user_id = $claims->{sub};
    my $email   = $claims->{email};
    my $roles   = $claims->{realm_access}{roles} // [];

    $self->render(json => {
        user_id => $user_id,
        email   => $email,
        roles   => $roles,
    });
}

1;
```

### Obtenção de token em workers (client_credentials)

```perl
# lib/MyApp/Auth/ClientCredentials.pm
package MyApp::Auth::ClientCredentials;
use Moo;
use Mojo::UserAgent;
use namespace::clean;

has 'ua'     => ( is => 'ro', default => sub { Mojo::UserAgent->new } );
has '_token' => ( is => 'rw' );
has '_exp'   => ( is => 'rw', default => 0 );

sub token {
    my $self = shift;

    # Reutilizar token existente se ainda válido (com margem de 60s)
    return $self->_token if time() < ($self->_exp - 60);

    my $res = $self->ua->post(
        $ENV{KEYCLOAK_URL} . '/realms/' . $ENV{KEYCLOAK_REALM}
            . '/protocol/openid-connect/token',
        form => {
            grant_type    => 'client_credentials',
            client_id     => $ENV{KEYCLOAK_CLIENT_ID},
            client_secret => $ENV{KEYCLOAK_CLIENT_SECRET},
        }
    )->result;

    die "Falha ao obter token: " . $res->body unless $res->is_success;

    my $data = $res->json;
    $self->_token($data->{access_token});
    $self->_exp(time() + $data->{expires_in});

    return $self->_token;
}

1;
```

```perl
# Uso no worker ao chamar outra API protegida
my $auth   = MyApp::Auth::ClientCredentials->new;
my $result = $ua->get(
    'http://other-service/api/v1/data',
    { Authorization => 'Bearer ' . $auth->token }
)->result->json;
```

### Docker Compose: Keycloak em desenvolvimento

O Keycloak em desenvolvimento usa o mesmo PostgreSQL da aplicação (database
separada `keycloak`). Um script de inicialização cria a database automaticamente:

```sql
-- docker/postgres-init/01-keycloak-db.sql
CREATE DATABASE keycloak;
```

```yaml
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.6
    command: start-dev
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      KC_DB:               postgres
      KC_DB_URL:           jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME:      postgres      # mesmo superusuário do compose em desenvolvimento
      KC_DB_PASSWORD:      postgres_dev
      KEYCLOAK_ADMIN:      admin
      KEYCLOAK_ADMIN_PASSWORD: admin
    ports:
      - "8080:8080"
```

Usar PostgreSQL como backend do Keycloak em desenvolvimento garante que a
configuração do realm (clients, roles, usuários) **persiste entre restarts**
do container, eliminando a necessidade de reconfiguração a cada `docker compose up`.

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Sessões locais (Mojolicious::Sessions)** | Com estado: vincula o cliente a uma instância específica do Pod, incompatível com escala horizontal no Kubernetes |
| **Auth0 / Okta** | Serviços SaaS com custo por usuário ativo; vendor lock-in; dados de identidade em infraestrutura de terceiros |
| **Token Introspection (chamada ao Keycloak por requisição)** | Latência adicional em cada requisição; Keycloak vira single point of failure síncrono da API |
| **Dex** | Alternativa open source ao Keycloak, mas com menor ecossistema e sem interface administrativa madura |
| **HTTP Basic Auth** | Sem suporte a tokens de curta duração, sem RBAC integrado, sem M2M; insuficiente para arquitetura cloud-native |

## Consequências

**Positivo**:
- Validação local: nenhuma chamada de rede ao Keycloak em cada requisição
- Stateless: qualquer réplica da API valida qualquer token
- client_credentials cobre M2M sem gerenciar sessões manualmente
- Keycloak self-hosted: sem dependência de SaaS e sem custo por usuário

**Negativo**:
- Keycloak é um serviço adicional na infraestrutura (requer mais recursos de memória)
- Rotação de chaves JWKS requer mecanismo de refresh periódico ou no startup
- O `exp` (expiração) do JWT deve ser monitorado: tokens longos aumentam janela de
  risco; tokens curtos aumentam frequência de refresh nos clientes

**Ações necessárias**:
- Adicionar `Crypt::JWT` ao `cpanfile`
- Adicionar serviço `keycloak` ao Docker Compose com configuração de realm de
  desenvolvimento
- Configurar Secret no Kubernetes com `KEYCLOAK_URL`, `KEYCLOAK_REALM`,
  `KEYCLOAK_CLIENT_ID` e `KEYCLOAK_CLIENT_SECRET` para workers
- Implementar refresh do JWKS (recarregar chaves periodicamente ou ao receber erro 401
  downstream)
