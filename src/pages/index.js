import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

function Hero() {
  const logoUrl = useBaseUrl('/img/logo.svg');
  return (
    <header className={styles.hero}>
      <div className={styles.heroInner}>
        <img
          src={logoUrl}
          className={styles.heroLogo}
          alt="Crystallized Perl — Raptor Cristalizado"
          width="148"
          height="148"
        />
        <p className={styles.heroSuper}>use Modern::Perl;</p>
        <h1 className={styles.heroTitle}>
          Crystallized <span className={styles.heroAccent}>Perl</span>
        </h1>
        <p className={styles.heroTagline}>
          Stack completo e opinativo para construir serviços de internet modernos
          em Perl — aplicações web, APIs HTTP e workers em background,
          fundamentado em referências reais e decisões arquiteturais documentadas.
        </p>
        <div className={styles.heroCtas}>
          <Link to="/getting-started" className={styles.btnPrimary}>
            Primeiros Passos →
          </Link>
          <Link
            href="https://github.com/Hibex-Solutions/crystallized-perl"
            className={styles.btnSecondary}
          >
            Ver no GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}

const FEATURES = [
  {
    emoji: '🏗️',
    title: 'Opinativo',
    body: 'Um stack, não um menu de opções. Cada camada tecnológica tem uma decisão documentada com motivação, alternativas consideradas e consequências.',
  },
  {
    emoji: '📚',
    title: 'Reference-first',
    body: 'Toda escolha tecnológica rastreia ao menos uma fonte externa autoritativa — livros, RFCs e documentações oficiais. Nada é justificado por "senso comum".',
  },
  {
    emoji: '☁️',
    title: 'Cloud-native',
    body: 'Tudo roda em containers. Desenvolvimento local usa Docker Compose com paridade máxima com o ambiente de produção Kubernetes.',
  },
  {
    emoji: '⚡',
    title: 'Perl Moderno',
    body: 'Perl 5.42+ obrigatório. Moo, Mojolicious e Carton. Padrões arcaicos são explicitamente proibidos — cada ADR documenta o que não usar e por quê.',
  },
];

function Features() {
  return (
    <section className={styles.features}>
      <div className={styles.featuresGrid}>
        {FEATURES.map((f) => (
          <article key={f.title} className={styles.featureCard}>
            <span className={styles.featureEmoji} aria-hidden="true">
              {f.emoji}
            </span>
            <h3 className={styles.featureTitle}>{f.title}</h3>
            <p className={styles.featureBody}>{f.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const STACK = [
  ['Linguagem', 'Perl 5.42+'],
  ['Framework web', 'Mojolicious + Hypnotoad'],
  ['Gerenciamento de deps', 'Carton + cpanm'],
  ['Orientação a objetos', 'Moo + Moo::Role'],
  ['Banco de dados', 'PostgreSQL 16 + JSONB'],
  ['Acesso a dados', 'Mojo::Pg + Migrations'],
  ['Autenticação', 'Keycloak + JWT (Crypt::JWT)'],
  ['Message broker', 'RabbitMQ (AMQP 0-9-1)'],
  ['Contrato de API', 'OpenAPI v3 + Plugin::OpenAPI'],
  ['Testes', 'Test::Mojo + prove + Devel::Cover'],
  ['Containerização', 'Docker multi-stage build'],
  ['Orquestração', 'Kubernetes + InitContainer'],
];

function StackOverview() {
  return (
    <section className={styles.stack}>
      <div className={styles.stackInner}>
        <h2 className={styles.sectionTitle}>O Stack</h2>
        <p className={styles.sectionSubtitle}>
          Todas as decisões estão documentadas em{' '}
          <Link to="/adrs/ADR-000-padrao-de-adrs">ADRs</Link> com motivação,
          alternativas e referências externas.
        </p>
        <div className={styles.stackGrid}>
          {STACK.map(([layer, tech]) => (
            <div key={layer} className={styles.stackItem}>
              <span className={styles.stackLayer}>{layer}</span>
              <span className={styles.stackTech}>{tech}</span>
            </div>
          ))}
        </div>
        <div className={styles.stackCtas}>
          <Link to="/stack" className={styles.btnOutline}>
            Referência rápida por tecnologia →
          </Link>
          <Link to="/guides" className={styles.btnOutline}>
            Tutoriais passo a passo →
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <Layout
      title="Stack Perl Moderno"
      description="Stack completo e opinativo para construir serviços de internet modernos em Perl — aplicações web, APIs HTTP e workers em background, fundamentado em referências reais e decisões arquiteturais documentadas."
    >
      <Hero />
      <main>
        <Features />
        <StackOverview />
      </main>
    </Layout>
  );
}
