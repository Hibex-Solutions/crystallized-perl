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

**OpenAPI v3** como especificação do contrato de API, em arquivo YAML, com
**Mojolicious::Plugin::OpenAPI** para validação automática de entrada e saída.

## Justificativa

A OpenAPI Specification (anteriormente Swagger) é o padrão de mercado para descrição
de APIs HTTP. O plugin `Mojolicious::Plugin::OpenAPI` lê o arquivo YAML da
especificação e:

1. **Roteia automaticamente** as operações do contrato para os controladores Mojolicious
2. **Valida a entrada** (parâmetros de URL, query, body) contra os schemas definidos
   no YAML — retornando HTTP 400 antes de qualquer código do controlador ser executado
3. **Valida a saída** em modo de desenvolvimento, verificando se o JSON de resposta
   está conforme o schema declarado
4. **Serve a documentação** via Swagger UI no endpoint `/api` (configurável)
5. **Integra security schemes**: quando um security scheme `Bearer` é declarado no
   YAML, o plugin chama automaticamente o security handler registrado na aplicação

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

paths:
  /users:
    get:
      operationId: listUsers
      summary: Listar usuários
      security:
        - BearerAuth: []
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
      summary: Criar usuário
      security:
        - BearerAuth: []
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
      summary: Buscar usuário
      security:
        - BearerAuth: []
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

    # Registrar o plugin OpenAPI apontando para o arquivo de spec
    $self->plugin('OpenAPI', {
        url    => $self->home->rel_file('api/openapi.yaml'),
        # Security handler: chamado para rotas com security: [BearerAuth]
        security => {
            BearerAuth => sub {
                my ($c, $definition, $scopes, $cb) = @_;
                # Lógica de validação do JWT — ver ADR-009
                return $c->$cb() if $c->_validate_jwt;
                return $c->$cb('Unauthorized');
            },
        },
    });
}
```

### Controlador: sem validação manual de entrada

Com o plugin registrado, o controlador recebe apenas requisições já validadas contra
o schema. Parâmetros ausentes ou com tipo errado causam HTTP 400 automático:

```perl
package MyApp::Controller::User;
use Mojo::Base 'Mojolicious::Controller';

sub listUsers {
    my $self  = shift;
    my $users = $self->pg->db->query(
        'SELECT id, email, name FROM users ORDER BY id'
    )->hashes;

    # openapi_reply: serializa e valida a resposta contra o schema de saída
    $self->render(openapi => $users);
}

sub createUser {
    my $self = shift;
    my $data = $self->req->json;    # já validado pelo plugin

    my $user = $self->pg->db->query(
        'INSERT INTO users (email, name) VALUES (?, ?) RETURNING id, email, name',
        $data->{email}, $data->{name}
    )->hash;

    $self->render(openapi => $user, status => 201);
}
```

### Mapeamento de operationId para controladores

O plugin usa o `operationId` do YAML para rotear para o método do controlador:

| operationId | Mapeamento padrão |
|-------------|------------------|
| `listUsers` | `MyApp::Controller::User#listUsers` |
| `createUser` | `MyApp::Controller::User#createUser` |
| `showUser` | `MyApp::Controller::User#showUser` |

A convenção é: prefixo da aplicação + `Controller` + nome antes do verbo em camelCase.
Isso é configurável no plugin se outra convenção for preferida.

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
- Criar o diretório `api/` e o arquivo `api/openapi.yaml` com as rotas iniciais
- Registrar o plugin OpenAPI no `startup()` da aplicação
- Declarar `Mojolicious::Plugin::OpenAPI` no `cpanfile`
- Usar `$self->render(openapi => ...)` em todos os controladores que usam o plugin
