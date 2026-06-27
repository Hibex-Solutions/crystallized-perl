# [Keycloak](https://www.keycloak.org/)

**Tipo**: Documentação Oficial  
**Autor(es)**: Red Hat e colaboradores (CNCF)  
**Publicado**: 2013 (atualizado continuamente)  
**Acessado**: 2026-06-27

## Relevância
Keycloak é o provedor de identidade e autorização open source líder do ecossistema
cloud-native. Implementa os protocolos OpenID Connect, OAuth 2.0 e SAML 2.0,
oferecendo autenticação federada, gerenciamento de sessões, controle de acesso baseado
em roles (RBAC) e comunicação machine-to-machine via fluxo client_credentials. No
stack Crystallized Perl, o Keycloak é o servidor de identidade externo: emite tokens
JWT que as APIs Mojolicious validam localmente usando `Crypt::JWT` e a chave pública
exposta pelo endpoint JWKS do Keycloak. Essa validação local mantém a performance —
nenhuma chamada de rede ao Keycloak ocorre por requisição. Workers que precisam chamar
APIs protegidas obtêm um token via client_credentials usando `Mojo::UserAgent`.

## Referenciada em
- ADR-009: Autenticação e Identidade — Keycloak + JWT
