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

```perl
# lib/Stega/Controller/Ticket.pm
package Stega::Controller::Ticket;
use Mojo::Base 'Mojolicious::Controller';

sub list {
    my $self = shift;

    # Parâmetros de query: GET /api/v1/tickets?status=open&q=erro
    my $status = $self->param('status') // 'open';
    my $query  = $self->param('q');

    # Acesso ao banco (configurado no startup como helper)
    my $tickets = $self->pg->db->query(
        'SELECT id, title, status FROM tickets WHERE status = ?', $status
    )->hashes->to_array;

    $self->render(json => $tickets);
}

sub show {
    my $self = shift;
    my $id   = $self->param('id');    # parâmetro de rota :id

    my $ticket = $self->pg->db->query(
        'SELECT * FROM tickets WHERE id = ?', $id
    )->hash;

    return $self->render(json => { error => 'not_found' }, status => 404)
        unless $ticket;

    $self->render(json => $ticket);
}

sub create {
    my $self = shift;
    my $body = $self->req->json;      # body JSON da requisição

    # Validação pelo plugin OpenAPI acontece antes deste método ser chamado
    my $id = $self->pg->db->insert('tickets',
        { title => $body->{title}, body => $body->{body}, status => 'open' },
        { returning => 'id' }
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

## Armadilhas comuns

| Armadilha | Descrição | Como evitar |
|-----------|-----------|-------------|
| Bloquear o event loop | Chamadas síncronas bloqueantes (sleep, IO síncrono) pausam todos os workers | Use `Mojo::UserAgent` não-bloqueante ou Minion para tarefas longas |
| Esquecer `return` em `under` | Um `under` que não retorna valor falso/undef permite requisições não autenticadas | Sempre `return undef` ou `return 0` para rejeitar |
| Templates sem escape | `<%= $input %>` escapa HTML; `<%== $input %>` não — risco de XSS | Use `<%= %>` por padrão; `<%== %>` apenas para HTML interno confiável |
| `carton exec` omitido | O `daemon` inicia com o Perl do sistema, sem os módulos do Carton | Sempre `carton exec perl script/stega ...` |
| Reinicialização com `daemon` | Em produção, `daemon` não tem recarga sem interrupção — use Hypnotoad | `daemon` é apenas para desenvolvimento |
