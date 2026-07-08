---
sidebar_position: 7
title: "Guia 7 — Contrato de API com OpenAPI v3"
---

# Guia 7 — Contrato de API com OpenAPI v3

> **Referência arquitetural**:
> [ADR-015 — Contrato de API OpenAPI v3](/adrs/ADR-015-contrato-de-api-openapi-v3)

---

## O que você vai construir

Ao final deste guia você terá:

- `api/stega.yaml` — o contrato completo da API: rotas, schemas, segurança
- `Mojolicious::Plugin::OpenAPI` registrado, validando toda requisição e resposta
  contra o schema antes da lógica de negócio rodar
- Uma rota nova, do YAML até o Controller, seguindo o mesmo padrão do resto da API

---

## Pré-requisitos

- [Guia 6](/guides/autenticacao-keycloak) concluído
- `Mojolicious::Plugin::OpenAPI` **>= 5.11, < 5.12** no `cpanfile` — a faixa travada
  evita uma versão que introduziu uma dependência XS incompatível com Perl 5.42 (ver
  ADR-005 para a semântica de versões no `cpanfile`)

---

## Por que o YAML é o contrato, não só documentação

A decisão original deste projeto era manter o YAML como documentação e validar
manualmente em cada Controller. Na prática, isso gerava validação repetida e
sutilmente divergente entre rotas — um Controller esquecia de checar um campo
obrigatório, outro validava o enum de um jeito diferente. A decisão revisada (ver
"Revisão 2026-07-04" na ADR-015) é deixar o plugin fazer esse trabalho: o YAML deixa
de ser só descrição e passa a ser o que efetivamente decide se uma requisição chega
até o Controller.

---

## Passo 1 — Estrutura do `api/stega.yaml`

```yaml
openapi: "3.0.3"

info:
  title: Stega API
  version: "1.0.0"

servers:
  - url: http://localhost:3000/api
    description: Desenvolvimento local

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    Product:
      type: object
      properties:
        id:          { type: integer }
        name:        { type: string }
        slug:        { type: string }
        description: { type: string, nullable: true }
        is_active:   { type: boolean }
        created_at:  { type: string, format: date-time }

    Error:
      type: object
      required: [error]
      properties:
        error: { type: string }

  responses:
    Unauthorized:
      description: Token de autenticação ausente ou inválido
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }

# Segurança padrão: toda rota exige Bearer JWT, a não ser que a rota
# sobrescreva com "security: []" (é o caso dos webhooks — ver Guia 8)
security:
  - bearerAuth: []

paths:
  /v1/products:
    post:
      operationId: createProduct
      x-mojo-to: "product#api_create"
      description: Requer papel admin.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, slug]
              properties:
                name: { type: string }
                slug: { type: string }
      responses:
        "201":
          description: Produto criado
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { $ref: '#/components/schemas/Product' }
        "401": { $ref: '#/components/responses/Unauthorized' }
        "422":
          description: Dados inválidos
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Error' }
```

`operationId` (`createProduct`) documenta e nomeia a operação — usado por ferramentas
de geração de cliente e pela Swagger UI. `x-mojo-to` (`product#api_create`) é o que
de fato decide qual Controller e método atendem a requisição — os dois nomes não
precisam coincidir.

---

## Passo 2 — Registrar o plugin

```perl
# lib/Stega.pm
sub _setup_openapi {
    my $self = shift;

    $self->plugin('OpenAPI', {
        url      => $self->home->child('api/stega.yaml'),
        schema   => 'v3',
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
}
```

O `security` handler (Guia 6) roda uma vez por requisição, antes do Controller —
preenche `$c->stash('current_user')`, que tanto `Stega::Domain::TicketPolicy` quanto
os Controllers consultam depois.

---

## Passo 3 — Confirmar a validação no Controller

```perl
package Stega::Controller::Product;
use Mojo::Base 'Mojolicious::Controller', -strict;

use Stega::Domain::TicketPolicy;
use Stega::Domain::Product;
use Stega::Repository::Pg::Product;

sub api_create {
    my $c    = shift;
    $c->openapi->valid_input or return;
    my $json = $c->req->json // {};
    my $role = ($c->stash('current_user') // {})->{role} // '';

    return $c->render(json => { error => 'Apenas admins' }, status => 403)
        unless Stega::Domain::TicketPolicy->can_manage_products($role);

    my $domain = Stega::Domain::Product->new(
        repository => Stega::Repository::Pg::Product->new(db => $c->pg->db),
    );

    my $product = eval { $domain->create(name => $json->{name}, slug => $json->{slug}) };
    return $c->render(json => { error => $@ }, status => 422) if $@;

    $c->render(json => { data => $product }, status => 201);
}
```

`$c->openapi->valid_input or return;` é a primeira linha de toda ação de API na
Stega — se `name` ou `slug` estiverem ausentes, o plugin já respondeu 400 antes desse
`return` sequer ser avaliado como "falso"; a linha existe para o caso (raro, mas
possível com configurações não-padrão) de a ação ser chamada sem passar pelo pipeline
normal do plugin. Repare que a autorização (`TicketPolicy`) e a validação de negócio
(`Domain::Product`, Guias 4 e o padrão da ADR-020) continuam sendo responsabilidade
do Controller — o plugin só valida a *forma* dos dados (campos obrigatórios, tipos),
não *regras de negócio*.

---

## Passo 4 — Adicionar uma rota nova

Digamos que você queira `GET /v1/products/{id}`. Primeiro, o YAML:

```yaml
  /v1/products/{id}:
    get:
      operationId: showProduct
      x-mojo-to: "product#api_show"
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer }
      responses:
        "200":
          description: Produto encontrado
          content:
            application/json:
              schema:
                type: object
                properties:
                  data: { $ref: '#/components/schemas/Product' }
        "404": { $ref: '#/components/responses/NotFound' }
```

Depois, o Controller:

```perl
sub api_show {
    my $c  = shift;
    $c->openapi->valid_input or return;
    my $id = $c->param('id');

    my $product = $c->pg->db->query('SELECT * FROM products WHERE id = $1', $id)->hash;
    return $c->render(json => { error => 'Não encontrado' }, status => 404) unless $product;

    $c->render(json => { data => $product });
}
```

Reinicie a aplicação (o YAML é lido no `startup()`, não recarrega em quente) e a
rota já está ativa, validada e documentada — sem tocar em `_setup_routes`.

---

## Explorando o contrato

```bash
curl http://localhost:3000/api
```

Devolve o YAML inteiro como JSON — é a spec completa, não a aplicação. Um cliente
gerado a partir desse JSON (ou uma Swagger UI apontando pra ele) sempre reflete
exatamente o que a API aceita, porque é a mesma fonte que o plugin usa para validar.

---

## Solução de problemas comuns

| Problema | Causa provável | Solução |
|----------|---------------|---------|
| Rota nova retorna 404 | `x-mojo-to` ausente ou com nome de Controller/ação errado | Confirme o mapeamento; reinicie a aplicação |
| Requisição válida rejeitada com 400 | Schema mais restritivo que o esperado (ex.: `nullable` ausente num campo opcional) | Revise o schema da `requestBody` |
| `security: []` não torna a rota pública | Faltou declarar no nível da operação, não só do path | `security: []` dentro do verbo HTTP específico (`get:`, `post:`), não do path inteiro |

---

## Próximos passos

Com o contrato de API formalizado, o próximo guia cobre processamento assíncrono:

- **Guia 8 — Filas com PgQue e Minion**: jobs internos com Minion, notificações
  multi-consumidor via PgQue, direto em PostgreSQL, sem dependência XS

Explore agora:
- [**ADR-015**](/adrs/ADR-015-contrato-de-api-openapi-v3): a decisão completa e por
  que a validação automática substituiu a manual
- [**ADR-009**](/adrs/ADR-009-autenticacao-keycloak-jwt): o `security` handler em
  detalhe (Guia 6)
