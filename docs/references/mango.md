# [Mango](https://metacpan.org/pod/Mango)

**Tipo**: Documentação Oficial  
**Autor(es)**: Sebastian Riedel  
**Publicado**: 2013 (atualizado continuamente)  
**Acessado**: 2026-06-27

## Relevância
Mango é um cliente Perl para bancos de dados com protocolo MongoDB (wire protocol),
projetado para trabalhar de forma não-bloqueante com o event loop do Mojolicious. No
stack Crystallized Perl, Mango atua como camada de acesso a documentos JSON sobre o
DocumentDB (extensão PostgreSQL com compatibilidade MongoDB), permitindo operações de
documento sem introduzir um banco de dados separado na infraestrutura — toda a
persistência reside em uma única instância PostgreSQL. A combinação Mango + DocumentDB
é a camada de acesso não-relacional do stack.

## Referenciada em
- ADR-017: Acesso a Dados de Documentos — PostgreSQL JSONB (alternativa considerada e rejeitada)
