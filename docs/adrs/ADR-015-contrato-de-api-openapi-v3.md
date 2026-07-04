# ADR-015: Contrato de API — OpenAPI v3

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

APIs HTTP precisam de uma definição formal: quais rotas existem, quais parâmetros
aceitam, quais respostas produzem e quais esquemas de segurança exigem. Sem um contrato
formal, a documentação fica em documentos soltos (wikis, comentários, memória da
equipe) que divergem da implementação real ao longo do tempo.

O stack precisa de um mecanismo que:
- Defina o contrato da API como código (versionável, revisável em PRs)
- Valide entradas automaticamente antes da lógica de negócio
- Gere documentação navegável sem esforço manual
- Integre com a camada de segurança (Bearer JWT)

## Decisão

**OpenAPI v3** como especificação do contrato de API, em arquivo YAML (`api/stega.yaml`),
carregado por **`Mojolicious::Plugin::OpenAPI`** — o plugin roteia as requisições, valida
entrada e saída contra o schema, e aplica os esquemas de segurança declarados.

A spec é a fonte da verdade do contrato: descreve todas as rotas, schemas de entrada e
saída, parâmetros e esquemas de segurança. O roteamento usa a extensão `x-mojo-to` em
cada operação — explícita, não inferida por convenção de nomes a partir do
`operationId` — e cada ação de Controller confirma a validação com
`$c->openapi->valid_input or return;` antes de tocar em qualquer lógica de negócio.

**Revisão 2026-07-04**: a versão original desta ADR previa o YAML como documentação
pura, com validação manual nos controladores, e o plugin como adoção opcional. Na
implementação real da Stega, o plugin acabou sendo adotado desde o início — a
validação automática de request/response eliminou uma classe inteira de checagens
manuais repetidas (campo obrigatório ausente, tipo errado, enum inválido) que, feitas
à mão, tendiam a divergir sutilmente entre rotas. Esta revisão alinha a ADR ao que
está de fato implementado e testado.

## Justificativa

A OpenAPI Specification (anteriormente Swagger) é o padrão de mercado para descrição
de APIs HTTP. Manter a spec em YAML no repositório oferece:

1. **Contrato versionável**: mudanças na API são visíveis em code review junto com o código
2. **Documentação navegável**: a spec pode ser servida via Swagger UI ou Redoc em qualquer
   ambiente sem dependência da aplicação estar no ar
3. **Contrato para clientes**: integradores podem gerar clientes de API a partir do YAML
4. **Revisão explícita**: diff de YAML em PRs torna mudanças de contrato visíveis

Referências: [OpenAPI Initiative](../references/openapi.md),
[Mojolicious](../references/mojolicious.md)

### Estrutura de arquivos

```
my_app/
├── api/
│   └── openapi.yaml     ← fonte da verdade do contrato
├── lib/
│   ├── MyApp.pm         ← classe principal (herda Mojolicious)
│   └── MyApp/
│       └── Controller/
│           ├── Health.pm
│           └── User.pm
```

### Arquivo de especificação (`api/openapi.yaml`)

```yaml
openapi: "3.0.3"
info:
  title: MyApp API
  version: "1.0.0"

servers:
  - url: /api/v1

# Esquema de segurança global: Bearer JWT
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT

  schemas:
    User:
      type: object
      required: [id, email, name]
      properties:
        id:
          type: integer
        email:
          type: string
          format: email
        name:
          type: string

    NewUser:
      type: object
      required: [email, name]
      properties:
        email:
          type: string
          format: email
        name:
          type: string

    Error:
      type: object
      required: [error]
      properties:
        error:
          type: string

security:
  - BearerAuth: []    # aplicado a toda rota por padrão; sobrescrito com security: [] onde não se aplica (ex.: webhooks)

paths:
  /users:
    get:
      operationId: listUsers
      x-mojo-to: "user#api_list"    # roteamento explícito — não inferido do operationId
      summary: Listar usuários
      responses:
        "200":
          description: Lista de usuários
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/User"
        "401":
          description: Não autorizado
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"

    post:
      operationId: createUser
      x-mojo-to: "user#api_create"
      summary: Criar usuário
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/NewUser"
      responses:
        "201":
          description: Usuário criado
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
        "400":
          description: Dados inválidos
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Error"
        "401":
          description: Não autorizado

  /users/{id}:
    get:
      operationId: showUser
      x-mojo-to: "user#api_show"
      summary: Buscar usuário
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: integer
      responses:
        "200":
          description: Usuário encontrado
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
        "404":
          description: Não encontrado
```

### Registro do plugin no startup

```perl
# lib/MyApp.pm
sub startup {
    my $self = shift;

    $self->plugin('OpenAPI', {
        url      => $self->home->child('api/openapi.yaml'),
        schema   => 'v3',
        # Security handler: chamado para rotas com security: [BearerAuth]
        # (declarado uma vez no nível raiz do YAML, herdado por toda rota —
        # ver ADR-009 para a validação de JWT em si)
        security => {
            BearerAuth => sub {
                my ($c, $definition, $scopes, $cb) = @_;

                my $auth = $c->req->headers->authorization // '';
                my ($token) = $auth =~ /^Bearer\s+(.+)$/i;
                return $c->$cb('Autenticação necessária') unless $token;

                my ($claims, $err) = $c->verify_jwt($token);
                return $c->$cb('Token inválido') if $err;

                $c->stash(current_user => { id => $claims->{sub}, role => $claims->{role} // 'customer' });
                return $c->$cb(undef);
            },
        },
    });
}
```

### Controlador: confirma a validação, renderiza JSON normal

O plugin valida a requisição contra o schema **antes** de rotear para a ação — mas a
ação ainda chama `$c->openapi->valid_input` explicitamente como primeira linha. Isso
não é redundante: é o ponto em que, se a validação falhasse silenciosamente por
alguma razão, a ação recusa continuar em vez de assumir que os dados estão bons.
A resposta é `$c->render(json => ...)` normal — sem um helper especial de output:

```perl
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller', -strict;

sub api_list {
    my $c = shift;
    $c->openapi->valid_input or return;

    my $users = $c->pg->db->query(
        'SELECT id, email, name FROM users ORDER BY id'
    )->hashes;

    $c->render(json => { data => $users });
}

sub api_create {
    my $c    = shift;
    $c->openapi->valid_input or return;
    my $data = $c->req->json;    # já validado contra o schema da requestBody

    my $user = $c->pg->db->query(
        'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name',
        $data->{email}, $data->{name}
    )->hash;

    $c->render(json => { data => $user }, status => 201);
}
```

### Roteamento explícito via `x-mojo-to`

Cada operação do YAML declara `x-mojo-to: "controller#action"` — roteamento
explícito, não inferido de uma convenção de nomes a partir do `operationId`:

| Rota | `operationId` (documentação) | `x-mojo-to` (roteamento real) |
|------|------------------------------|-------------------------------|
| `GET /users` | `listUsers` | `user#api_list` |
| `POST /users` | `createUser` | `user#api_create` |
| `GET /users/{id}` | `showUser` | `user#api_show` |

O `operationId` continua existindo — é usado por ferramentas de geração de cliente e
pela Swagger UI — mas não é o que decide qual método do Controller é chamado. Os dois
podem até ter nomes diferentes sem problema (por isso a Stega usa `api_list`,
`api_create` etc. nos Controllers — prefixo `api_` para diferenciar da ação web
equivalente no mesmo Controller, como `list` vs `api_list`).

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Validação manual nos controladores** | Verbosa, inconsistente entre rotas, sem documentação automática, sem contrato formal versionável |
| **JSON Schema standalone** | Sem integração nativa com Mojolicious; exigiria middleware de validação próprio |
| **RAML** | Menor adoção no ecossistema Perl; sem plugin Mojolicious mantido |
| **API Blueprint** | Formato de documentação, não de validação; sem integração com Mojolicious |
| **GraphQL** | Paradigma diferente (consultas ad hoc vs. contrato de rotas); fora do modelo REST/HTTP do stack |

## Consequências

**Positivo**:
- Contrato versionável no Git: mudanças na API são visíveis em code review
- Validação automática de entrada elimina código de validação manual nos controladores
- Swagger UI gerada automaticamente para exploração da API em desenvolvimento
- Security schemes declarados no YAML integram diretamente com a validação de JWT

**Negativo**:
- O arquivo `api/openapi.yaml` cresce com a API — requer disciplina de organização
  (uso de `$ref` para schemas compartilhados)
- O `operationId` no YAML deve ser único e corresponder à convenção de nomes dos
  controladores — erros de mapeamento causam erros em runtime

**Ações necessárias**:
- Criar o diretório `api/` e o arquivo `api/stega.yaml` com o contrato completo das rotas
- Manter a spec sincronizada com a implementação: toda rota nova ou alterada deve ter
  o YAML correspondente atualizado no mesmo PR, incluindo o `x-mojo-to`
- Declarar `Mojolicious::Plugin::OpenAPI` no `cpanfile` (obrigatório, não opcional —
  ver revisão 2026-07-04) e registrar no `startup()` com o security handler de JWT
- Toda ação de Controller sob `/api/v1/*` começa com `$c->openapi->valid_input or return;`
