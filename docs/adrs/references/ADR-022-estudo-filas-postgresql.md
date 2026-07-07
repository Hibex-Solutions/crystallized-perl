---
unlisted: true
---

# Estudo: Filas em PostgreSQL vs RabbitMQ — anexo à ADR-022

> Este documento é material de apoio à [ADR-022](../ADR-022-filas-em-postgresql.md)
> (status **Proposta** — decisão ainda não aceita). Não é, em si, uma ADR: não
> registra uma decisão, reúne o levantamento técnico que fundamenta a proposta,
> para que o usuário decida com informação completa. Nada neste documento entra
> em vigor por conta própria — só o que a ADR-022 formalmente decidir, e só quando
> seu status mudar para `Aceita`.

> **Nota sobre topologia**: este estudo (e a ADR-022) tratam do *mecanismo* de
> filas, assumindo — salvo indicação em contrário — a mesma instância PostgreSQL
> que já hospeda dados relacionais e JSONB. Se a Stega/PgQue viveriam numa
> instância dedicada (`db-events`, separada de `db-app` e de `db-jobs`) é decidido
> à parte, na [ADR-023](../ADR-023-topologia-de-instancias-postgresql.md)
> (também `Proposta`) — leia as duas antes de avaliar o impacto de infraestrutura
> completo.

**Data do levantamento**: 2026-07-04 a 2026-07-07
**Fontes**: documentação oficial do PostgreSQL 17, os sites/repositórios oficiais
de PgQue e PgQ, o código-fonte de `Minion::Backend::Pg`, MetaCPAN, GitHub (incluindo
issues), e artigos técnicos de PlanetScale e Crunchy Data sobre filas em Postgres em
produção. Todas as citações literais abaixo foram confirmadas por acesso direto às
fontes (não por conhecimento de treinamento) — a seção 12 lista o que foi e o que
não foi confirmado por acesso direto.

---

## 1. A motivação real: o problema com RabbitMQ no ecossistema Perl

A [ADR-008](../ADR-008-message-broker-rabbitmq.md) define RabbitMQ como message
broker, acessado via `Net::AMQP::RabbitMQ`. Na prática de desenvolvimento local,
isso já exige uma exceção documentada — o [Guia 8](../../guides/08-rabbitmq-e-minion.md)
traz esta nota:

> "`Net::AMQP::RabbitMQ` embute um cliente C (`rabbitmq-c`) que assume `poll()`
> disponível — ausente no MinGW/Winsock (só existe `WSAPoll()`, nome e assinatura
> diferentes). O `cpanm install` falha com `undefined reference to 'poll'`, e não há
> flag que resolva (`--notest`/`--force` não ajudam — é falha de link, não de teste)."

Isso não é um problema isolado do ambiente da equipe. É documentado externamente:

| Módulo | Tipo | Situação verificada |
|--------|------|---------------------|
| `Net::AMQP::RabbitMQ` | XS, embute `librabbitmq` C | Versão atual **2.40014** (2024-11-09). A própria documentação do MetaCPAN afirma que o build compila a `librabbitmq` junto — não é opcional linkar contra uma já instalada. Suporte a Windows **não é mencionado** na documentação; o ambiente de teste do projeto aparenta ser limitado a GNU/Linux. Mantenedor único (bus factor 1). Falha de build no Windows é **documentada externamente** na issue [#144 "Compilation error on CPAN @ Windows 10"](https://github.com/net-amqp-rabbitmq/net-amqp-rabbitmq/issues/144) *(tradução: "Erro de compilação no CPAN @ Windows 10")* — ambiente Windows 10 x64, Strawberry Perl 5.20.3 (64int), falha de link (`undefined reference` a símbolos da `librabbitmq`: `_imp__amqp_empty_table`, `_imp__amqp_empty_bytes`) e avisos de bibliotecas OpenSSL/crypto ausentes durante o build, sem resposta registrada dos mantenedores. Confirma que não é peculiaridade do nosso ambiente. |
| `Mojo::RabbitMQ::Client` | XS-free (usa `Net::AMQP` puro) | Arquivado pelo mantenedor em **2025-01-24** (somente leitura). Última release: 2019. Já registrado como rejeitado na ADR-008 revisada de 2026-07-04. |
| `AnyEvent::RabbitMQ` | Pure-Perl no protocolo (`Net::AMQP`/`Net::AMQP::Frame`) | Sem o problema de compilação C em si, mas com mantenedor "de plantão" porque o autor original está inativo. A interface **síncrona** mais usada sobre ele é `Net::RabbitFoot`, que **depende de `Coro`** — módulo XS com histórico de suporte problemático no Windows (troca de contexto de baixo nível). Ou seja: trocar de `Net::AMQP::RabbitMQ` para essa rota só desloca a dependência XS problemática, não a elimina. |
| `Net::AMQP::PP` | Pure-Perl | Descrito literalmente no MetaCPAN como "Nasty hack for when you want pure perl AnyEvent::RabbitMQ" *(tradução: "gambiarra incômoda para quando você quer um AnyEvent::RabbitMQ puramente em Perl")* — o próprio nome sinaliza gambiarra, não solução de produção. |

**Conclusão desta seção**: não existe hoje, no ecossistema Perl, um cliente AMQP
maduro, ativamente mantido e livre de dependências XS problemáticas em Windows ao
mesmo tempo. As opções são (a) XS com biblioteca C externa — funciona bem em
Linux/macOS, quebra no Windows; (b) pure-Perl assíncrono sem wrapper síncrono maduro
e com manutenção incerta; ou (c) pure-Perl + Coro, que reintroduz XS problemático por
outra via. Isto é diferente de dizer "RabbitMQ é ruim" — RabbitMQ continua sendo um
broker excelente e amplamente adotado em outras linguagens. **O ponto fraco é
especificamente o ecossistema de clientes Perl para RabbitMQ**, e é isso — não uma
rejeição genérica ao RabbitMQ — que motiva esta proposta.

---

## 2. O que o RabbitMQ fornece hoje, e o que precisaríamos substituir

A ADR-008 usa RabbitMQ para um papel específico, distinto do Minion:

- **Minion** (já em Postgres, `Minion::Backend::Pg`): fila de jobs *interna* — um
  produtor, um consumidor (o próprio worker Perl da aplicação), sem necessidade de
  roteamento ou múltiplos consumidores independentes.
- **RabbitMQ**: broker *externo* — múltiplos consumidores podem assinar o mesmo
  fluxo de eventos (fan-out via exchange), potencialmente de serviços/linguagens
  diferentes, com roteamento por `routing_key`.

A pergunta central desta ADR não é "Postgres consegue fazer fila?" — isso já é
verdade hoje via Minion. A pergunta é: **Postgres consegue desempenhar o papel de
log de eventos multi-consumidor (fan-out) que hoje só o RabbitMQ cobre no stack?**
É essa lacuna específica que PgQue (seção 4) preenche; Postgres puro sem nenhuma
ferramenta (seção 3) também consegue, mas exige construir manualmente o que PgQue
já resolve pronto.

---

## 3. Fundamentos: fila em PostgreSQL 17 sem nenhuma extensão

### 3.1 `SELECT ... FOR UPDATE SKIP LOCKED`

Da documentação oficial ([postgresql.org/docs/17/sql-select.html](https://www.postgresql.org/docs/17/sql-select.html)):

> "With `SKIP LOCKED`, any selected rows that cannot be immediately locked are
> skipped. [...] Skipping locked rows provides an inconsistent view of the data, so
> this is not suitable for general purpose work, but can be used to avoid lock
> contention with multiple consumers accessing a queue-like table."
>
> *Tradução: "Com `SKIP LOCKED`, quaisquer linhas selecionadas que não possam ser
> bloqueadas imediatamente são ignoradas. [...] Ignorar linhas bloqueadas fornece uma
> visão inconsistente dos dados, então isso não é adequado para uso geral, mas pode
> ser usado para evitar disputa de lock com múltiplos consumidores acessando uma
> tabela do tipo fila."*

A própria documentação valida explicitamente esse uso — fila — como o caso de uso
pretendido para `SKIP LOCKED`. `NOWAIT`/`SKIP LOCKED` afetam só o lock de linha; o
lock de tabela `ROW SHARE` ainda é obtido normalmente.

### 3.2 `LISTEN`/`NOTIFY`

Da documentação oficial ([postgresql.org/docs/17/sql-notify.html](https://www.postgresql.org/docs/17/sql-notify.html)):

- Payload máximo **8000 bytes**; para dados maiores, gravar em tabela e notificar
  só a chave.
- **Não durável**: "the queue is quite large (8GB in a standard installation) and
  should be sufficiently sized for almost every use case" *(tradução: "a fila é
  bastante grande — 8GB numa instalação padrão — e deve ter tamanho suficiente para
  quase todo caso de uso")* — mas é um buffer em memória, não uma fila persistente.
  Se não há listener conectado no momento do `NOTIFY`, a notificação **não é
  entregue depois**.
- Overflow: "if this queue becomes full, transactions calling NOTIFY will fail at
  commit." *(tradução: "se essa fila ficar cheia, transações que chamam NOTIFY
  falharão no commit.")* Há aviso em log a partir de 50% de ocupação, e a função
  `pg_notification_queue_usage()` para monitorar.
- `NOTIFY` dentro de uma transação só é entregue **após o commit**; se a transação
  aborta, nada é enviado.
- Uma transação que já emitiu `NOTIFY` não pode ser usada com `PREPARE TRANSACTION`
  (two-phase commit).

**Conclusão da própria documentação**: adequado para sinalização em tempo real e
IPC leve; não é um mecanismo de enfileiramento durável — para isso, o padrão é usar
tabelas. `LISTEN`/`NOTIFY` serve para "acordar" um consumidor ocioso sem polling
apertado, não para armazenar a mensagem em si.

### 3.3 Advisory locks

Da documentação oficial ([postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS](https://www.postgresql.org/docs/17/explicit-locking.html)):

Locks definidos pela aplicação — "the system does not enforce their use; it is up
to the application to use them correctly." *(tradução: "o sistema não impõe seu
uso; cabe à aplicação usá-los corretamente.")* Úteis para coordenação que não se encaixa
bem no modelo MVCC — por exemplo, garantir que só um processo "ticker"/agendador
esteja ativo por vez. Existem em duas variantes: **sessão** (mantido até liberação
explícita ou fim da sessão; sobrevive a rollback de transação) e **transação**
(liberado automaticamente no fim da transação). Compartilham um pool de memória
dimensionado por `max_locks_per_transaction` e `max_connections`.

### 3.4 Autovacuum e bloat em tabelas de alto churn

Da documentação oficial ([postgresql.org/docs/17/routine-vacuuming.html](https://www.postgresql.org/docs/17/routine-vacuuming.html)):

- Limiar de disparo do autovacuum: `autovacuum_vacuum_threshold` (padrão 50) +
  `autovacuum_vacuum_scale_factor` (padrão 0.1 = 10%) × número de tuplas.
- "Plain VACUUM may not be satisfactory when a table contains large numbers of dead
  row versions as a result of massive update or delete activity." *(tradução: "Um
  VACUUM simples pode não ser satisfatório quando uma tabela contém grande número
  de versões de linhas mortas em decorrência de atividade massiva de update ou
  delete.")* `VACUUM` padrão não devolve espaço ao SO; `VACUUM FULL` reescreve a
  tabela inteira, exige lock `ACCESS EXCLUSIVE` e espaço em disco extra igual ao
  tamanho da tabela.
- Recomendação da própria documentação: **"the usual goal of routine vacuuming is
  to do standard VACUUMs often enough to avoid needing VACUUM FULL."** *(tradução:
  "o objetivo usual da limpeza de rotina é fazer VACUUMs padrão com frequência
  suficiente para evitar a necessidade de VACUUM FULL.")*
- E, principalmente — recomendação direta para o padrão de fila: **"If you have a
  table whose entire contents are deleted on a periodic basis, consider doing it
  with TRUNCATE rather than using DELETE followed by VACUUM. TRUNCATE removes the
  entire content of the table immediately, without requiring a subsequent VACUUM or
  VACUUM FULL to reclaim the now-unused disk space."** *(tradução: "Se você tem uma
  tabela cujo conteúdo inteiro é apagado periodicamente, considere fazer isso com
  TRUNCATE em vez de usar DELETE seguido de VACUUM. TRUNCATE remove todo o conteúdo
  da tabela imediatamente, sem exigir um VACUUM ou VACUUM FULL subsequente para
  recuperar o espaço em disco agora não utilizado.")*

Este último ponto é a peça central desta ADR: **é exatamente o que a PgQue faz por
design** (rotação via `TRUNCATE` de partições/lotes, em vez de `DELETE` linha a
linha) — não é uma técnica inventada pelo projeto, é a mitigação de bloat que o
próprio manual do Postgres recomenda para esse padrão de uso, automatizada.
`TRUNCATE` tem uma contrapartida: viola a semântica MVCC estrita (transações em
andamento podem observar o efeito de forma diferente do que veriam com `DELETE`
transacional linha a linha) — aceitável para uma fila (mensagens já processadas não
precisam de snapshot consistente), não para dados de negócio.

### 3.5 Prova de conceito já em produção: `Minion::Backend::Pg`

O stack já roda esse padrão exato, hoje, em produção — via Minion
([código-fonte](https://raw.githubusercontent.com/mojolicious/minion/main/lib/Minion/Backend/Pg.pm)):

```sql
WITH cte AS (
  SELECT id FROM minion_jobs AS j
  WHERE delayed <= NOW() AND [filtros de fila/prioridade/dependências]
  ORDER BY priority DESC, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE minion_jobs SET started = NOW(), state = 'active', worker = ?
WHERE id = (SELECT id FROM cte)
```

Quando não há job disponível, o worker chama `$db->listen('minion.job')` e espera
notificação em vez de fazer polling apertado — com timeout, porque `NOTIFY` não é
durável (rede de segurança caso a notificação se perca). **Isto significa que trocar
RabbitMQ por Postgres não é território novo para o projeto** — é uma extensão de um
padrão já validado, do caso interno (Minion) para o caso externo/fan-out que hoje é
do RabbitMQ.

O que Minion **não** resolve é justamente o fan-out multi-consumidor com roteamento
que motivou o RabbitMQ na ADR-008 original — Minion é fila de jobs *dentro* do
processo Perl da aplicação, não um log de eventos que múltiplos consumidores
independentes possam assinar.

---

## 4. Opção A — PgQue (proposta desta ADR)

**Fontes**: [pgque.dev](https://pgque.dev), [pgque.dev/docs/reference](https://pgque.dev/docs/reference),
[github.com/NikolayS/pgque](https://github.com/NikolayS/pgque),
[anúncio oficial no postgresql.org](https://www.postgresql.org/about/news/pgque-v01-zero-bloat-postgres-queue-3284/)
(2026-05-02).

### O que é

Citação literal do próprio projeto: **"Zero-bloat Postgres queue built on top of
battle-proven Skype's PgQ. One SQL file to install, pg_cron to tick."** *(tradução:
"Fila Postgres sem bloat, construída sobre o PgQ da Skype, testado em batalha. Um
arquivo SQL para instalar, pg_cron para o tick.")* Autor:
Nikolay Samokhvalov (PostgresAI). Licença **Apache-2.0**. Versão atual **v0.2.0**
(release em 2026-05-25).

### O problema que resolve

Implementações tradicionais de fila via `SKIP LOCKED` + `DELETE`/`UPDATE` por linha
acumulam tuplas mortas a cada ciclo — o site descreve como "the death spiral of a
SKIP LOCKED queue under sustained load" *(tradução: "a espiral da morte de uma fila
SKIP LOCKED sob carga sustentada")* (ver seção 8 para o lado cético disso).

### Como funciona

- **Batching por snapshot + rotação via `TRUNCATE`**, em vez de operações por
  linha. Eventos ficam visíveis em lotes entre "ticks". Não há lock de linha nem
  "claiming" individual de mensagem — consumo é por lote.
- **SQL puro e PL/pgSQL** — não é extensão C. Instalação: `\i sql/pgque.sql` +
  `select pgque.start();`. Existe empacotamento opcional via `pg_tle`
  (`create extension pgque`), mas isso **exige `pg_tle` carregado via
  `shared_preload_libraries`** — ou seja, a via "extensão" ainda exige configuração
  de servidor. A via recomendada para nós é a instalação por arquivo SQL puro
  (ver seção 9), que não exige alterar `postgresql.conf` nem sair da imagem oficial.
- Requer **Postgres 14+**. O tick precisa de algo chamando `pgque.ticker()`
  em alta frequência (padrão 10x/segundo, 100ms) — isso não acontece sozinho.
  Duas formas de prover isso: `pg_cron` (extensão C, precisa estar em
  `shared_preload_libraries`, reinício do servidor, mudança de imagem), que via
  `pgque.start()` agenda 4 jobs (`pgque_ticker` a cada 1s — rodando
  `pgque.ticker_loop()`, que faz sub-tick a 100ms **por dentro**, mesmo o
  `pg_cron` só disparando 1x/s —, `pgque_retry_events` e `pgque_maint` a cada
  30s, `pgque_rotate_step2` a cada 10s); ou um processo nosso chamando
  `pgque.ticker()` diretamente (não `ticker_loop()` — essa é de uso interno do
  `pg_cron`) em loop apertado, mais `pgque.maint()`/`maint_retry_events()`
  periodicamente. Esta ADR opta pela segunda via — ver seção 9.
- Latência ponta-a-ponta: ~50–52ms mediana com tick padrão de 100ms, ajustável de
  1 a 1000ms. Não é para dispatch sub-milissegundo.
- Modelo: cada consumidor mantém seu próprio cursor sobre um **log de eventos
  compartilhado** — mais parecido com tópicos Kafka (fan-out nativo, múltiplos
  consumidores independentes lendo o mesmo stream) do que uma fila de jobs
  ponto-a-ponto tipo RabbitMQ/Minion. **Essa diferença de modelo importa**: PgQue
  não é um substituto 1:1 de "fila de jobs" — é um log de eventos multi-consumidor.
  Para o caso de uso do RabbitMQ na Stega (`NotificationWorker` como único
  consumidor do exchange `stega.notifications`), isso funciona bem; se no futuro
  a Stega precisar de múltiplos consumidores independentes do mesmo evento
  (por exemplo, um worker de e-mail e um worker de auditoria lendo o mesmo evento
  `ticket.resolved` cada um no seu próprio ritmo), PgQue é uma escolha ainda melhor
  que RabbitMQ para esse caso — é exatamente o padrão que resolve nativamente.

### API SQL

**Produção**:
```sql
select pgque.send('stega.notifications', 'ticket.assigned', jsonb_build_object('ticket_id', 42));
select pgque.send_batch('stega.notifications', 'ticket.assigned', array[jsonb_build_object(...), ...]);
```

**Consumo**:
```sql
select pgque.subscribe('stega.notifications', 'notification-worker');
select * from pgque.receive('stega.notifications', 'notification-worker', 100);
select pgque.ack(batch_id);
select pgque.nack(batch_id, msg, retry_after => '60s', reason => 'smtp timeout');
```

**Gestão de fila**: `create_queue`, `drop_queue`, `set_queue_config` (parâmetros:
`ticker_max_count`, `ticker_max_lag`, `ticker_idle_period`, `ticker_paused`,
`rotation_period`, `external_ticker`, `max_retries`). Nome de fila limitado a 57 bytes.

**Dead-letter queue**: `dlq_inspect`, `dlq_replay`, `dlq_replay_all`, `dlq_purge`
(padrão 30 dias) — tabela `pgque.dead_letter`.

**Observabilidade**: `get_queue_info()`, `get_consumer_info()`, `get_batch_info()` —
tudo via SQL puro, expõe-se em um endpoint de saúde ou dashboard sem ferramenta
externa.

**Consumidores cooperativos** (experimental na v0.2): `register_subconsumer`,
`receive_coop`, `next_batch`, `touch_subconsumer` — múltiplos processos dividindo o
consumo de uma fila cooperativamente (como "consumer groups" do Kafka).

**Papéis**: `pgque_reader`, `pgque_writer`, `pgque_admin` (admin contém os outros
dois). **Globais por banco de dados, não por fila** — se aplicações mutuamente
não-confiáveis compartilhassem o mesmo banco, precisariam de isolamento adicional em
nível de schema. Não é um problema para o stack hoje (um único banco por
aplicação), mas é uma limitação a registrar.

### Maturidade

- **v0.2.0** — o próprio README descreve como "early-stage product/API" *(tradução:
  "produto/API em estágio inicial")*.
- ~1.7k estrelas, 36 forks, 15-20 contribuidores ativos no momento do levantamento.
- O motor conceitual (PgQ) é descrito como testado em produção por mais de uma
  década na Skype — **mas o empacotamento PgQue em si é novo**. Não confundir a
  maturidade do algoritmo com a maturidade deste projeto específico.
- Sem suporte nativo, hoje, a: entrega atrasada/agendada (`send_at` — no roadmap),
  wake-up via `LISTEN`/`NOTIFY` (no roadmap; hoje o consumidor faz polling no tick),
  métricas OpenTelemetry (no roadmap), CLI de administração (no roadmap).
- `pg_cron` grava em `cron.job_run_details` sem purga automática; usar PgQue com
  `pg_cron` adiciona 4 jobs periódicos que exigem purga manual dessa tabela ou
  desabilitar `cron.log_run`.

### Estrutura de `pgque.message`

A referência online (`pgque.dev/docs/reference`) descreve as assinaturas de
`receive()`/`ack()`/`nack()` mas não detalha as colunas do tipo composto
`pgque.message`. Confirmado por leitura direta de `sql/pgque.sql` no
repositório oficial ([NikolayS/pgque](https://github.com/NikolayS/pgque),
clonado localmente para conferência, linhas 5326–5440), verificado
especificamente contra a tag `v0.2.0` (commit `e8ee488`) — não só a branch
`main`. `main` está 50 commits à frente da tag, mas nenhum deles toca
`sql/pgque.sql` (são todos sobre o site `pgque.dev`); o conteúdo do arquivo é
idêntico, byte a byte, nas duas revisões. As referências a "Fix #98"/"Fix
#104" nos comentários de `nack()`/`event_dead()` já estão presentes na
v0.2.0 — não são patches posteriores ainda não lançados.

```sql
create type pgque.message as (
    msg_id      bigint,
    batch_id    bigint,
    type        text,
    payload     text,       -- texto cru; quem chama decodifica JSON se precisar
    retry_count int4,
    created_at  timestamptz,
    extra1      text,
    extra2      text,
    extra3      text,
    extra4      text
);
```

Três pontos que só o corpo real das funções revela (a assinatura sozinha não
deixa claro):

1. **O campo é `msg_id`, não `id`.**
2. **`payload` é `text`, não `jsonb`** — `pgque.receive()` devolve o payload
   como string crua; `Mojo::Pg` não decodifica automaticamente para hashref
   (diferente do que aconteceria com uma coluna `jsonb` nativa). Quem consome
   precisa chamar `decode_json($msg->{payload})` explicitamente.
3. **`pgque.nack()` recebe o `pgque.message` inteiro, não só um id** —
   assinatura real: `pgque.nack(i_batch_id bigint, i_msg pgque.message,
   i_retry_after interval default '60 seconds', i_reason text default null)`.
   O próprio código-fonte comenta que isso existe por segurança (correção
   "#98"): a função **reconsulta** o evento canônico usando só
   `i_msg.msg_id` — os demais campos que o chamador passar são ignorados, não
   confiados cegamente — mas ainda assim é preciso montar e passar o composto
   inteiro na chamada, não um escalar solto.

`pgque.send()` tem uma sobrecarga que aceita `payload jsonb` diretamente
(`pgque.send(queue_name text, type_name text, payload jsonb)`) e faz o cast
para texto (`payload::text`) **dentro do Postgres**, antes de gravar. Isso
significa que, ao enviar, dá para usar o marcador nativo `{ json => $payload }`
do `Mojo::Pg` — o mesmo padrão já estabelecido e corrigido em 2026-07-04 para
escrita de JSONB (ver `TODO.txt` da Stega) — e **nunca chamar
`JSON::PP::encode_json()`/`Encode::encode()` manualmente do lado de quem
envia**: o Postgres serializa e cuida da codificação sozinho. Isso **não**
elimina o bug de corrupção de acentuação registrado no `TODO.txt` (que
acontece na **leitura** de `TEXT` de volta para o Perl — e `payload` de
`receive()` também é `TEXT`, sujeito ao mesmo problema), mas evita adicionar
um segundo ponto de codificação manual do lado de quem envia.

### Exemplo: Job Minion publicando via PgQue (lado do envio)

```perl
# lib/Stega/Job/SendWelcomeNotification.pm — trecho de _publish_notification, versão proposta
sub _publish_notification {
    my ($app, $type, $payload) = @_;

    # $app->pg_events, não $app->pg — conexão dedicada a db-events (ADR-023)
    $app->pg_events->db->query(
        'select pgque.send(?, ?, ?)',
        'stega.notifications', $type, { json => $payload }    # marcador nativo do Mojo::Pg — sem encode_json manual
    );
}
```

### Exemplo: `NotificationWorker` da Stega usando PgQue (lado do consumo, sem XS)

```perl
# lib/Stega/Worker/NotificationWorker.pm — versão proposta, sem Net::AMQP::RabbitMQ
package Stega::Worker::NotificationWorker;
use v5.42;
use utf8;
use Mojo::JSON qw(decode_json);
$| = 1;

sub run {
    my $app = shift;    # instância Stega

    # Conexão DEDICADA a db-events (credencial D) — nunca $app->pg, que aponta
    # para db-app (credencial B). São instâncias e credenciais independentes
    # (ADR-023); podem inclusive estar em provedores de nuvem diferentes.
    my $pg_events = $app->pg_events;

    $pg_events->db->query(q{select pgque.subscribe('stega.notifications', 'notification-worker')});

    say '[NotificationWorker] Aguardando mensagens. Ctrl+C para encerrar.';

    while (1) {
        my $rows = $pg_events->db->query(
            q{select * from pgque.receive('stega.notifications', 'notification-worker', 50)}
        )->hashes;

        unless (@$rows) {
            sleep 1;    # sem wake-up nativo via LISTEN/NOTIFY na v0.2 — polling simples no intervalo do tick
            next;
        }

        for my $msg (@$rows) {
            eval {
                _dispatch($msg->{type}, decode_json($msg->{payload}));
                $pg_events->db->query('select pgque.ack(?)', $msg->{batch_id});
            };
            if ($@) {
                warn "[NotificationWorker] Erro: $@\n";
                # nack() exige o pgque.message inteiro (não só msg_id) — s#98
                # do próprio PgQue: só msg_id é de fato usado (reconsultado
                # internamente), mas a assinatura exige o composto completo.
                $pg_events->db->query(
                    q{select pgque.nack(?, row(?,?,?,?,?,?,?,?,?,?)::pgque.message, ?, ?)},
                    $msg->{batch_id},
                    $msg->{msg_id}, $msg->{batch_id}, $msg->{type}, $msg->{payload},
                    $msg->{retry_count}, $msg->{created_at},
                    $msg->{extra1}, $msg->{extra2}, $msg->{extra3}, $msg->{extra4},
                    '60s', "$@"
                );
            }
        }
    }
}

1;
```

Nenhuma dependência XS nova — tudo via `Mojo::Pg`, já presente no stack pela
ADR-016. `$app->pg_events` é um helper **novo**, registrado no `startup()` de
`Stega.pm` com sua própria instância de `Mojo::Pg` apontando para `db-events`
(credencial D) — assim como `$app->pg` (db-app) e o `Mojo::Pg` interno do Minion
(db-jobs) já são três conexões distintas, não uma reaproveitada nas outras (ver
seção "Conexões da aplicação" na ADR-023). O `sleep 1` no lugar do `$mq->recv(0)`
bloqueante é uma
regressão de eficiência real em relação ao RabbitMQ (polling em vez de espera
bloqueante) — mitigável hoje combinando `LISTEN`/`NOTIFY` manual (seção 3.2) como
sinal de "acordar", já que PgQue ainda não oferece isso nativamente (está no
roadmap).

---

## 5. Opção B — PgQ original (Skytools)

**Fonte**: [github.com/pgq/pgq](https://github.com/pgq/pgq).

- Descrição do próprio projeto: "generic, high-performance lockless queue with
  simple API based on SQL functions." *(tradução: "fila genérica, de alta
  performance e sem locks, com API simples baseada em funções SQL.")*
- Arquitetura: PL/pgSQL (61.9%) + **C (29.4%)** + Python (5.9%) — confirma que é
  uma **extensão C** (exige `CREATE EXTENSION`, compilação no servidor) **mais um
  daemon externo `pgqd`** para o tick/rotação — infraestrutura adicional a operar,
  não menos que o RabbitMQ que estamos tentando eliminar.
- Compatibilidade declarada: PostgreSQL 10 a 18. Última release **v3.5.1 em
  2023-09-07** — mantido, mas sem desenvolvimento ativo (mais de um ano sem release
  nova até a data deste levantamento).
- Origem: Skytools, conjunto de ferramentas Postgres criado na Skype (~2006), usado
  em escala de centenas de milhões de usuários segundo o material da PgQue.

### Relação PgQue ↔ PgQ (resposta à hipótese original desta proposta)

**Confirmado, com uma nuance importante**: PgQue **não é** uma nova versão/release
sucessora publicada pelo mesmo projeto ou mantenedores de `pgq/pgq`. É um **projeto
novo e distinto** (autor diferente — Nikolay Samokhvalov/PostgresAI, não a equipe
atual de `pgq/pgq`) que **reimplementa o algoritmo conceitual do PgQ** (batching por
snapshot + rotação) **em SQL puro**, removendo as duas dependências de
infraestrutura do PgQ original: a extensão C e o daemon `pgqd`. A citação oficial é
"built on top of battle-proven Skype's PgQ" *(tradução: "construído sobre o PgQ da
Skype, testado em batalha")* — o crédito é ao algoritmo, não uma continuidade
formal do repositório. Tratar como **reimplementação inspirada em**,
não como fork ou evolução oficial.

### Por que PgQ original não resolve nosso problema tão bem quanto PgQue

O PgQ original reintroduz exatamente a classe de fricção operacional que motiva
esta proposta — só que do lado do servidor Postgres em vez do cliente Perl: uma
extensão C a compilar/manter na imagem do banco, mais um daemon externo (`pgqd`) a
operar. Isso não é uma redução líquida de complexidade operacional em relação ao
RabbitMQ — é trocar um serviço de backing dedicado (RabbitMQ) por outro conjunto de
peças de infraestrutura C (extensão + daemon). A vantagem de PgQue sobre PgQ, para o
nosso caso, é justamente eliminar essas duas peças.

---

## 6. Opção C — PostgreSQL sem nenhuma extensão ("feito à mão")

Tecnicamente já descrito na seção 3: `SELECT ... FOR UPDATE SKIP LOCKED` +
`LISTEN`/`NOTIFY` + tabela de fila com rotação via `TRUNCATE`/particionamento.

**Prós**:
- Zero dependência externa nova — nenhum risco de maturidade de terceiros
  (PgQue é v0.2.0; código próprio não tem esse risco, mas tem outro, ver contras).
- Controle total sobre o schema e o comportamento.
- Já é o padrão usado por `Minion::Backend::Pg` — não é território desconhecido.

**Contras**:
- Precisaríamos construir e manter, nós mesmos: rotação anti-bloat (`TRUNCATE`/
  particionamento por lote), dead-letter queue, fan-out multi-consumidor com cursor
  próprio por consumidor, observabilidade (contagem de fila, lag, taxa de erro) —
  tudo que a PgQue já oferece pronto e testado (na medida da sua maturidade).
- É exatamente o tipo de decisão que o projeto já rejeitou uma vez por um motivo
  específico: a ADR-016 (revisão 2026-07-02) reverteu um loader de migrations
  próprio em favor do mecanismo nativo do Mojo::Pg, com o princípio explícito de
  "preferir o mecanismo que a própria biblioteca oferece a um utilitário próprio
  equivalente — um loader escrito à mão é uma superfície a mais para bugs que o
  código já testado elimina." O mesmo raciocínio se aplica aqui: construir fan-out
  + DLQ + anti-bloat do zero é uma superfície própria de bugs para resolver um
  problema que uma ferramenta dedicada (ainda que nova) já resolve.
- Maior custo de manutenção contínua — cada funcionalidade que o RabbitMQ ou a
  PgQue já oferecem de fábrica (DLQ, replay, métricas) precisaria de código e testes
  próprios, revisados e mantidos pelo projeto para sempre.

Mantida como **plano B**: se a maturidade da PgQue (v0.2.0) for julgada risco alto
demais no momento da decisão final, esta é a rota de fallback — mais trabalho de
implementação, porém sem dependência de um projeto de terceiros ainda jovem.

---

## 7. Comparativo lado a lado

| Dimensão | RabbitMQ (atual, ADR-008) | PgQue (proposta) | PgQ original | Postgres puro (feito à mão) | Manter só Minion |
|---|---|---|---|---|---|
| Novo serviço de backing | Sim (RabbitMQ) | Não | Não (mas extensão C + daemon) | Não | Não |
| Funciona nativo no Windows (dev local) | Não (worker precisa de Docker) | Sim (só SQL via Mojo::Pg) | Sim para o app Perl, mas servidor Postgres precisa compilar a extensão | Sim | Sim (já é o caso hoje) |
| Fan-out multi-consumidor | Sim (exchanges) | Sim (log de eventos, cursor por consumidor) | Sim | Só se construído | Não |
| Durabilidade | Sim (durable queues) | Sim (tabela + rotação) | Sim | Sim, se bem implementado | Sim |
| Maturidade em produção | Alta (broker consolidado) | Baixa (v0.2.0); motor subjacente maduro | Média (mantido, sem desenvolvimento ativo desde 2023) | Depende da nossa própria implementação | Alta (já em produção na Stega) |
| Latência típica | Baixa (ms) | ~50-100ms (tick) | Baixa (contínuo, sem tick) | Configurável (depende do polling) | Configurável |
| Esforço de implementação inicial | Já feito (ADR-008) | Médio (instalar SQL, adaptar 2 workers) | Médio-alto (compilar extensão + daemon) | Alto (construir DLQ/rotação/fan-out) | Baixo (já existe) — mas não resolve o caso de uso |
| Esforço operacional contínuo | Médio-alto (broker dedicado, filas, DLQ) | Baixo-médio (monitorar bloat/vacuum do Postgres, purgar `cron.job_run_details` se usar pg_cron) | Médio-alto (extensão C + daemon a manter) | Alto (tudo por conta própria) | Baixo |
| Observabilidade | Management UI do RabbitMQ | Funções SQL (`get_queue_info` etc.) | Ferramentas próprias do Skytools | Por conta própria | Painel do Minion |
| Interoperabilidade com sistemas não-Perl | Sim (AMQP padrão) | Só via acesso direto ao Postgres | Só via acesso direto ao Postgres | Só via acesso direto ao Postgres | Não |

---

## 8. Armadilhas gerais de "Postgres como fila" — o outro lado

Nenhuma fonte consultada nesta pesquisa argumenta "nunca use Postgres como fila" de
forma absoluta. O padrão funciona e é usado em produção — a própria documentação
oficial do Postgres 17 valida `SKIP LOCKED` para esse fim. Mas exige atenção
deliberada sob carga sustentada.

### PlanetScale — ["Keeping a Postgres queue healthy"](https://planetscale.com/blog/keeping-a-postgres-queue-healthy) *(tradução do título: "Mantendo uma fila Postgres saudável")*

> "A database is destined to fail if it cannot reclaim dead tuples faster than its
> workload creates them."
>
> *Tradução: "Um banco de dados está destinado a falhar se não conseguir recuperar
> tuplas mortas mais rápido do que sua carga de trabalho as cria."*

O vilão real não é o throughput bruto da fila isolada — é a **concorrência com
outras cargas** no mesmo banco: consultas analíticas de longa duração ou
transações sobrepostas impedem o vacuum de reclamar tuplas mortas:

> "Postgres will not vacuum away any dead tuple that might still be visible to an
> active transaction."
>
> *Tradução: "O Postgres não vai limpar (vacuum) nenhuma tupla morta que ainda
> possa estar visível para uma transação ativa."*

Tuning tradicional de autovacuum é descrito como insuficiente por si só nesse
cenário. O veredito do artigo **não é abandonar Postgres** — é isolar a carga de
fila de outras cargas conflitantes:

> "In a 'just use Postgres' world where queues, analytics, and application logic
> share a single database, this is not a theoretical risk."
>
> *Tradução: "Num mundo de 'apenas use o Postgres', onde filas, analytics e lógica
> de aplicação compartilham um único banco de dados, isso não é um risco
> teórico."*

**Relevância direta para nós**: hoje o Postgres do stack já hospeda dados
relacionais (ADR-007/016), documentos JSONB (ADR-017) e o Minion (ADR-008, nota).
Adicionar mais uma carga de fila (PgQue) no **mesmo** banco/instância aumenta a
superfície de conflito de vacuum/WAL que este artigo descreve. Isso é um ponto real
a decidir na implementação: considerar um banco, schema ou tablespace dedicado para
filas, não necessariamente a mesma instância que serve a API — decisão de
infraestrutura nova que o stack não precisava tomar antes (um único Postgres servia
tudo sem essa preocupação, porque Minion tem volume baixo comparado ao que RabbitMQ
processava).

### Crunchy Data — ["Message Queuing Using Native PostgreSQL"](https://www.crunchydata.com/blog/message-queuing-using-native-postgresql) *(tradução do título: "Mensageria usando PostgreSQL nativo")*

> "One of the considerations when using PostgreSQL (or any RDBMS with MVCC
> support) for high turnover queuing is table bloat."
>
> *Tradução: "Uma das considerações ao usar PostgreSQL (ou qualquer RDBMS com
> suporte a MVCC) para enfileiramento de alta rotatividade é o bloat de
> tabela."*

Recomenda o padrão `DELETE ... USING (SELECT ... FOR UPDATE SKIP LOCKED) ...
RETURNING` para consumir e remover atomicamente, monitorar bloat ativamente
(ferramentas tipo `pg_bloat_check`), e — mesma ideia central do design da PgQue —
rotacionar tabelas de fila periodicamente, só que manual em vez de automatizado.

Recomenda **tabelas regulares, não `UNLOGGED`**, para persistência real — contraponto
explícito a quem sugere `UNLOGGED` como atalho de performance: uma tabela
`UNLOGGED` perde os dados em caso de crash do servidor (não sobrevive a um `pg_ctl
stop -m immediate` seguido de recuperação, nem a um failover não controlado), o que
pode ser inaceitável dependendo da criticidade da mensagem — por exemplo, uma
notificação de SLA violado (`ticket.sla_breached`) que se perde silenciosamente.

### Amplificação de WAL

Cada operação de lock/unlock, `UPDATE`, `DELETE` numa fila tradicional feita à mão
é uma transação totalmente logada em WAL. Em sistemas de alta vazão, o volume de
WAL só da fila pode saturar o `wal_writer` e os processos de checkpoint. O design de
PgQue (batching + `TRUNCATE`) reduz isso porque elimina o `UPDATE`/`DELETE` por
mensagem — mas não elimina o WAL do `TRUNCATE` em si nem do `INSERT` de produção.

### Resumo do balanço

O consenso das fontes com citação confirmada é: o padrão funciona e é validado
oficialmente para esse fim, mas exige atenção deliberada a bloat/vacuum sob carga
sustentada — e ferramentas como PgQue existem precisamente para automatizar essa
responsabilidade, usando a mitigação (`TRUNCATE`) que a própria documentação do
Postgres já recomenda para tabelas esvaziadas periodicamente.

---

## 9. Impacto no repositório central (`crystallized-perl`)

Ações que a aceitação desta ADR implicaria (nenhuma executada agora — a ADR está em
`Proposta`):

- **ADR-008**: status muda para `Substituída por ADR-022` (só no momento da
  aceitação — ver revisão 2026-07-04 da ADR-000).
- **ADR-014**: remover a limitação "Windows nativo" (compilação de
  `Net::AMQP::RabbitMQ`) — a exceção que hoje obriga rodar o worker de notificação
  via Docker Compose no Windows deixa de existir. É um ganho real de paridade nativa
  que a ADR-014 buscava desde a origem.
- **ADR-018 (Stega)**: atualizar a tabela "Mapeamento completo ADR → componente da
  Stega" (linha do ADR-008) e a seção "Serviço de notificações" para refletir PgQue.
- **Guia 8** (`08-rabbitmq-e-minion.md`): reescrita — troca RabbitMQ por PgQue,
  remove toda a seção de troubleshooting de compilação Windows (deixa de existir o
  problema que a documentava). Provavelmente renomeado para refletir o novo conteúdo
  (ex.: "Guia 8 — Processamento Assíncrono com Minion e PgQue" ou "Filas em
  PostgreSQL").
- **Guia 9** (`09-containerizacao-e-deployment.md`): manifests Kubernetes — remover
  o `Deployment`/`Service` do RabbitMQ; adicionar um novo `Deployment` de ticker
  (processo de longa duração, réplica única, chamando `pgque.ticker()` em loop,
  mais `maint()`/`maint_retry_events()` periodicamente — ver `Decisão`). O
  Dockerfile deixa de instalar `librabbitmq-dev`/`librabbitmq4`.
- **`docs/references/rabbitmq.md`**: mantido para registro histórico (a ADR-008
  revogada ainda o referencia — ADR-000 exige preservar arquivos de ADRs
  substituídas). Nenhuma edição necessária além de, opcionalmente, uma nota de
  contexto.
- **`docs/references/minion.md`, `mojo-pg.md`, `postgresql.md`**: adicionar
  ADR-022 à seção "Referenciada em" de cada um.
- **Novos arquivos de referência**: `docs/references/pgque.md` e
  `docs/references/pgq.md` (criados junto com esta proposta).
- **`CLAUDE.md`**: a tabela "Technology Stack — Decisões Tomadas" (linha "Message
  broker") e a tabela "Decisões Iniciais Resolvidas" precisam de atualização quando
  a ADR for de fato aceita — **não antes**, para não registrar como decisão tomada
  algo que ainda está em avaliação.
- **Viés do projeto**: a elevator pitch não muda, mas o argumento de venda de "menos
  serviços de backing para operar" fica mais forte — de quatro serviços externos
  (PostgreSQL, RabbitMQ, Keycloak, e o próprio Kubernetes) para três, com PostgreSQL
  absorvendo relacional + documental + filas.

## 10. Impacto na Stega (aplicação de demonstração)

- **`eng/bootstrap_pgque.pl`** (script novo, **fora** de `migrations/` — não é uma
  migration de domínio, é a instalação de um componente de terceiros): conecta a
  `db-events` **usando a própria credencial D** (a credencial única e dona daquele
  banco — ADR-023), roda `pgque.sql` via `psql -f` e concede o papel `pgque_admin`
  (já contém `pgque_reader`/`pgque_writer`) **à própria credencial D**. **Não**
  toca em `stega_app`/`stega_migrate` — essas pertencem a `db-app`, uma instância
  diferente, sem nenhuma relação com `db-events` (podem inclusive estar em
  provedores de nuvem diferentes — ver seção "Conexões da aplicação" na ADR-023).
  Reaproveita o mesmo **mecanismo** de passo idempotente que `eng/migrate.pl` já
  usa (roda a cada implantação, só tem efeito na primeira vez) — mas é um script,
  um InitContainer e um serviço Compose **distintos e nomeados como tal**
  (`bootstrap-pgque`, não `migrate`), para que ninguém confunda "instalar o PgQue"
  com "aplicar migrations do domínio". Ver ADR-023 para o raciocínio completo dessa
  distinção.
- **`lib/Stega/Job/SendWelcomeNotification.pm`, `CheckSlaBreaches.pm`,
  `GenerateActivityReport.pm`**: a função `_publish_notification` (hoje
  `Net::AMQP::RabbitMQ`) passa a chamar `pgque.send()` via uma conexão **dedicada**
  a `db-events` (credencial D, exposta por um novo helper, ex. `$app->pg_events`)
  — nunca via `$app->pg` (que aponta para `db-app`, credencial B; são bancos e
  credenciais independentes, ver ADR-023). Nenhum `require` condicional de módulo
  XS é mais necessário.
- **`lib/Stega/Worker/NotificationWorker.pm`**: reescrito para consumir via
  `pgque.receive()`/`pgque.ack()`/`pgque.nack()` em loop (ver exemplo de código na
  seção 4).
- **`cpanfile`**: remove `Net::AMQP::RabbitMQ`. Nenhuma dependência XS nova
  adicionada — tudo via `Mojo::Pg`, já presente (ADR-016).
- **`compose.yml`**: remove o serviço `rabbitmq`; adiciona o serviço
  `bootstrap-pgque` (roda `eng/bootstrap_pgque.pl` uma vez, `restart: "no"`,
  mesmo formato do serviço `migrate` já existente — mas é uma entrada **separada**,
  não uma responsabilidade a mais do `migrate`). A imagem `postgres:17-alpine`
  permanece inalterada com o ticker externo decidido (ver `Decisão` na
  ADR-022) — só viraria imagem customizada se a equipe trocasse para `pg_cron`.
  Novo serviço `pgque-ticker` (processo de longa duração, `restart: always`,
  mesmo molde do `notification-worker`).
- **`eng/worker.pl`**: continua existindo como processo separado — só o protocolo
  interno muda (chama `NotificationWorker::run` com `pgque` em vez de AMQP).
- **Manifests Kubernetes da Stega**: `stega-notification-worker` continua como
  `Deployment` (sem as variáveis `RABBITMQ_*`); novo `Deployment`
  `stega-pgque-ticker` (processo de longa duração, não `CronJob` — ver seção 11).
- **`DEVELOPMENT.md`/`TESTING.md`**: remove a exceção "rodar via Docker Compose no
  Windows" para o worker de notificação — o worker passa a funcionar nativamente
  com Perl instalado via berrybrew, igual ao resto da aplicação.
- **Testes (`t/`)**: ver subseção "Cobertura de testes" abaixo.

### Cobertura de testes

A Stega tem hoje `t/070_notifications.t` — suíte completa validada via
`docker compose --profile full --profile test run --rm test` a partir de
ambiente limpo: 14 arquivos, 94 testes, `Result: PASS`.

| Item | Cobertura |
|---|---|
| `NotificationWorker::_dispatch` | 7 routing keys testadas isoladamente (sem broker), mais o caso de routing key desconhecida |
| `send_welcome_notification` | Job roda via `perform_jobs`; mensagem real recebida de volta do RabbitMQ (routing key + payload conferidos) |
| `check_sla_breaches` | Idem, mais o evento `ticket.sla_breached` gravado no banco |
| `generate_activity_report` | Idem, mais a forma do relatório (`stats`) |
| `process_webhook_payload` | Já tinha cobertura antes (`t/030_webhooks.t`), inalterada |

Ao escrever e validar esses testes, dois achados colaterais:

1. O serviço `test` do `compose.yml` não tinha **nenhuma** conexão com o
   RabbitMQ (nem `depends_on`, nem `RABBITMQ_HOST`) — corrigido junto com os
   testes.
2. Um bug real e pré-existente, **não relacionado a filas**: leitura de texto
   acentuado via `Mojo::Pg` neste ambiente Docker volta corrompida byte a
   byte (confirmado que o dado está correto no banco — a corrupção acontece
   na leitura para dentro do Perl, não na escrita). Registrado como pendência
   em aberto no `TODO.txt` da Stega, com roteiro de reprodução mínimo.

   **Esse bug não é resolvido pela migração para PgQue.** A corrupção
   acontece ao ler o valor do Postgres para dentro de um escalar Perl, antes
   de qualquer serialização — afeta igualmente o caminho atual (RabbitMQ, via
   `JSON::PP::encode_json`) e o caminho futuro (PgQue, que receberia o mesmo
   valor Perl já corrompido como parâmetro `jsonb`, independente do mecanismo
   de bind usado). É uma questão ortogonal a esta ADR — precisa de
   investigação e correção à parte, qualquer que seja o mecanismo de fila
   escolhido.

**O que isso muda, precisamente, para quem for implementar a migração**: os
testes de `_dispatch` (parte 1 da suíte) continuam **exatamente iguais**, sem
nenhuma mudança — são lógica pura, sem I/O, e não dependem do mecanismo de
transporte. Já os três testes de job (parte 2) têm sua função de dreno
(`_drain_until`, hoje conectando via `Net::AMQP::RabbitMQ`, declarando
exchange/fila/bindings) **reescrita por completo** para consumir via
`pgque.receive()` — isto não é um "ajuste mínimo" de mecânica de dreno, é uma
troca total do transporte usado pelo teste. O que **permanece igual** são as
asserções sobre o resultado (`ok $payload`, `is $payload->{campo}, ...`) — é
isso, e não o dreno em si, que faz da suíte um critério de aceite válido para
comparar comportamento antes/depois da migração.

O `compose.yml` também precisa mudar nesse momento: o serviço `test` hoje
depende de `rabbitmq`/usa `RABBITMQ_HOST`; ao migrar, passa a depender de
`postgres-events` (ADR-023) e usar `POSTGRESQL_EVENTS_URL`/`_USERNAME`/
`_PASSWORD` no lugar.

## 11. Pontos que exigem confirmação explícita antes de aceitar

Esta ADR (seção `Decisão`) já toma uma posição em cada um destes pontos para
ser uma proposta concreta, não uma lista de opções em aberto — mas são
decisões reais de arquitetura, não detalhes de implementação triviais, e você
deve revisar cada uma explicitamente antes de aceitar:

1. **Mecanismo de tick**: um processo próprio, de longa duração (`Deployment`,
   réplica única, mesmo molde do `NotificationWorker`/worker do Minion) chama
   `pgque.ticker()` em loop apertado (~100ms-1s), mais
   `maint()`/`maint_retry_events()` periodicamente — não `pg_cron`, não
   `CronJob` do Kubernetes (a granularidade mínima de 1 minuto do `CronJob`
   não atinge a cadência que o PgQue precisa, a menos que o próprio comando
   implemente um laço interno de alta frequência — e nesse caso um
   `Deployment` sempre ativo é mais simples, sem lidar com sobreposição de
   execuções nem com o laço precisar terminar antes do próximo disparo).
   Evita customizar a imagem `postgres:17-alpine`, ao custo explícito de mais
   um processo persistente a construir e operar. Ver "Decisão" na ADR-022.
2. **Banco dedicado para filas**: resolvido pela ADR-023 (instância
   `db-events` isolada de `db-app`/`db-jobs`) — se as duas ADRs forem aceitas
   juntas, o achado da seção 8 (PlanetScale, conflito de vacuum/WAL entre
   cargas) já está endereçado. Se só esta ADR-022 for aceita, sem a ADR-023,
   o PgQue viveria na mesma instância que já hospeda dados relacionais/JSONB,
   e esse conflito de carga volta a ser um risco a monitorar ativamente.
3. **Risco de maturidade da PgQue (v0.2.0)** — o motor conceitual (PgQ) tem uma
   década de produção real; o empacotamento PgQue como projeto tem poucos
   meses, e o próprio README o descreve como "early-stage". Se esse risco for
   julgado alto demais, a Opção C (seção 6, Postgres sem extensão) é o plano B
   documentado, ao custo de mais esforço de implementação própria.

## 12. Fontes consultadas — status de verificação

**Confirmadas por acesso direto (citações literais)**:
- [pgque.dev](https://pgque.dev), [pgque.dev/docs/reference](https://pgque.dev/docs/reference)
- [github.com/NikolayS/pgque](https://github.com/NikolayS/pgque)
- [Anúncio oficial PgQue no postgresql.org](https://www.postgresql.org/about/news/pgque-v01-zero-bloat-postgres-queue-3284/)
- [github.com/pgq/pgq](https://github.com/pgq/pgq) (metadados da página; `README.rst` completo não recuperado)
- [postgresql.org/docs/17/sql-select.html](https://www.postgresql.org/docs/17/sql-select.html)
- [postgresql.org/docs/17/sql-notify.html](https://www.postgresql.org/docs/17/sql-notify.html)
- [postgresql.org/docs/17/routine-vacuuming.html](https://www.postgresql.org/docs/17/routine-vacuuming.html)
- [postgresql.org/docs/17/explicit-locking.html](https://www.postgresql.org/docs/17/explicit-locking.html) (advisory locks)
- [Código-fonte de `Minion::Backend::Pg`](https://raw.githubusercontent.com/mojolicious/minion/main/lib/Minion/Backend/Pg.pm)
- [Crunchy Data — Message Queuing Using Native PostgreSQL](https://www.crunchydata.com/blog/message-queuing-using-native-postgresql)
- [PlanetScale — Keeping a Postgres queue healthy](https://planetscale.com/blog/keeping-a-postgres-queue-healthy)
- [MetaCPAN — Net::AMQP::RabbitMQ](https://metacpan.org/pod/Net::AMQP::RabbitMQ)
- [Issue #144 "Compilation error on CPAN @ Windows 10"](https://github.com/net-amqp-rabbitmq/net-amqp-rabbitmq/issues/144)
  do `Net::AMQP::RabbitMQ` — corpo do relato original lido por completo: Windows 10
  x64, Strawberry Perl 5.20.3 (64int), falha de link contra símbolos da
  `librabbitmq`, sem resposta registrada dos mantenedores

**Verificada e descartada como evidência**:
- [Issue #150 "Installation problems"](https://github.com/net-amqp-rabbitmq/net-amqp-rabbitmq/issues/150)
  do `Net::AMQP::RabbitMQ` — lida por completo: trata de uma falha de instalação em
  **Ubuntu 16.04** (testes falhando, bibliotecas do sistema ausentes), não de
  Windows. Não é citada como evidência de falha no Windows na seção 1 — a issue
  #144, sozinha, já é suficiente e inequívoca para esse ponto.

**Não confirmadas por citação literal / a validar antes de tratar como fato definitivo**:
- Conteúdo completo do post da Microsoft Community Hub "Potential Consequences of
  Using Postgres as a Job Queue" *(tradução: "Consequências potenciais de usar o
  Postgres como fila de jobs")* — o acesso trouxe só o título.
- Detalhe arquitetural adicional do `README.rst` de `pgq/pgq` (só metadados da
  página vieram no acesso).
- Issue #57 de `Net::AMQP::RabbitMQ` — não é usada como evidência neste estudo;
  listada aqui só para o caso de aprofundamento futuro.
- Uma série de posts de blog adicionais sobre "Postgres as a queue" *(tradução:
  "Postgres como fila")* apareceram em
  buscas mas não foram lidos por completo (richyen.com, parottasalna.com,
  kmoppel.github.io, vrajat.com, techplained.com, dbpro.app) — não usados como
  citação neste documento; listados aqui só para o caso de aprofundamento futuro.
