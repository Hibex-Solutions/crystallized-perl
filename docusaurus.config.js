// @ts-check
const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Crystallized Perl',
  tagline: 'Stack completo e opinativo para serviços de internet modernos em Perl',
  favicon: 'img/logo.svg',

  url: 'https://hibex-solutions.github.io',
  baseUrl: '/crystallized-perl/',

  organizationName: 'Hibex-Solutions',
  projectName: 'crystallized-perl',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'pt-BR',
    locales: ['pt-BR'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: '/',
          editUrl:
            'https://github.com/Hibex-Solutions/crystallized-perl/edit/main/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/og-image.png',
      metadata: [
        { name: 'google-site-verification', content: 'OtRavKmbvZ9ieFf86nGLKJRkS6OxgDLaEP0Uhyp6m40' },
      ],
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      navbar: {
        logo: {
          alt: 'Crystallized Perl',
          src: 'img/logo.svg',
        },
        title: 'Crystallized Perl',
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'mainSidebar',
            position: 'left',
            label: 'Documentação',
          },
          {
            href: 'https://github.com/Hibex-Solutions/crystallized-perl',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Aprender',
            items: [
              {
                label: 'Primeiros Passos',
                to: '/getting-started',
              },
              {
                label: 'Guias',
                to: '/guides',
              },
              {
                label: 'Stack',
                to: '/stack',
              },
            ],
          },
          {
            title: 'Referência',
            items: [
              {
                label: 'Decisões (ADRs)',
                to: '/adrs/ADR-000-padrao-de-adrs',
              },
              {
                label: 'Referências',
                to: '/references/perl-org',
              },
            ],
          },
          {
            title: 'Projeto',
            items: [
              {
                label: 'GitHub',
                href: 'https://github.com/Hibex-Solutions/crystallized-perl',
              },
              {
                label: 'Contribuindo',
                href: 'https://github.com/Hibex-Solutions/crystallized-perl/blob/main/CONTRIBUTING.md',
              },
              {
                label: 'Código de Conduta',
                href: 'https://github.com/Hibex-Solutions/crystallized-perl/blob/main/CODE_OF_CONDUCT.md',
              },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Hibex Solutions. Licença MIT.`,
      },
      prism: {
        theme: prismThemes.vsLight,
        darkTheme: prismThemes.vsDark,
        additionalLanguages: ['perl', 'bash', 'yaml', 'json', 'docker'],
      },
    }),
};

module.exports = config;
