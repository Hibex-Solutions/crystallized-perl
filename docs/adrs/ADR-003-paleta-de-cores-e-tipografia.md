# ADR-003: Paleta de Cores e Tipografia

**Status**: Aceita  
**Data**: 2026-06-26

## Contexto

A identidade visual do projeto exige um sistema de cores consistente para o site de
documentação, mascote e demais assets. O sistema deve suportar modo claro e escuro,
comunicar modernidade e precisão técnica, e manter vínculo semântico com a herança
visual do Perl e com o mascote Raptor Cristalizado (ADR-002).

## Decisão

### Paleta de Cores

Os tokens abaixo são o contrato de design para todo o projeto. A implementação concreta
será feita via CSS custom properties no tema Docusaurus.

#### Modo Claro (Light Mode)

| Token | Hex | Nome semântico |
|-------|-----|----------------|
| `--color-bg` | `#FFFFFF` | Fundo principal |
| `--color-text` | `#0F172A` | Texto base (Slate Deep) |
| `--color-code-neutral` | `#2A2F3A` | Sintaxe de código (neutral) |
| `--color-mosaic-blue` | `#007399` | Mosaico azul — Camel Blue histórico |
| `--color-mosaic-orange` | `#F97316` | Mosaico laranja — energia do Raptor |
| `--color-mosaic-purple` | `#8B5CF6` | Mosaico roxo — tecnologia madura |
| `--color-accent-primary` | `#06B6D4` | Acento primário (Ciano Tech) |
| `--color-accent-secondary` | `#F43F5E` | Acento secundário (Coral Alert) |

#### Modo Escuro (Dark Mode)

| Token | Hex | Nome semântico |
|-------|-----|----------------|
| `--color-bg` | `#0F172A` | Fundo principal (Slate Deep) |
| `--color-text` | `#E2E8F0` | Texto base |
| `--color-code-neutral` | `#2A2F3A` | Sintaxe de código (neutral) |
| `--color-mosaic-green` | `#10B981` | Mosaico verde (Syntax Success) |
| `--color-mosaic-red` | `#F43F5E` | Mosaico vermelho/coral (Modern Alert) |
| `--color-mosaic-amber` | `#F59E0B` | Mosaico âmbar (Modern Amber) |
| `--color-accent-primary` | `#F59E0B` | Acento primário (Âmbar Moderno) |
| `--color-accent-secondary` | `#D1D5DB` | Acento secundário (Slate Muted) |

**Nota**: O modo escuro usa um conjunto de mosaicos diferente do modo claro. Isso é
intencional — a metáfora do cristal refrata cores distintas dependendo do ângulo de luz.
A implementação deve garantir que os tokens de mosaico não sejam misturados entre modos.

### Tipografia

| Uso | Fonte selecionada | Alternativas consideradas |
|-----|------------------|--------------------------|
| Títulos, interface, corpo de texto | **Inter** | Poppins, Montserrat |
| Blocos de código e exemplos Perl | **JetBrains Mono** | Fira Code |

Ambas as fontes são open-source e disponíveis via Google Fonts / JetBrains.

## Justificativa

### Cores

- **Azul `#007399`**: referência explícita ao "Camel Blue" histórico do Perl — aceno de
  continuidade com a herança da linguagem sem usar o trademark do camelo
- **Laranja `#F97316`**: conecta ao livro *Modern Perl* de brian d foy, cuja identidade
  visual usa laranja como cor dominante; simboliza a energia ativa do projeto
- **Roxo `#8B5CF6`**: profundidade e maturidade tecnológica; completa o trio de mosaico
  criando a transição cromática do cristal
- **Ciano `#06B6D4`** (acento primário, light): tecnologia e precisão; cloud-native vibe
- **Âmbar `#F59E0B`** (acento primário, dark): calor e clareza sobre fundo escuro
- **`#0F172A` como base dupla**: a mesma cor serve como texto no modo claro e como fundo
  no modo escuro — sistema coeso, fácil de implementar e verificar

### Tipografia

- **Inter**: projetada para telas, excelente legibilidade em tamanhos pequenos de UI,
  geometria limpa sem serifa; padrão de facto em documentações técnicas modernas
- **JetBrains Mono**: fonte mono-espaçada com ligaduras projetada especificamente para
  código; suporte completo a operadores Perl (`->`, `=>`, `//`, `!=`); amplamente adotada

> Referência interna: [`references/RASCUNHO.md`](references/RASCUNHO.md) — seções "Uma
> Paleta de Cores Cristalina" e "Tipografia"; guia visual
> [`references/raptor-cristal-palette-draft.png`](references/raptor-cristal-palette-draft.png).

Referências externas:
- [`modern-perl-book`](../references/modern-perl-book.md) — identidade visual laranja do livro é a origem semântica do `#F97316`

## Alternativas Consideradas

| Alternativa | Motivo da rejeição |
|-------------|-------------------|
| Navy + Amber (sugestão inicial do CLAUDE.md) | Substituída pela paleta cristalina, semanticamente integrada com ADR-002 |
| Paleta monocromática | Não comunica a metáfora de refração do cristal; menos expressiva |
| Poppins (heading) | Inter tem legibilidade superior em tamanhos pequenos de UI |
| Fira Code (mono) | JetBrains Mono tem ligaduras mais completas para operadores Perl |

## Consequências

- **Positivo**: Sistema de dois modos completo e documentado com tokens CSS nomeados
- **Positivo**: Vínculo semântico entre cada cor e a metáfora do mascote (ADR-002)
- **Positivo**: Tokens prontos para implementar como override no tema Docusaurus
- **Negativo**: Mosaicos distintos por modo requerem atenção na implementação do tema
- **Ação necessária**: Verificar contraste WCAG 2.1 AA de todos os pares texto/fundo
  antes de finalizar o site (`#0F172A` sobre `#FFFFFF` e `#E2E8F0` sobre `#0F172A`)
