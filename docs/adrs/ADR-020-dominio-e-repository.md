# ADR-020: Camada de Domínio e Repository

**Status**: Aceita
**Data**: 2026-07-02

## Contexto

ADR-011 introduziu o padrão **Policy** — classes puras que decidem *quem pode fazer
o quê* (autorização), testáveis sem banco de dados. Isso resolveu a autorização, mas
deixou de fora um segundo tipo de regra que também vive hoje dentro dos Controllers:
*a ação em si é válida?* — por exemplo, "não é permitido criar dois produtos com o
mesmo slug". Diferente de autorização (depende só do papel do usuário), essa validação
depende do **estado atual dos dados** — é preciso consultar o que já existe antes de
decidir se a operação pode prosseguir.

Hoje essa lógica, quando existe, está misturada com SQL dentro dos Controllers — e na
Stega, na maioria dos casos, **não existe**: `Stega::Controller::Product::api_create`
insere um produto sem checar duplicidade de nome, e uma tentativa de slug duplicado
estoura uma exceção crua do `DBD::Pg` (constraint `UNIQUE` da migration 2), retornando
500 em vez de uma resposta 422 tratada. Não há teste algum cobrindo esse caso.

Adicionalmente, `Stega::Model::*` (`Ticket`, `Comment`, `Product`, `User`) — os
value objects Moo definidos conforme ADR-006 — não são instanciados em nenhum lugar
do código: Controllers leem e escrevem hashrefs crus via `$c->pg->db->query(...)`.
Os modelos existem, mas não têm função no fluxo real da aplicação.

## Decisão

Duas novas camadas, complementares à Policy (ADR-011), não substitutas dela:

- **`Stega::Domain::*`**: uma classe por entidade com regra de criação/atualização
  não trivial. Recebe um **Repository** injetado no construtor, valida a operação
  contra o estado atual (via o Repository) e, se válida, executa a ação. Não sabe
  nada de HTTP, `Mojo::Base` ou `Mojo::Pg` diretamente.
- **`Stega::Repository::*`**: o contrato de acesso a dados de uma entidade, definido
  como `Moo::Role` (`requires`) em `lib/`, com uma implementação real
  `Stega::Repository::Pg::*` (também em `lib/`, envolve `$c->pg->db`) e uma
  implementação **Fake** em memória usada exclusivamente em teste — que fica em
  `t/lib/`, não em `lib/` (ver "Localização do Fake" abaixo).

```
Stega::Domain::Product           ← regra de negócio: valida e orquestra a ação
    has repository => (is => 'ro', required => 1);
    sub create { ... valida via $self->repository, chama $self->repository->insert }

Stega::Repository::Product       ← contrato (Moo::Role, requires find_by_slug/find_by_name/insert)
Stega::Repository::Pg::Product   ← implementação real (produção)
Stega::Test::Repository::Product ← implementação Fake, em memória (só teste)
```

**Policy decide quem pode agir; Domain decide se a ação é válida e a executa.** As
duas continuam necessárias e não se sobrepõem — um Controller normalmente chama as
duas em sequência: primeiro a Policy (autorização), depois o Domain (validação +
execução).

## Justificativa

### Por que Repository como `Moo::Role`, não como classe base

Um `Moo::Role` com `requires` declara o contrato sem impor herança — a implementação
real (`Pg::`) e a Fake compõem o role independentemente, e o Perl aponta em tempo de
composição se uma delas não implementar todos os métodos exigidos. Isso é a mesma
abordagem que ADR-006 já usa para comportamento compartilhado (`Moo::Role`), aplicada
aqui como um "contrato de interface" no sentido de linguagens com tipagem estrutural —
consistente com o restante do stack, sem introduzir um mecanismo novo.

### Localização do Fake: `t/lib/`, não `lib/`

`t/lib/` é o local convencionado pela comunidade Perl para código que existe
exclusivamente para dar suporte a testes — a Stega já segue essa convenção com
`t/lib/Stega/Test/Helper.pm` (`make_jwt`, `bearer_header`), carregado via
`use lib 't/lib';` nos arquivos `.t`. `lib/` representa o código real distribuído da
aplicação; nada em produção (`script/stega`, `eng/*.pl`, Controllers) referencia
`t/lib`. Colocar a Fake em `lib/` misturaria código de produção com código que só
existe para simular estado em teste — o `Stega::Repository::Pg::Product` real é o
único que a aplicação de fato usa fora de `t/`.

Nomenclatura: `Stega::Test::Repository::<Entidade>` (ex.:
`Stega::Test::Repository::Product`, em `t/lib/Stega/Test/Repository/Product.pm`) —
mesmo prefixo `Stega::Test::` que `Stega::Test::Helper` já estabeleceu, sinalizando
que é infraestrutura de teste antes mesmo de olhar o diretório.

### Fake em vez de `Test::MockObject` para o Repository

`Test::MockObject` (já presente na estratégia de testes desde ADR-011) permanece a
ferramenta certa para **verificar uma interação pontual** com uma dependência externa
— por exemplo, confirmar que `$mq->publish` foi chamado com o payload esperado. Não é
a ferramenta certa para o Repository, porque validar uma regra como "não permitir
slug duplicado" exige **estado real entre chamadas** dentro do mesmo teste: inserir,
depois buscar, depois inserir de novo e observar a rejeição. Simular isso com
`Test::MockObject` exigiria capturar um array em closures manualmente a cada teste —
nesse ponto o teste já reimplementou uma Fake, só que sem a garantia de contrato que
`with 'Stega::Repository::Product';` oferece (a composição do role falha imediatamente
se a Fake não implementar todos os métodos `requires`, em vez de falhar tarde, em
runtime, dentro do código de domínio).

As duas ferramentas continuam coexistindo no `cpanfile`: `Test::MockObject` para
interações pontuais com serviços externos (chamadas HTTP), classes Fake
com `Moo::Role` para dependências com estado (Repository).

Referências: [Moo](../references/moo.md),
[Perldoc: Tutorial OO (perlootut)](../references/perldoc-perlootut.md),
[Mojolicious](../references/mojolicious.md)

### Exemplo completo

```perl
# lib/Stega/Repository/Product.pm — contrato
package Stega::Repository::Product;
use v5.42;
use utf8;
use Moo::Role;

requires qw(find_by_slug find_by_name insert);

1;
```

```perl
# lib/Stega/Repository/Pg/Product.pm — implementação real
package Stega::Repository::Pg::Product;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

with 'Stega::Repository::Product';

has db => (is => 'ro', required => 1);   # $c->pg->db

sub find_by_slug {
    my ($self, $slug) = @_;
    return $self->db->query('SELECT * FROM products WHERE slug = $1', $slug)->hash;
}

sub find_by_name {
    my ($self, $name) = @_;
    return $self->db->query('SELECT * FROM products WHERE name = $1', $name)->hash;
}

sub insert {
    my ($self, %attrs) = @_;
    return $self->db->query(
        'INSERT INTO products (name, slug, description) VALUES ($1, $2, $3) RETURNING *',
        $attrs{name}, $attrs{slug}, $attrs{description}
    )->hash;
}

1;
```

```perl
# t/lib/Stega/Test/Repository/Product.pm — Fake, só em teste
package Stega::Test::Repository::Product;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

with 'Stega::Repository::Product';

has _rows => (is => 'ro', default => sub { [] });

sub BUILDARGS {
    my ($class, %args) = @_;
    my $seed = delete $args{seed} // [];
    return { %args, _rows => $seed };
}

sub find_by_slug { my ($self, $slug) = @_; (grep { $_->{slug} eq $slug } @{ $self->_rows })[0] }
sub find_by_name { my ($self, $name) = @_; (grep { $_->{name} eq $name } @{ $self->_rows })[0] }

sub insert {
    my ($self, %attrs) = @_;
    push @{ $self->_rows }, { %attrs };
    return { %attrs };
}

1;
```

```perl
# lib/Stega/Domain/Product.pm — regra de negócio + orquestração
package Stega::Domain::Product;
use v5.42;
use utf8;
use Moo;
use namespace::autoclean;

has repository => (is => 'ro', required => 1);

sub create {
    my ($self, %attrs) = @_;

    die "Nome é obrigatório\n" unless $attrs{name};
    die "Slug é obrigatório\n" unless $attrs{slug};

    die "Já existe um produto com este slug\n"
        if $self->repository->find_by_slug($attrs{slug});
    die "Já existe um produto com este nome\n"
        if $self->repository->find_by_name($attrs{name});

    return $self->repository->insert(%attrs);
}

1;
```

```perl
# t/unit/domain/product.t — sem banco, sem Test::Mojo
use v5.42;
use utf8;
use Test::More;
use lib 't/lib';

use Stega::Domain::Product;
use Stega::Test::Repository::Product;

subtest 'rejeita slug duplicado' => sub {
    my $repo = Stega::Test::Repository::Product->new(
        seed => [{ name => 'Stega Demo', slug => 'stega-demo' }],
    );
    my $domain = Stega::Domain::Product->new(repository => $repo);

    eval { $domain->create(name => 'Outro Nome', slug => 'stega-demo') };
    like $@, qr/slug/, 'rejeita slug já existente';
};

done_testing;
```

```perl
# lib/Stega/Controller/Product.pm — Controller fica fino
sub api_create {
    my $c    = shift;
    $c->openapi->valid_input or return;
    my $role = ($c->stash('current_user') // {})->{role} // '';

    return $c->render(json => { error => 'Apenas admins' }, status => 403)
        unless Stega::Domain::TicketPolicy->can_manage_products($role);   # autorização

    my $domain = Stega::Domain::Product->new(
        repository => Stega::Repository::Pg::Product->new(db => $c->pg->db),
    );

    my $product = eval { $domain->create(%{ $c->req->json }) };           # validação + execução
    return $c->render(json => { error => $@ }, status => 422) if $@;

    $c->render(json => { data => $product }, status => 201);
}
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **`Test::MockObject` para o Repository** | Exigiria simular estado (inserir → buscar → rejeitar) manualmente via closures a cada teste, sem a garantia de contrato que `Moo::Role` oferece. Ver Justificativa |
| **Fake em `lib/`, ao lado da implementação real** | Mistura código de produção com código que só existe para testes; nenhuma convenção da comunidade Perl recomenda isso — o padrão estabelecido é `t/lib/` |
| **Aplicar o padrão a todas as entidades de uma vez** | Escopo grande demais para validar de uma vez; `User`, por exemplo, hoje só faz upsert simples por `keycloak_id` — pode não justificar a cerimônia de Domain+Repository. Piloto em `Product` primeiro (ver ADR-018 para o histórico da aplicação de demonstração) |
| **DBIx::Class ou outro ORM com validação embutida** | Já rejeitado em ADR-016 por razões mais amplas (auditabilidade de SQL explícito); não reconsiderado aqui |
| **Validação só a nível de constraint do banco (deixar o `UNIQUE` estourar)** | É o comportamento atual — produz 500 em vez de 422, sem mensagem útil ao cliente da API, e não é testável sem banco |

## Consequências

**Positivo**:
- Regras de validação de negócio (não só autorização) ficam testáveis sem banco
- `Stega::Model::*` ganha um uso real: pode ser o tipo de retorno das operações de
  Domain, em vez de permanecer código morto
- Contrato explícito (`Moo::Role`) entre Domain e Repository — implementações reais e
  Fake não podem divergir silenciosamente
- Controllers ficam mais finos: autorização (Policy) + validação/execução (Domain),
  sem SQL misturado com regra de negócio

**Negativo**:
- Mais arquivos por entidade (Role + Pg:: + Fake + Domain — 4 classes), risco de
  cerimônia desnecessária para entidades com regras triviais (ex.: `User`) — decisão
  deve ser caso a caso, não aplicada cegamente a toda entidade
- Duas ferramentas de teste com propósitos diferentes (`Test::MockObject` e classes
  Fake) exigem que a equipe saiba quando usar cada uma — documentado nesta ADR e no
  Guia 4

**Ações necessárias**:
- ✅ Implementado o piloto em `Product`: `Stega::Repository::Product`,
  `Stega::Repository::Pg::Product`, `Stega::Test::Repository::Product`,
  `Stega::Domain::Product`, `t/unit/domain/product.t`
- ✅ `Stega::Controller::Product` (`create` web e `api_create`) usa
  `Stega::Domain::Product` em vez de SQL inline
- ✅ Padrão validado no piloto e replicado para `Ticket`/`Comment` (ver
  "Revisão 2026-07-03" abaixo)
- ✅ Guia 4 (`docs/guides/04-modelos-de-dominio-e-regras-de-negocio.md`) atualizado com
  a distinção Policy vs Domain

## Revisão 2026-07-03 — Extensão para Ticket e Comment

O padrão piloto em `Product` foi replicado para `Ticket` e `Comment`, com um ajuste de
escopo em relação ao texto original desta ADR: a leitura atenta dos guias já escritos
(Guia 5, em particular) mostrou que a frase "SQL explícito nos Controllers" (usada para
resumir a ADR-016) e o próprio piloto de `Product` — que só moveu para o Domain a ação
de `create`, deixando `index`, `update` e `api_list` com SQL direto no Controller —
davam a entender que o Repository seria só uma camada estreita, usada apenas quando há
uma regra de validação a proteger. Isso contradiz o objetivo declarado nas
Consequências desta própria ADR ("Controllers ficam mais finos... sem SQL misturado com
regra de negócio"): um Controller que ainda tem metade das suas ações em SQL cru não é
fino nesse sentido.

**Ajuste de escopo**: para `Ticket` e `Comment`, o Repository passou a cobrir **todo**
o acesso a dados da entidade — leituras (listagens, buscas com filtro, joins para a
tela de detalhe) e escritas, não só as ações com regra de validação. Controllers destas
duas entidades não chamam `$c->pg->db` diretamente em nenhum método;
`Stega::Repository::Pg::Ticket` e `Stega::Repository::Pg::Comment` concentram todo o
SQL. `Product` não foi retrofitado nesta rodada inicial — `index`, `update` e
`api_list` continuavam com SQL direto no Controller, uma inconsistência conhecida entre
as três entidades. **Fechada ainda em 2026-07-03** (mesmo dia, ver "Ações necessárias"
abaixo): `Product` também passou pelo retrofit, eliminando a inconsistência.

**Quando o Domain entra, dentro desse Repository mais amplo**: nem toda escrita precisa
de uma classe `Domain::*` — só entra quando há uma validação que depende de consultar o
estado atual dos dados (não apenas o papel do usuário, que é Policy). Por isso:
- `Stega::Domain::Ticket` tem três métodos: `create` (produto deve existir e estar
  ativo — BUSINESS.md: "Tickets são sempre vinculados a um produto ativo", regra
  documentada mas nunca implementada até agora), `assign` (responsável deve ser um
  usuário com papel `agent` — mesma classe de bug do slug duplicado do piloto original:
  a ausência dessa checagem não quebrava nada visivelmente, só permitia um estado
  inválido) e `change_status` (evita gravar um evento de auditoria redundante quando o
  novo status é igual ao atual — uma regra pequena, mas ainda assim dependente de
  estado, não de papel).
- Arquivar um ticket (`api_delete`) e editar o corpo de um comentário (`api_update` de
  Comment) **não** passam por um Domain — não há nenhuma validação além de autorização
  (Policy) e existência (404), então o Controller chama o Repository diretamente. Criar
  uma classe Domain sem nenhuma regra real seria a cerimônia desnecessária que a seção
  "Alternativas Consideradas" já rejeitava para `User`.
- `Stega::Domain::Comment` tem um único método (`create`): o corpo do ticket referenciado
  deve existir (evita um 500 por violação de `FOREIGN KEY` — mesma classe de bug, desta
  vez entre `comments` e `tickets`).

Essas três checagens (produto ativo, papel do responsável, ticket existente para
comentário) eram gaps reais no código antes desta revisão — nenhuma delas quebrava os
testes existentes porque nenhum teste exercitava o caminho inválido correspondente.
Validado via `curl` contra a aplicação real em Docker: `POST /api/v1/tickets` com
`product_id` inexistente devolve `422 {"error":"Produto inválido ou inativo\n"}` (antes
seria 500 por violação de `FOREIGN KEY`); `POST /api/v1/tickets/{id}/comments` com
`ticket_id` inexistente devolve `404 {"error":"Ticket não encontrado\n"}` (antes 500).

Adicionalmente, `Stega::Domain::TicketPolicy->valid_priority` já existia e era testada
unitariamente desde a ADR-011, mas nunca era chamada por nenhum Controller. Passou a ser
checada em `create`/`api_update`/`api_create`, no mesmo estilo que `valid_status` já
usava. **Correção sobre o alcance real desse gap**, descoberta só ao validar via `curl`
contra a aplicação de verdade (não só lendo o código): a rota de API já estava protegida
— `api/stega.yaml` já declarava `priority` como `enum: [low, medium, high, critical]` no
schema de `requestBody`, e o plugin `Mojolicious::Plugin::OpenAPI` já rejeitava valores
fora da lista com `400` antes mesmo do Controller ser chamado — confirmado enviando
`priority: "urgentissimo"`, que devolve `400` com uma mensagem de erro do tipo "Not in
enum list", nunca chegando no meu código novo. O gap real
estava só na rota **web** (`Stega::Controller::Ticket::create`, formulário HTML) — essa
rota não passa pelo plugin OpenAPI (validação automática é só para `/api/*`), então um
POST direto e adulterado para `/tickets` com uma prioridade fora da lista era aceito sem
checagem nenhuma. É essa rota que o novo `valid_priority` no Controller efetivamente
protege; nas rotas de API a chamada é redundante com o schema (inofensiva, mas não é o
que corrige um bug ali).

**Ações necessárias (revisão)**:
- ✅ `Stega::Repository::Ticket` (role) + `Stega::Repository::Pg::Ticket` +
  `Stega::Test::Repository::Ticket` + `Stega::Domain::Ticket` +
  `t/unit/domain/ticket.t`
- ✅ `Stega::Repository::Comment` (role) + `Stega::Repository::Pg::Comment` +
  `Stega::Test::Repository::Comment` + `Stega::Domain::Comment` +
  `t/unit/domain/comment.t`
- ✅ `Stega::Controller::Ticket` e `Stega::Controller::Comment` sem nenhuma chamada
  direta a `$c->pg->db->query`
- ✅ `Stega::Repository::Product` ganhou `list_active` (usado pelo formulário de novo
  ticket, que lista produtos ativos — não é retrofit do Product em si, só uma leitura
  nova que já nasce no Repository correto)
- ✅ **Retrofit do Product concluído em 2026-07-03**: `Stega::Repository::Product`
  ganhou `list_all`, `find` e `update_fields`; `Stega::Controller::Product::index`,
  `update` e `api_list` não chamam mais `$c->pg->db` diretamente. `list_active` foi
  ampliado de `SELECT id, name` para `SELECT *` (a mesma projeção que `api_list` já
  usava antes, direto no Controller) — passa a servir os dois consumidores (dropdown
  do Guia 3 e `api_list`) com um único método. `update_fields` usa `RETURNING *` em vez
  de um `SELECT` separado após o `UPDATE` — remove um round-trip que o código anterior
  fazia. Nenhum método de `Domain::Product` foi adicionado para essas ações: nem
  `index`/`list_active` (leitura, sem regra) nem `update` (escrita sem validação de
  estado) têm uma regra de negócio a proteger — mesma linha de corte já aplicada a
  `Ticket::archive` e `Comment` (editar corpo), ver acima. Todas as três entidades
  (`Product`, `Ticket`, `Comment`) ficam coerentes: Repository cobre 100% do acesso a
  dados; Domain só onde há validação de estado.

## Revisão 2026-07-03 (continuação) — User e Dashboard

Ao revisar quais Controllers ainda tinham SQL direto após o retrofit de `Product`,
restavam `Stega::Controller::Auth` (6 queries), `Stega::Controller::User` (3) e
`Stega::Controller::Dashboard` (2) — todos sobre a tabela `users` (Auth/User) ou uma
leitura de `tickets` específica de dashboard. `Stega::Controller::Health` (1 query,
`SELECT 1` para checar conectividade) e `Stega::Controller::Webhook` (0 queries, só
enfileira jobs Minion) ficam de fora: não são acesso a uma entidade, são um health
check de infraestrutura e um receptor assíncrono, respectivamente — o padrão não se
aplica a eles.

**Achado ao ler `Auth.pm` de perto**: havia **duas implementações divergentes** da
mesma operação de sincronizar usuário a partir do JWT. `require_jwt` (chamado em toda
requisição autenticada da API) fazia um `INSERT ... ON CONFLICT (keycloak_id) DO UPDATE`
atômico, mas descartava a informação de "usuário novo ou existente"
(`RETURNING id` apenas). `_sync_user` (chamado só no `callback` do fluxo OAuth web)
fazia um `SELECT` seguido de `UPDATE` ou `INSERT` em instruções separadas — não-atômico,
sujeito a condição de corrida em dois logins concorrentes do mesmo usuário novo — só
para conseguir computar `is_first_login` (usado para decidir se enfileira o job de
e-mail de boas-vindas). Duas rotas de entrada, duas lógicas de upsert que podiam
divergir silenciosamente com o tempo.

**Correção**: `Stega::Repository::Pg::User::upsert_from_keycloak` unifica as duas em um
único `INSERT ... ON CONFLICT DO UPDATE ... RETURNING id, ..., (xmax = 0) AS is_first_login`
— `xmax = 0` é o idioma padrão do Postgres para saber, dentro do
próprio `RETURNING`, se a linha foi inserida ou atualizada nesta mesma instrução,
eliminando o `SELECT` prévio não-atômico. Validado diretamente via `psql`: duas
chamadas consecutivas com o mesmo `keycloak_id` devolvem `is_first_login = t` na
primeira e `f` na segunda, preservando o mesmo `id`. `require_jwt` e `callback` (fluxo
API e fluxo web) passam a chamar o mesmo método.

**`Stega::Repository::User`** (role): `find`, `find_for_api` (projeção pública, exclui
`keycloak_id` — preservado exatamente como o `Controller::User::api_show` original já
fazia), `find_by_keycloak_id`, `list_all`, `list_for_api`, `update_avatar`,
`upsert_from_keycloak`. Sem `Domain::User`: a sincronização a partir de um JWT já
validado não tem uma regra de estado a proteger além da autorização (já resolvida antes
de chegar aqui) — mesma linha de corte já aplicada a `Ticket::archive`/`Comment`
(editar)/`Product::update`. Sem Fake em `t/lib/`: nenhum teste unitário consome
`Stega::Repository::User` hoje (não há `Domain::User`); criar uma Fake sem consumidor
seria código morto — pode ser adicionada quando (e se) surgir um teste que precise dela.

**Dashboard**: as duas queries de listagem (visão do customer, visão do
agent/admin com ordenação por prioridade) migraram para
`Stega::Repository::Pg::Ticket::list_for_dashboard`, um novo método requerido pelo role
`Stega::Repository::Ticket` — SQL idêntico ao que já existia no Controller, sem
alteração de comportamento. Validado diretamente via `psql` contra o banco populado
pelo seed (ver Ações necessárias); não há teste automatizado para `Dashboard::index`
porque a rota depende de sessão web (não de bearer JWT), e a suíte atual só popula
sessão via JWT — mesma lacuna que já existia antes desta mudança, não introduzida por
ela.

**Ações necessárias (2026-07-03, continuação)**:
- ✅ `Stega::Repository::User` (role) + `Stega::Repository::Pg::User`; sem Fake (sem
  consumidor ainda)
- ✅ `Stega::Controller::Auth` e `Stega::Controller::User` sem nenhuma chamada direta a
  `$c->pg->db->query`; `_sync_user` (implementação divergente) removida
- ✅ `Stega::Repository::Pg::Ticket` ganhou `list_for_dashboard`;
  `Stega::Controller::Dashboard` sem SQL direto
- ✅ Validado via `psql` direto (upsert idempotente com `is_first_login` correto nas
  duas chamadas; as duas queries de dashboard) e via suíte completa
  (75 testes, `Result: PASS`)
- Únicos Controllers com SQL direto remanescentes: `Health` (health check de
  infraestrutura, não é acesso a entidade) e `Webhook` (não toca banco)

### Correção 2026-07-03 (mesmo dia, achado posterior) — a unificação acima estava incompleta

O parágrafo "Achado ao ler `Auth.pm` de perto" acima e a linha de "Ações necessárias"
que citam `require_jwt` como um dos dois consumidores reais do upsert unificado estão
**errados**. Ao investigar um pedido do usuário sobre centralização de configuração
(variáveis de ambiente espalhadas), um `grep -rn "require_jwt"` no repositório mostrou
que esse método **nunca é referenciado por nenhuma rota** — é código morto. O caminho
que de fato roda em toda requisição de API autenticada é o handler `bearerAuth`
(dentro do bloco `security` passado ao plugin OpenAPI) em `_setup_openapi`, em
`lib/Stega.pm`, que **não** tinha
sido tocado na revisão anterior e ainda continha sua própria cópia inline do upsert
original (`INSERT ... ON CONFLICT ... RETURNING id`, sem `is_first_login`). Ou seja,
havia **três** implementações divergentes do mesmo upsert, não duas — e a correção
anterior atualizou a que nunca executa, deixando intacta a que executa de verdade.

Corrigido: o handler `bearerAuth` agora chama
`Stega::Repository::Pg::User::upsert_from_keycloak`; `require_jwt` foi removida de
`Stega::Controller::Auth` (código morto, sem uso documentado ou histórico que
justificasse mantê-la). Os dois consumidores reais de `upsert_from_keycloak` são
`Stega::Controller::Auth::callback` (fluxo web OAuth) e o handler `bearerAuth` em
`lib/Stega.pm` (fluxo de API) — validado via suíte completa (75 testes, `Result: PASS`,
toda requisição autenticada de todo teste passa pelo `bearerAuth` corrigido).

Fica registrado como lembrete: ao "unificar" uma duplicação, confirmar primeiro que
todos os pontos identificados como consumidores são realmente exercitados em produção
(`grep` pelo nome do método/rota, não assumir pela leitura do código) — do contrário, a
correção pode alcançar só o código morto e deixar o caminho real intocado.
