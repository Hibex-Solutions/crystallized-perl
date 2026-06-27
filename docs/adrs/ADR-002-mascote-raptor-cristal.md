# ADR-002: Mascote — Raptor Cristalizado

**Status**: Aceita  
**Data**: 2026-06-26

## Contexto

Projetos de documentação com forte identidade visual têm maior reconhecimento e engajamento.
O Perl possui dois símbolos amplamente reconhecidos: o camelo (trademark O'Reilly, alto
reconhecimento, restrições de uso) e o velociraptor (símbolo comunitário, sem restrições).
Uma escolha de mascote deve ser original, livre de barreiras legais, e deve comunicar a
proposta do projeto de forma visual e conceitual.

## Decisão

**Mascote: Raptor Cristalizado** (Crystal Raptor)

Um velociraptor renderizado em estilo *low-poly* / geométrico-cristalino, com as seguintes
características:

- **Silhueta externa**: forma orgânica do raptor — reconhecível pela comunidade Perl
- **Preenchimento interno**: facetas triangulares/poligonais com gradiente de cores
  da paleta do projeto (ver ADR-003)
- **Elementos de código**: fragmentos de sintaxe Perl modernos visíveis nas facetas,
  conectando o mascote diretamente à linguagem
- **Três ângulos canônicos**: vista lateral esquerda, frontal e lateral direita
  (conforme concept art em [`references/raptor-cristal-draft.png`](references/raptor-cristal-draft.png))

### Metáfora conceitual

| Elemento visual | Significado |
|----------------|-------------|
| Silhueta orgânica do raptor | Perl clássico — poderoso, moldado nos anos 90 |
| Facetas geométricas internas | Modernização — ordem matemática, boas práticas, cloud-native |
| Transição de cores (turquesa → laranja → roxo) | Refração da luz em um cristal; transparência estrutural |
| Código Perl nas facetas | A linguagem é a substância, não apenas a forma |

A metáfora é: o mesmo animal, estruturado por práticas de engenharia modernas. O Perl
não mudou de natureza — foi lapidado.

## Justificativa

1. **Sem barreiras de trademark**: O raptor é símbolo comunitário do Perl, sem restrições
   de uso (ao contrário do camelo O'Reilly que exige permissão formal)
2. **Diferenciação**: O tratamento cristalino/low-poly é original no ecossistema Perl;
   não existe outro projeto com este tratamento visual
3. **Coerência com a tese do projeto**: A "lapidação" geométrica é exatamente a metáfora
   de modernização — o mesmo poder, estruturado por disciplina técnica
4. **Escalabilidade vetorial**: O estilo low-poly funciona em 32px (favicon) e em formatos
   grandes (banner 1280×320, og-image 1200×630)

> Referência interna: [`references/RASCUNHO.md`](references/RASCUNHO.md) — seções "Uma
> Metáfora Conceitual" e "Direção de Arte para o Logo e Identidade Visual";
> concept art [`references/raptor-cristal-draft.png`](references/raptor-cristal-draft.png).

Referências externas:
- [`perl-org`](../references/perl-org.md) — portal oficial da comunidade Perl; o raptor é símbolo comunitário mantido por essa mesma comunidade
- [`modern-perl-book`](../references/modern-perl-book.md) — o raptor está associado à cultura "Modern Perl" que este livro representa

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| Camelo O'Reilly | Trademark registrado; uso requer permissão formal da O'Reilly |
| Cebola Perl (Perl Onion) | Menor reconhecimento; sem metáfora visual de modernização |
| Raptor clássico sem estilização | Já existe na comunidade; sem diferenciação; sem metáfora |
| Símbolo abstrato / ícone original | Perde a conexão com a herança visual da comunidade Perl |

## Consequências

- **Positivo**: Mascote original, sem problemas legais, com forte fundação conceitual
- **Positivo**: Concept art já produzido (`references/raptor-cristal-draft.png`) como
  referência para produção do asset final
- **Negativo**: Requer produção de arte final em SVG (o concept art é raster PNG, não
  pronto para produção como `assets/images/logo.svg` e `assets/images/banner.svg`)
- **Ação necessária**: Comissionar SVG final a partir do concept art em `references/`
