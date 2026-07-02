---
sidebar_position: 9
title: OpenAPI v3
---

# OpenAPI v3

> **Decisão**: OpenAPI v3 como documentação do contrato da API REST — o arquivo
> `api/stega.yaml` é a fonte única de verdade do contrato, usada para gerar
> documentação e clientes, mas **não** como plugin de validação em runtime.
> [ADR-015 — Contrato de API OpenAPI v3](/adrs/ADR-015-contrato-de-api-openapi-v3)

---

## Por que OpenAPI

O contrato OpenAPI v3 em `api/stega.yaml` define endpoints, parâmetros, schemas
de corpo e códigos de resposta. É a referência que:

- Desenvolvedores leem para entender a API sem ver o código
- Ferramentas usam para gerar clientes em outras linguagens
- Renders como Swagger UI e Redoc exibem como documentação interativa
- Testes de integração consultam para confirmar que as respostas estão conformes

A validação de entrada fica nos controllers, não no YAML — essa decisão simplifica
o rastreamento de erros e evita a dependência de um plugin de runtime adicional
(ver [ADR-015](/adrs/ADR-015-contrato-de-api-openapi-v3) para a análise completa).

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
          description: Dados inválidos
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

---

## Validação de entrada nos controllers

A validação fica no controller, usando a estrutura de dados recebida:

```perl
# lib/Stega/Controller/Ticket.pm
sub create {
    my $self = shift;
    my $data = $self->req->json;

    unless ($data && $data->{title} && $data->{body} && $data->{product_id}) {
        return $self->render(status => 400, json => { error => 'title, body e product_id são obrigatórios' });
    }

    my $priority = $data->{priority} // 'medium';
    unless (grep { $_ eq $priority } qw(low medium high critical)) {
        return $self->render(status => 400, json => { error => "priority inválida: $priority" });
    }

    # ... lógica de criação
}
```

---

## Testes de conformidade com o contrato

Os testes verificam que as respostas da API estão conformes ao contrato OpenAPI:

```perl
# t/010_tickets_api.t
use Test::More;
use Test::Mojo;
use lib 't/lib';
use Stega::Test::Helper qw(make_jwt bearer_header);

my $t = Test::Mojo->new('Stega');

subtest 'POST /api/v1/tickets — sem body retorna 400' => sub {
    $t->post_ok('/api/v1/tickets',
        bearer_header('agent'),
        json => {}
    )->status_is(400)
     ->json_has('/error');
};

subtest 'POST /api/v1/tickets — priority inválida retorna 400' => sub {
    $t->post_ok('/api/v1/tickets',
        bearer_header('agent'),
        json => {
            product_id => 1,
            title      => 'Bug crítico',
            body       => 'Descrição detalhada do problema',
            priority   => 'urgente',
        }
    )->status_is(400)
     ->json_has('/error');
};

done_testing;
```

---

## Gerar documentação interativa

O arquivo `api/stega.yaml` pode ser servido via Swagger UI ou Redoc como
documentação interativa. Usando `npx`:

```bash
# Swagger UI local (desenvolvimento)
npx @redocly/cli preview-docs api/stega.yaml
```

Ou com Docker:

```bash
docker run -p 8081:8080 \
  -e SWAGGER_JSON=/api/stega.yaml \
  -v $(pwd)/api:/api \
  swaggerapi/swagger-ui
# Acesse: http://localhost:8081
```

---

## Alternativa: Mojolicious::Plugin::OpenAPI

Se o projeto precisar de validação automática de entrada em runtime,
`Mojolicious::Plugin::OpenAPI` pode ser adicionado ao `cpanfile` e registrado no `startup`:

```perl
# cpanfile (adicionar se necessário)
requires 'Mojolicious::Plugin::OpenAPI', '5.0';
```

```perl
# lib/Stega.pm — startup
$self->plugin('OpenAPI', {
    url    => $self->home->child('api/stega.yaml'),
    schema => 'v3',
});
```

A Stega não usa este plugin na implementação de referência — a validação explícita
nos controllers foi considerada mais simples de depurar e sem dependência adicional.

---

## Armadilhas comuns

| Armadilha | Como evitar |
|-----------|-------------|
| Schema desatualizado em relação ao controller | Atualizar `api/stega.yaml` junto com qualquer mudança de contrato nas rotas |
| `$ref` com caminho errado | Validar com `npx @redocly/cli lint api/stega.yaml` antes de commitar |
| Códigos de status não documentados | Incluir todos os códigos possíveis (200, 201, 400, 401, 404) no YAML |
| YAML vs JSON para o schema | Use YAML; JSON apenas se gerado por ferramenta externa |
