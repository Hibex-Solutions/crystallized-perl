# [Carton — Perl module dependency manager](https://github.com/perl-carton/carton)

**Tipo**: Repositório Open Source  
**Autor(es)**: Tatsuhiko Miyagawa e colaboradores  
**Publicado**: 2011 (atualizado continuamente)  
**Acessado**: 2026-06-27

## Relevância
Carton é o gerenciador de dependências padrão do Modern Perl — equivalente ao Bundler
(Ruby) ou npm (Node.js). Usa o arquivo `cpanfile` para declarar dependências do projeto
e gera um `cpanfile.snapshot` que congela as versões exatas de todos os módulos,
incluindo dependências transitivas. O snapshot deve ser versionado no Git, garantindo
que qualquer checkout produza um ambiente idêntico — requisito direto do fator II
(Dependências) da metodologia 12-factor. Em imagens Docker, o multi-stage build usa
o Carton no estágio de build e copia apenas a pasta `local/` resultante para a imagem
final de produção, mantendo-a leve e livre de compiladores. Carton internamente usa o
`cpanm` (App::cpanminus) para instalar os módulos.

## Referenciada em
- ADR-005: Gerenciamento de Dependências — Carton + cpanm
- ADR-011: Estratégia de Testes
