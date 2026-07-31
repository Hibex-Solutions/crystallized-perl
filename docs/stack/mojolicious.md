---
sidebar_position: 2
title: Mojolicious + Hypnotoad
---

# Mojolicious + Hypnotoad

> **Decisão**: Mojolicious como framework web completo, Hypnotoad como servidor
> HTTP de produção.
> [ADR-004 — Framework Web Mojolicious](/adrs/ADR-004-framework-web-mojolicious)

---

## Por que Mojolicious

Um único módulo CPAN sem dependências externas além do core do Perl cobre:
roteamento, servidor HTTP assíncrono (event loop), WebSocket, motor de templates,
cliente HTTP não-bloqueante (`Mojo::UserAgent`) e framework de testes
(`Test::Mojo`). Isso elimina a composição manual de componentes que não integram
entre si — o problema central de abordagens Plack/PSGI com micro-frameworks.

O Hypnotoad usa pre-forking de workers, compatível com os probes de Liveness e
Readiness do Kubernetes. Reinicializações sem interrupção via `SIGUSR2` permitem
atualizações de Pods sem indisponibilidade.

---

## Comandos essenciais

```bash
# Desenvolvimento — recarga automática de código
carton exec perl script/stega daemon --listen http://*:3000

# Produção — Hypnotoad pre-fork
carton exec hypnotoad script/stega

# Reimplantar sem interrupção (detecta instância existente)
carton exec hypnotoad script/stega

# Parar o Hypnotoad
carton exec hypnotoad --stop script/stega

# Inspecionar rotas registradas
carton exec perl script/stega routes

# Shell interativo com app carregada (debug)
carton exec perl script/stega eval 'say $app->home'
```

---

## Estrutura de uma aplicação Mojolicious

```perl
# lib/Stega.pm — classe principal
package Stega;
use Mojo::Base 'Mojolicious';

sub startup {
    my $self = shift;

    # 1. Configuração
    my $config = $self->plugin('Config', { default => {} });

    # 2. Plugins
    $self->plugin('OpenAPI', { url => $self->home->child('api/stega.yaml') });
    $self->plugin('Minion',  Pg => $self->pg);

    # 3. Hooks
    $self->hook(before_dispatch => \&_authenticate);

    # 4. Rotas
    my $r = $self->routes;
    $r->get('/healthz')->to('health#check');

    my $api = $r->under('/api/v1')->to(cb => sub {
        my $c = shift;
        return 1 if $c->stash('jwt_claims');  # autenticado
        $c->render(json => { error => 'unauthorized' }, status => 401);
        return undef;
    });
    $api->get('/tickets')->to('ticket#list');
    $api->post('/tickets')->to('ticket#create');
}

1;
```

---

## Roteamento

```perl
my $r = $self->routes;

# Rota simples
$r->get('/healthz')->to('health#check');

# Parâmetros na URL
$r->get('/api/v1/tickets/:id')->to('ticket#show');

# Under — middleware aplicado a um grupo
my $api = $r->under('/api/v1')->to('auth#validate');
$api->get('/tickets')->to('ticket#list');
$api->post('/tickets')->to('ticket#create');
$api->patch('/tickets/:id')->to('ticket#update');

# Websocket
$r->websocket('/ws')->to('ws#connect');

# Qualquer método
$r->any(['GET', 'HEAD'] => '/ping')->to(cb => sub {
    my $c = shift;
    $c->render(text => 'pong');
});
```

---

## Controllers

Exemplo genérico — ilustra a forma de um Controller Mojolicious, não uma cópia do
Controller real da Stega. O real (`Stega::Controller::Ticket`) usa placeholders
posicionais (`$1`, `$2`, o estilo que `DBD::Pg` espera, não `?`) e, desde a extensão do
padrão Domain + Repository (ver [ADR-020](/adrs/ADR-020-dominio-e-repository) e
[Mojo::Pg](/stack/mojo-pg)), não chama `$c->pg->db` diretamente — delega a uma classe
`Stega::Repository::Pg::Ticket`.

```perl
# lib/MyApp/Controller/Ticket.pm
package MyApp::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';

sub list {
    my $self = shift;

    # Parâmetros de query: GET /api/v1/tickets?status=open&q=erro
    my $status = $self->param('status') // 'open';
    my $query  = $self->param('q');

    # Acesso ao banco (configurado no startup como helper)
    my $tickets = $self->pg->db->query(
        'SELECT id, title, status FROM tickets WHERE status = $1', $status
    )->hashes;

    $self->render(json => $tickets);
}

sub show {
    my $self = shift;
    my $id   = $self->param('id');    # parâmetro de rota :id

    my $ticket = $self->pg->db->query(
        'SELECT * FROM tickets WHERE id = $1', $id
    )->hash;

    return $self->render(json => { error => 'not_found' }, status => 404)
        unless $ticket;

    $self->render(json => $ticket);
}

sub create {
    my $self = shift;
    my $body = $self->req->json;      # body JSON da requisição

    # Validação pelo plugin OpenAPI acontece antes deste método ser chamado
    my $id = $self->pg->db->query(
        'INSERT INTO tickets (title, body, status) VALUES ($1, $2, $3) RETURNING id',
        $body->{title}, $body->{body}, 'open'
    )->hash->{id};

    $self->render(json => { id => $id }, status => 201);
}

1;
```

---

## Acesso a dados da requisição

```perl
# Parâmetros
$self->param('name');                    # query string ou form
$self->every_param('tags');              # valores múltiplos
$self->req->json;                        # body JSON
$self->req->json('/data/0/name');        # JSON Pointer
$self->req->body;                        # body bruto

# Headers
$self->req->headers->authorization;     # Authorization: Bearer ...
$self->req->headers->content_type;

# Stash — dados passados entre rotas, hooks e templates
$self->stash('jwt_claims');             # lido por controllers filhos
$self->stash(ticket => $ticket);        # passado para template
```

---

## Templates (server-rendered HTML)

```perl
# Controller — renderizar template
$self->render('tickets/show', ticket => $ticket);

# Template: templates/tickets/show.html.ep
# %= é equivalente a <%= ... %> — exibe com escape HTML
<h1><%== $ticket->{title} %></h1>   <!-- <%== sem escape — para HTML interno -->
<p>Status: <%= $ticket->{status} %></p>

% # bloco Perl
% for my $comment (@{$comments}) {
  <div><%= $comment->{body} %></div>
% }
```

```
templates/
├── layouts/
│   └── default.html.ep    ← layout padrão
├── tickets/
│   ├── list.html.ep
│   └── show.html.ep
└── auth/
    └── login.html.ep
```

---

## Configuração do Hypnotoad

```perl
# stega.conf
{
    hypnotoad => {
        listen   => ['http://*:8080'],
        workers  => 4,             # número de processos worker
        pid_file => '/tmp/hypnotoad.pid',
        # accepts => 10000,        # conexões por worker antes de reciclar
        # proxy  => 1,             # se estiver atrás de proxy reverso
    }
}
```

```dockerfile
# Dockerfile — comando de produção
CMD ["carton", "exec", "hypnotoad", "-f", "script/stega"]
# -f: foreground (não daemoniza — necessário para Docker/Kubernetes)
```

---

## Helpers customizados

```perl
# Em startup() — registrar helper disponível em todos os controllers
$self->helper(current_user => sub {
    my $c = shift;
    return $c->stash('jwt_claims');
});

# Em qualquer controller
my $user = $self->current_user;
```

---

## Mojo::JSON — `to_json`/`from_json` vs. `encode_json`/`decode_json`

O [`Mojo::JSON`](https://mojolicious.org/) (parte do Mojolicious — ver a
[referência oficial](/references/mojolicious)) exporta dois pares de funções que
fazem "a mesma coisa" com uma diferença crucial: **de que lado da fronteira de
codificação a string JSON está**.

| | A string JSON é **bytes** (UTF-8) | A string JSON é **caracteres** |
|---|---|---|
| Serializar estrutura Perl → JSON | `encode_json($ref)` | `to_json($ref)` |
| Desserializar JSON → estrutura Perl | `decode_json($str)` | `from_json($str)` |

O modelo mental que resolve todos os casos: **dentro do processo Perl, texto é
uma sequência de caracteres; bytes só existem nas bordas** (socket, arquivo,
pipe). Cada borda codifica/decodifica exatamente uma vez — e cada borda já tem
um dono:

- **HTTP**: o próprio Mojolicious. `$c->req->json` decodifica o corpo da
  requisição; `$c->render(json => ...)` codifica a resposta. Nesses fluxos não
  se chama nada do `Mojo::JSON` diretamente.
- **PostgreSQL**: o `DBD::Pg` (`pg_enable_utf8`). Valores lidos do banco chegam
  como **caracteres**; valores passados como bind são codificados na saída.
  Logo, todo JSON que **vem do banco ou vai para ele** está do lado dos
  caracteres — território de `from_json`/`to_json`, nunca de
  `decode_json`/`encode_json`. O [Mojo::Pg](/stack/mojo-pg) já embute o par
  certo: `->expand` decodifica colunas `json`/`jsonb` com `from_json`, e o
  marcador de bind `{ json => $ref }` serializa com `to_json`.
- **STDOUT/STDERR com camada `:encoding(UTF-8)`** (`use open ':std', ...`,
  padrão dos processos da Stega): a camada é a borda — imprima caracteres.

Errar o lado produz duas famílias de sintomas, e só texto **acentuado** as
revela (ASCII puro passa ileso — por isso o erro parece intermitente):

- `decode_json` sobre caracteres já decodificados: morre com
  `Input is not UTF-8 encoded` (fallback puro-Perl do Mojo::JSON),
  `malformed UTF-8 character` ou `Wide character in subroutine entry` (quando o
  `Cpanel::JSON::XS` está instalado) — três mensagens, uma única causa.
- `encode_json` entregue a uma borda que codifica de novo (camada `:encoding`,
  bind do DBD::Pg): **dupla codificação** — `"canção"` vira `"canÃ§Ã£o"`.

Guia rápido para o dia a dia:

| Situação | Use |
|----------|-----|
| Corpo de requisição/resposta HTTP em Controller | `$c->req->json` / `$c->render(json => ...)` — o framework cuida da borda |
| Corpo HTTP **bruto** (`$c->req->body`, ex.: conferir HMAC de webhook antes de interpretar) | `decode_json` (o corpo bruto é bytes) |
| Coluna `json`/`jsonb` lida via Mojo::Pg | `->expand` no resultado |
| Texto JSON vindo do banco por outro caminho (`->>` , payload `text` do [PgQue](/stack/pgque)) | `from_json` |
| Gravar estrutura Perl em coluna `jsonb` | marcador `{ json => $ref }` no bind do Mojo::Pg — nunca `encode_json` manual |
| Registrar uma estrutura no log (STDOUT/STDERR com `:encoding(UTF-8)`) | `to_json` |
| Ler/escrever **arquivo** JSON aberto sem camada de encoding | `decode_json`/`encode_json` |

Não é distinção teórica: a Stega conviveu semanas com um "bug de UTF-8"
intermitente registrado como corrupção de leitura do banco, cuja causa raiz era
`decode_json` aplicado a payloads que o DBD::Pg já tinha decodificado —
diagnóstico completo na nota "Correção (2026-07-31)" do
[estudo anexo à ADR-022](../adrs/references/ADR-022-estudo-filas-postgresql.md).

---

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Bloquear o event loop | Chamadas síncronas bloqueantes (sleep, IO síncrono) pausam todos os workers | Use `Mojo::UserAgent` não-bloqueante ou Minion para tarefas longas |
| `decode_json`/`encode_json` em dado que não é bytes | Sobre valores vindos do banco ou destinados a saídas com `:encoding`, falha em texto acentuado ou gera mojibake | Ver a seção Mojo::JSON acima — `from_json`/`to_json` dentro do processo; `decode_json`/`encode_json` só nas bordas de bytes |
| Esquecer `return` em `under` | Um `under` que não retorna valor falso/undef permite requisições não autenticadas | Sempre `return undef` ou `return 0` para rejeitar |
| Templates sem escape | `<%= $input %>` escapa HTML; `<%== $input %>` não — risco de XSS | Use `<%= %>` por padrão; `<%== %>` apenas para HTML interno confiável |
| `carton exec` omitido | O `daemon` inicia com o Perl do sistema, sem os módulos do Carton | Sempre `carton exec perl script/stega ...` |
| Reinicialização com `daemon` | Em produção, `daemon` não tem recarga sem interrupção — use Hypnotoad | `daemon` é apenas para desenvolvimento |
