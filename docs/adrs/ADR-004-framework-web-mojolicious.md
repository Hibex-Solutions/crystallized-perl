# ADR-004: Framework Web — Mojolicious

**Status**: Aceita  
**Data**: 2026-06-27

## Contexto

O stack precisa de um framework web para construir APIs HTTP, aplicações com
server-rendered HTML e suporte a WebSocket. O framework deve ser:

- Compatível com uma arquitetura cloud-native (sem estado, 12-factor compliant)
- Capaz de lidar com I/O assíncrono nativamente
- Completo o suficiente para cobrir roteamento, templates, cliente HTTP e testes sem
  exigir a composição manual de dezenas de bibliotecas independentes
- Mantido ativamente e com documentação de qualidade

## Decisão

**Mojolicious** como framework web completo, com **Hypnotoad** como servidor HTTP de
produção.

## Justificativa

Mojolicious é a única stack Perl que oferece — em um único pacote sem dependências
externas além do core do Perl — roteamento, servidor HTTP assíncrono, suporte nativo
a WebSocket, motor de templates, cliente HTTP não-bloqueante e framework de testes. Isso
reduz a composição manual de componentes e garante que as peças se integrem sem fricção.

**Hypnotoad** é o servidor de produção embutido no Mojolicious. Ele usa um modelo de
pre-forking de workers, o que é compatível com os Liveness e Readiness Probes do
Kubernetes — o processo principal permanece vivo para gerenciar os workers, enquanto
os workers atendem as requisições. O Hypnotoad suporta reinicializações sem interrupção via SIGUSR2,
o que permite atualizações de Pods sem indisponibilidade de serviço.

**Mojo::UserAgent**, o cliente HTTP embutido, é não-bloqueante e usa o mesmo event loop
do framework — essencial para chamadas inter-serviços (ex.: obter tokens do Keycloak)
sem bloquear o processo principal.

**Test::Mojo**, também embutido, permite testar rotas HTTP completas sem subir um
servidor real — as requisições atravessam o dispatcher do Mojolicious em memória.

Referências: [Mojolicious](../references/mojolicious.md),
[The Twelve-Factor App](../references/twelve-factor-app.md),
[Modern Perl](../references/modern-perl-book.md)

### Estrutura padrão de uma aplicação Mojolicious

```
my_app/
├── cpanfile
├── cpanfile.snapshot
├── script/
│   └── my_app.pl        ← ponto de entrada
├── lib/
│   ├── MyApp.pm         ← classe principal (herda Mojolicious)
│   └── MyApp/
│       └── Controller/
│           └── Health.pm
├── t/
│   └── health.t
└── Dockerfile
```

### Aplicação mínima

```perl
# lib/MyApp.pm
package MyApp;
use Mojo::Base 'Mojolicious';

sub startup {
    my $self = shift;

    my $r = $self->routes;

    # Rota de health check para probes do Kubernetes
    $r->get('/healthz')->to('health#check');

    # Prefixo de API versionada
    my $api = $r->under('/api/v1');
    $api->get('/users')->to('user#list');
    $api->post('/users')->to('user#create');
}

1;
```

```perl
# script/my_app.pl
#!/usr/bin/env perl
use Mojo::Base -strict;

use lib 'lib';
use MyApp;

MyApp->new->start;
```

```perl
# lib/MyApp/Controller/Health.pm
package MyApp::Controller::Health;
use Mojo::Base 'Mojolicious::Controller';

sub check {
    my $self = shift;
    $self->render(json => { status => 'ok' });
}

1;
```

### Servidor de desenvolvimento vs. produção

```bash
# Desenvolvimento: servidor com recarga automática
carton exec perl script/my_app.pl daemon --listen http://*:3000

# Produção: Hypnotoad com pre-forking
carton exec hypnotoad script/my_app.pl

# Implantação gradual sem interrupção: basta rodar novamente (detecta instância existente e envia SIGUSR2)
carton exec hypnotoad script/my_app.pl
```

### Configuração do Hypnotoad

```perl
# my_app.pl: configuração do Hypnotoad como parte do startup
my $hypnotoad = $self->config('hypnotoad');
$hypnotoad //= {};
$hypnotoad->{listen} //= ['http://*:8080'];
$hypnotoad->{workers} //= 4;
$self->config(hypnotoad => $hypnotoad);
```

Ou via arquivo de configuração `my_app.conf`:

```perl
{
    hypnotoad => {
        listen  => ['http://*:8080'],
        workers => 4,
        pid_file => '/tmp/hypnotoad.pid',
    }
}
```

### Workers de background

Workers assíncronos (consumidores de fila) usam a mesma imagem Docker da API, mas
com um comando de entrada diferente:

```dockerfile
# Na API:
CMD ["carton", "exec", "hypnotoad", "-f", "script/my_app.pl"]

# No Worker (mesmo Dockerfile, command sobrescrito no Kubernetes):
# command: ["carton", "exec", "perl", "script/worker.pl"]
```

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| **Catalyst** | Framework maduro mas pesado: muitas dependências externas, curva de aprendizado acentuada, sem suporte async nativo |
| **Dancer2** | Mais simples que o Mojolicious mas sem suporte a WebSocket, sem cliente HTTP embutido e sem servidor de produção integrado |
| **Plack/PSGI com micro-frameworks** | Requer composição manual de router, servidor, cliente HTTP e testes — nenhum componente integra nativamente com os outros |
| **Raku (Perl 6)** | Linguagem diferente; fora do escopo do projeto (Perl 5 moderno) |

## Consequências

**Positivo**:
- Um único módulo CPAN provê toda a stack HTTP: roteamento, servidor, cliente e testes
- Hypnotoad é compatível com Kubernetes (pre-fork, SIGUSR2 reload)
- Mojo::UserAgent não-bloqueante elimina a necessidade de um cliente HTTP separado
- Test::Mojo permite testes de integração rápidos sem overhead de servidor

**Negativo**:
- Curva de aprendizado inicial: o modelo de event loop do Mojo é diferente do Perl
  procedural tradicional
- Código assíncrono com callbacks ou Promises requer atenção para não bloquear o loop

**Ações necessárias**:
- Definir sistema de OO para modelos de domínio (ADR-006)
- Definir contrato de API OpenAPI v3 com o plugin Mojolicious (ADR-015)
- Configurar Hypnotoad nos Deployments Kubernetes com probes apontando para `/healthz`
