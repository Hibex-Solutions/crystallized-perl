# [Moo — Minimalist Object Orientation](https://metacpan.org/pod/Moo)

**Tipo**: Documentação Oficial  
**Autor(es)**: Graham Knop (haarg) e colaboradores  
**Publicado**: 2010 (atualizado continuamente)  
**Acessado**: 2026-06-27

Documentação adicional: [docs.mojolicious.org/Moo](https://docs.mojolicious.org/Moo)

## Relevância
Moo é o sistema de orientação a objetos recomendado para o stack cloud-native em Perl.
Oferece declaração de classes e atributos via sintaxe declarativa (açúcar sintático
compatível com Moose), suporte a Roles para composição de comportamentos, construtores
automáticos e validação de atributos — sem exigir compilador C (sem dependências XS).
A ausência de XS é decisiva em imagens Docker multi-stage: a instalação é mais rápida,
a imagem final é menor e não há risco de incompatibilidade de bibliotecas C entre os
estágios de build e execução. O tempo de inicialização do Moo é significativamente
menor que o do Moose, o que favorece o boot rápido de Pods no Kubernetes. A API do
Moo é compatível com Moose, permitindo migração transparente caso recursos avançados
de introspecção sejam necessários no futuro.

## Referenciada em
- ADR-006: Sistema de Orientação a Objetos — Moo
