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
usado como **artefato de documentação e revisão de código** — não como plugin de validação
em runtime.

A spec é a fonte da verdade do contrato: descreve todas as rotas, schemas de entrada e
saída, parâmetros e esquemas de segurança. O roteamento e a validação de entrada são
implementados explicitamente nos controladores Mojolicious.

**Nota sobre `Mojolicious::Plugin::OpenAPI`**: existe um plugin que lê o YAML e
automatiza roteamento, validação e geração de Swagger UI. Ele é uma alternativa válida
mas adiciona acoplamento entre o YAML e os `operationId` dos controladores. A Stega
optou por separar os dois: o YAML documenta, o código valida. Projetos que preferem
validação automática de entrada podem adotar o plugin sem mudar a spec.

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
- Criar o diretório `api/` e o arquivo `api/stega.yaml` com o contrato completo das rotas
- Manter a spec sincronizada com a implementação: toda rota nova ou alterada deve ter
  o YAML correspondente atualizado no mesmo PR
- (Opcional) Adicionar `Mojolicious::Plugin::OpenAPI` ao `cpanfile` e registrar no
  `startup()` para projetos que queiram validação automática de entrada via schema
