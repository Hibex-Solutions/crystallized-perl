# [DocumentDB — Open Source Document Database](https://www.documentdb.com/)

**Tipo**: Documentação Oficial  
**Autor(es)**: Comunidade open source  
**Publicado**: 2025  
**Acessado**: 2026-06-26

## Relevância
DocumentDB open source é uma extensão PostgreSQL que implementa o protocolo de wire do
MongoDB, adicionando suporte a banco de dados de documentos JSON sobre o mesmo motor
PostgreSQL já utilizado para dados relacionais. Essa arquitetura elimina a necessidade
de um segundo serviço de banco de dados na infraestrutura: uma única instância
PostgreSQL serve tanto queries SQL (via Mojo::Pg) quanto operações de documento
(via Mango, que fala o protocolo MongoDB). No stack Crystallized Perl, DocumentDB é a
camada não-relacional — a alternativa ao MongoDB sem introduzir nova tecnologia de
infra.

## Referenciada em
- ADR-017: Acesso a Dados de Documentos — PostgreSQL JSONB (alternativa considerada e rejeitada)
