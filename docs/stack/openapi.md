---
sidebar_position: 9
title: OpenAPI v3
---

# OpenAPI v3

> **Decisão**: OpenAPI v3 como contrato da API REST; `Mojolicious::Plugin::OpenAPI`
> para validação automática de requisições e respostas.
> [ADR-015 — Contrato de API OpenAPI v3](/adrs/ADR-015-contrato-de-api-openapi-v3)

---

## Por que OpenAPI

O contrato OpenAPI v3 é a fonte única de verdade da API da Stega: define
endpoints, parâmetros, schemas de corpo e códigos de resposta. O plugin
`Mojolicious::Plugin::OpenAPI` valida automaticamente toda requisição recebida
contra o schema — retornando `400 Bad Request` com mensagem de erro estruturada
antes que o controller seja chamado. Não é necessário escrever validação manual.

O arquivo `api/stega.yaml` também serve como documentação interativa
(Swagger UI / Redoc) e como base para geração de clientes em outras linguagens.

---

## Estrutura do arquivo de contrato

```yaml
# api/stega.yaml
openapi: "3.0.3"
info:
  title: Stega API
  version: "1.0.0"
  description: |
    API REST do sistema de tickets de suporte Stega.
    Autenticação: JWT Bearer (obter token no Keycloak).

servers:
  - url: /api/v1
    description: API versionada

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    Ticket:
      type: object
      required: [id, title, status, priority, created_at]
      properties:
        id:
          type: integer
        title:
          type: string
        body:
          type: string
        status:
          type: string
          enum: [open, in_progress, waiting, resolved, closed]
        priority:
          type: string
          enum: [low, medium, high, critical]
        custom_fields:
          type: object
          additionalProperties: true
        created_at:
          type: string
          format: date-time

    TicketCreate:
      type: object
      required: [product_id, title, body]
      properties:
        product_id:
          type: integer
        title:
          type: string
          minLength: 5
          maxLength: 200
        body:
          type: string
          minLength: 10
        priority:
          type: string
          enum: [low, medium, high, critical]
          default: medium
        custom_fields:
          type: object
          additionalProperties: true

    Error:
      type: object
      required: [error]
      properties:
        error:
          type: string

security:
  - bearerAuth: []

paths:
  /tickets:
    get:
      operationId: listTickets
      summary: Listar tickets
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [open, in_progress, waiting, resolved, closed]
        - name: q
          in: query
          description: Busca em texto completo
          schema:
            type: string
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
      responses:
        "200":
          description: Lista de tickets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Ticket'
        "401":
          description: Não autenticado
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

    post:
      operationId: createTicket
      summary: Criar ticket
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/TicketCreate'
      responses:
        "201":
          description: Ticket criado
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: integer
        "400":
          description: Dados inválidos (validação automática pelo plugin)
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

---

## Carregando o plugin no Mojolicious

```perl
# lib/Stega.pm
sub startup {
    my $self = shift;

    # Plugin OpenAPI — carrega o contrato e ativa validação automática
    $self->plugin('OpenAPI', {
        url    => $self->home->child('api/stega.yaml'),
        schema => 'v3',
    });

    # As rotas OpenAPI já estão registradas pelo plugin usando operationId
    # Mapeamento: operationId => 'controller#ação'
    # listTickets  => Stega::Controller::Ticket::list
    # createTicket => Stega::Controller::Ticket::create
}
```

---

## Mapeamento operationId → controller

O plugin converte automaticamente o `operationId` em `controller#ação`:

| operationId | Módulo | Método |
|-------------|--------|--------|
| `listTickets` | `Stega::Controller::Ticket` | `list` |
| `createTicket` | `Stega::Controller::Ticket` | `create` |
| `getTicket` | `Stega::Controller::Ticket` | `get` |
| `updateTicket` | `Stega::Controller::Ticket` | `update` |
| `listComments` | `Stega::Controller::Comment` | `list` |

A convenção: `camelCase` no `operationId` é convertido para `snake_case` no nome
do módulo e método. Ou configure explicitamente com `x-mojo-to`.

---

## Validação automática — o que o plugin faz

Com o plugin carregado, toda requisição é validada antes do controller:

```bash
# Requisição sem campo obrigatório 'title'
curl -X POST http://localhost:3000/api/v1/tickets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"product_id": 1, "body": "Sem título"}'

# Resposta automática do plugin (400)
{
  "errors": [
    {
      "message": "Missing property.",
      "path": "/title"
    }
  ]
}
```

```bash
# Valor fora do enum
curl -X POST http://localhost:3000/api/v1/tickets \
  -d '{"product_id":1,"title":"Bug","body":"Detalhes","priority":"urgente"}'

# Resposta automática
{
  "errors": [
    {
      "message": "Not in enum list: urgente.",
      "path": "/priority"
    }
  ]
}
```

---

## Testes com validação OpenAPI

```perl
# t/api/tickets.t
use Test::More;
use Test::Mojo;

my $t = Test::Mojo->new('Stega');

subtest 'body inválido retorna 400 com mensagem estruturada' => sub {
    $t->post_ok('/api/v1/tickets',
        { Authorization => 'Bearer test' },
        json => { product_id => 1 }   # falta title e body (obrigatórios)
    )->status_is(400)
     ->json_like('/errors/0/message', qr/Missing property/);
};

subtest 'priority inválida retorna 400' => sub {
    $t->post_ok('/api/v1/tickets',
        { Authorization => 'Bearer test' },
        json => {
            product_id => 1,
            title      => 'Bug crítico',
            body       => 'Descrição detalhada do problema',
            priority   => 'urgente',   # não está no enum
        }
    )->status_is(400);
};

done_testing;
```

---

## Documentação interativa

O plugin expõe automaticamente a documentação OpenAPI via Swagger UI:

```
# Disponível em desenvolvimento
http://localhost:3000/api/v1
```

Para personalizar o path de documentação:

```perl
$self->plugin('OpenAPI', {
    url      => $self->home->child('api/stega.yaml'),
    schema   => 'v3',
    spec_url => '/api-docs',   # URL da spec JSON
});
```

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| `operationId` duplicado | O plugin registra apenas um handler por `operationId` | Nomes únicos globais no YAML |
| Schema sem `required` | Campos não marcados como `required` passam como `null` silenciosamente | Liste campos obrigatórios explicitamente |
| `$ref` com caminho errado | `$ref: '#/components/schemas/Foo'` — typo causa erro silencioso | Valide o YAML com `openapi-generator validate` |
| Resposta não documentada | O plugin emite warning para códigos de status não no YAML | Documente todos os códigos possíveis (200, 201, 400, 401, 404) |
| YAML vs JSON para o schema | O plugin aceita ambos, mas YAML é mais legível para manutenção | Use YAML; JSON apenas se gerado por ferramenta |
