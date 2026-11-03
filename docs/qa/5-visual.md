# QA 5 — Refinamento visual e consistência

Data: 03/11/2026 · Testador: QA de interface (frente visual) · Versão: árvore atual de `src/`

## Como foi testado

- Modo demonstração no navegador (fotos do picsum.photos, sem backend Rust), servido sem cache em `http://127.0.0.1:5415`.
  Observação: `tools/serve.py` ignora a porta passada na linha de comando e sempre abre a 5310 (`tools/serve.py:8`). Para não brigar com o servidor de teste do usuário, usei uma cópia equivalente na porta 5415.
- Chromium headless (Playwright), 1400×900, 900×800 e 390×844, temas claro e escuro (`emulate_media(color_scheme)`), mais `reduced_motion="reduce"`.
- Telas capturadas: Biblioteca (Anos, Meses, Todas, Todas rolada), Coleções (topo e rolada), álbum, seleção, Apagados (bloqueado), Busca, Mapa, barra lateral aberta (900/390), menu "Mais", Ajustes, menu de contexto, alerta, prompt "Novo Álbum", aviso (toast), visualizador com e sem Informações, editor. Também simulei a janela sem moldura (`html.win-frameless`) para ver os botões da janela.
- Testes por script: ordem do Tab e foco visível, foco dentro do alerta, Esc no menu, teste de clique (`elementFromPoint`) no Mapa, durações com movimento reduzido.
- 144 capturas em `docs/qa/capturas/`. Nomes: `<tela>-<largura>-<claro|escuro>.png`.
- Nenhum arquivo de `src/` ou `src-tauri/` foi alterado por este teste. O `git status` já mostrava `src/` modificado por outro trabalho em paralelo; se esses arquivos mudarem, os números de linha abaixo podem andar.

Os números de linha são de `src/css/app.css`, `src/css/viewer.css` e `src/js/*.js` na árvore atual.

---

## Achados

### 1. Mapa cobre a barra superior e a barra inferior (os botões ficam invisíveis, mas continuam clicáveis)
- **Gravidade:** alto
- **Tela/tamanho:** Mapa, todos os tamanhos e temas
- **Arquivo:** `src/css/app.css:251` (`#view` sem `z-index`), `src/css/app.css:564` (`.mapwrap`), panes do Leaflet com `z-index: 400`
- **Problema:** `#view` não cria contexto de empilhamento. Os panes do Leaflet (`z-index: 400`) ficam acima de `#toolbar` (20), `#bottom` (20) e `.edge-*` (15). Na tela, o Mapa não mostra título, "Mais", botão da barra lateral nem a barra de abas. No iPhone (390) o usuário fica preso no Mapa, sem botão visível para sair. Os blocos do mapa têm `pointer-events: none`, então o clique ainda chega ao botão escondido: `elementFromPoint` no lugar do "Mais" devolve o ícone do botão, mas a captura não mostra nada.
- **Como deveria ser:** no iOS 26 o Mapa tem os controles de vidro flutuando por cima, com o botão Voltar e a barra de abas sempre visíveis.
- **Correção:** `#view { z-index: 0; isolation: isolate; }` (ou `.mapwrap { z-index: 0; isolation: isolate; }`). Os controles do Leaflet continuam dentro do mapa.
- **Capturas:** `mapa-1400-claro.png`, `mapa-390-claro.png`, `mapa-900-escuro.png`

### 2. Esc não fecha os menus (contexto e "Mais")
- **Gravidade:** alto (teclado/acessibilidade)
- **Tela/tamanho:** todas
- **Arquivo:** `src/js/ui.js:20-51` (`menu()`)
- **Problema:** `menu()` não escuta `keydown`. Testado nos 6 formatos: depois do Esc o `.menu` continua aberto. O foco também não entra no menu, as setas não navegam e os itens não têm `role="menuitem"`.
- **Como deveria ser:** menus do iOS/macOS fecham com Esc, aceitam ↑/↓ e Enter, e o foco vai para o primeiro item.
- **Correção:** em `menu()`, registrar `keydown` em captura: Esc chama `closeMenu()`, ↑/↓ movem o foco entre `.mi:not([disabled])` e Enter clica. Dar `role="menuitem"` aos botões e `tabindex=-1` + `focus()` no primeiro. Remover o ouvinte em `closeMenu()`.
- **Captura:** `menu-contexto-1400-claro.png` (o menu continua aberto depois do Esc; verificado por script)

### 3. Barra lateral escondida continua recebendo o foco do Tab
- **Gravidade:** alto (acessibilidade)
- **Tela/tamanho:** iPhone/iPad (barra lateral fechada) e Mac com a barra oculta
- **Arquivo:** `src/css/app.css:205` (`body.side-off #sidebar { … opacity: 0; pointer-events: none }`)
- **Problema:** a barra só fica transparente. No 390 os primeiros ~30 Tabs passam por "Buscar", "Biblioteca", "Favoritos"… todos invisíveis, e o foco some da tela.
- **Correção:** quando estiver fechada, adicionar `visibility: hidden` com atraso na transição (`transition: …, visibility 0s .55s`), ou definir `sidebar.inert = true` em `applySize`/`toggleSidebar`.
- **Captura:** verificado por script (ordem do Tab no 390). Visual de referência: `todas-390-claro.png`

### 4. Alerta e folhas não seguram o foco (sem `aria-modal`)
- **Gravidade:** alto (acessibilidade)
- **Tela/tamanho:** alerta "Apagar este item?", prompt "Novo Álbum", Ajustes
- **Arquivo:** `src/js/ui.js:53-71` (`modal`), `src/js/ui.js:77`
- **Problema:** quando o alerta abre, o foco fica no item da barra lateral por trás. Três Tabs depois, o foco está em "Vídeos", fora do alerta. Não há `aria-modal="true"` nem `aria-labelledby`. O fundo continua tabulável.
- **Como deveria ser:** o alerta do iOS é modal, e o botão padrão (ou o destrutivo) recebe o foco.
- **Correção:** `aria-modal="true"`, `aria-labelledby` apontando para o `h3`, foco inicial no botão primário (ou em Cancelar quando for destrutivo), Tab preso dentro do diálogo, `inert` em `#app` enquanto ele estiver aberto, e foco devolvido ao elemento de origem ao fechar.
- **Capturas:** `alerta-1400-claro.png`, `prompt-album-1400-claro.png`

### 5. O subtítulo da barra superior fica "órfão" e sobrepõe o título grande (álbuns e coleções em grade)
- **Gravidade:** médio
- **Tela/tamanho:** álbum, Favoritos, Vídeos, Dia, Viagem, Pasta; todos os tamanhos
- **Arquivo:** `src/js/app.js:682` (só `.tb-title b` recebe `opacity`)
- **Problema:** com título grande na página, o `<b>` da barra fica oculto, mas o `<span>` ("18 Fotos, 2 Vídeos") continua visível no topo, repetindo o texto do cabeçalho. Ao rolar, ele sobrepõe o título grande ("12 Fotos" por cima de "Fim de semana na praia…").
- **Como deveria ser:** no iOS o título pequeno da barra (título + subtítulo) aparece junto, com fade, quando o título grande sai da tela.
- **Correção:** aplicar a opacidade ao `.tb-title` inteiro (ou ao `span` também) e usar o mesmo critério de `pageWith` (`scrollTop > altura do .grid-head`).
- **Capturas:** `album-1400-claro.png`, `album-nome-longo-390-claro.png`

### 6. Faixa de esmaecimento inferior sempre ligada: borra o conteúdo mesmo sem barra embaixo
- **Gravidade:** médio
- **Tela/tamanho:** Coleções, Memórias, Viagens, Dias Recentes, Busca no Mac (1400), onde `#bottom` está vazio
- **Arquivo:** `src/css/app.css:270-275` (`.edge-bottom` sempre visível, 110 px, `backdrop-filter: blur(5px)` + gradiente branco/preto)
- **Problema:** os títulos dos cartões de Memórias e Viagens ("NESTE DIA", "RIO DE JANEIRO") ficam ilegíveis embaixo, e não há barra flutuante que justifique o efeito.
- **Como deveria ser:** no iOS 26 o efeito de borda de rolagem só aparece sob uma barra de vidro e é bem mais leve.
- **Correção:** mostrar `.edge-bottom` só quando `#bottom` tiver filhos (`#main:has(#bottom:empty) .edge-bottom { display:none }`) e reduzir para cerca de 70 px, com blur de 2–3 px.
- **Capturas:** `colecoes-1400-claro.png`, `colecoes-rolado-1400-escuro.png`

### 7. Cartões de álbum espalhados em Coleções (vãos enormes) e "Novo Álbum" desalinhado
- **Gravidade:** médio
- **Tela/tamanho:** Coleções › Álbuns, 1400 e 900
- **Arquivo:** `src/css/app.css:402` (`.hscroll` em grid sem `grid-auto-columns`), `src/css/app.css:442` (`.acard { width: 196px }`), `src/css/app.css:449`
- **Problema:** com poucos álbuns, as trilhas `auto` esticam até ocupar a largura toda: aparecem cerca de 160 px de vão entre "Família", "Viagem a Paris" e "Novo Álbum". O cartão "Novo Álbum" também fica ~10 px mais baixo, porque o `<button>` centraliza o conteúdo na vertical e esse cartão tem menos texto.
- **Como deveria ser:** no iOS os álbuns ficam encostados, com espaçamento fixo (~12 px), alinhados pelo topo.
- **Correção:** `.hscroll { grid-auto-columns: max-content; justify-content: start; }` e `.acard { display:flex; flex-direction:column; align-items:stretch; align-self:start; }`.
- **Capturas:** `colecoes-rolado-1400-claro.png`, `colecoes-rolado-1400-escuro.png`

### 8. Aviso (toast) quebra em 3 linhas e fica por cima das barras no iPhone
- **Gravidade:** médio
- **Tela/tamanho:** 390 (claro e escuro)
- **Arquivo:** `src/css/app.css:547-552` (`height: 44px` fixo, `bottom: 92px`)
- **Problema:** "Movido para Apagados Recentemente" quebra em 3 linhas dentro de uma pílula de 44 px (o texto vaza) e cai em cima do controle Anos/Meses/Todas.
- **Como deveria ser:** a pílula de aviso do iOS tem uma linha e fica acima das barras flutuantes.
- **Correção:** `white-space: nowrap; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; height: auto; min-height: 44px`. No phone, `html[data-size="phone"] .toast { bottom: 160px }` (acima das duas linhas de barra), ou calcular pela altura de `#bottom`.
- **Captura:** `aviso-390-escuro.png`, `aviso-390-claro.png`

### 9. No phone o conteúdo final fica escondido atrás das duas linhas de barras
- **Gravidade:** médio
- **Tela/tamanho:** 390: Todas, Anos, Meses, álbuns
- **Arquivo:** `src/css/app.css:353` (`.grid-foot` com `padding-bottom: 110px`), `src/css/app.css:366` (`.cards` com 120px); só `.page` tem ajuste para phone (`:672`, 170px)
- **Problema:** no iPhone, segmentado + barra de abas ocupam ~150 px. O rodapé "2.487 Fotos, 188 Vídeos" e o contador do último cartão de ano ("563 itens") ficam cortados por trás das barras.
- **Correção:** `html[data-size="phone"] .grid-foot { padding-bottom: 170px }` e `html[data-size="phone"] .cards { padding-bottom: 170px }`. O ideal é uma variável `--bottom-safe` usada em todos esses lugares.
- **Capturas:** `todas-390-claro.png`, `anos-390-escuro.png`

### 10. Janela sem moldura no tamanho iPhone: o título some ("O.")
- **Gravidade:** médio (no app instalado, com a janela estreita)
- **Tela/tamanho:** 390 com `win-frameless`
- **Arquivo:** `src/css/app.css:664` (`html.win-frameless[data-size="phone"] #toolbar { padding-right: calc(var(--winctl-w) + 6px) }`)
- **Problema:** os 136 px dos botões da janela, mais barra lateral, "Selecionar" e "Mais", deixam ~20 px para o título. "Outubro de 2026" vira "O.".
- **Correção:** no phone, esconder o título da barra (o grid-head/scroll já informa) ou trocar "Selecionar" por um ícone. Outra opção é reduzir os botões da janela para uma pílula de 3×30 px no phone.
- **Captura:** `sem-moldura-todas-390-claro.png`

### 11. Painel de Informações no iPhone: largura fixa de 360 px e barras do visualizador espremidas por trás
- **Gravidade:** médio
- **Tela/tamanho:** visualizador com Informações, 390
- **Arquivo:** `src/css/viewer.css:72-78` (`width: 360px`), `src/css/viewer.css:29,33,54` (`right: 394px / 380px / 398px`)
- **Problema:** no 390 sobra uma tira de 10 px do visualizador à esquerda. `.v-bottom { right: 380px }` deixa a barra de ações com largura negativa: aparece um pedaço do botão (i) no canto inferior esquerdo.
- **Como deveria ser:** no iPhone, as Informações sobem como folha inferior (a foto encolhe para cima). No iPad/Mac, painel lateral.
- **Correção:** `html[data-size="phone"] .v-info { left: 0; right: 0; top: auto; bottom: 0; width: auto; height: 60%; border-radius: 28px 28px 0 0; transform: translateY(100%) }` e, no phone, não aplicar os `right:` de `.with-info`. Usar uma variável `--info-w: 360px` no lugar dos números mágicos 380/394/398.
- **Captura:** `visualizador-info-390-claro.png`

### 12. Menus: itens quebram linha e a coluna do "✓" desalinha os rótulos
- **Gravidade:** médio
- **Tela/tamanho:** menu "Mais", todos os tamanhos
- **Arquivo:** `src/css/app.css:489` (`.menu .mi` com `height: 36px` sem `white-space: nowrap`), `src/css/app.css:495` (`.tick` com 14 px só nos itens que têm tick), `src/js/app.js:257`
- **Problema:** "Definir como App Padrão…" quebra em duas linhas dentro de 36 px (fica apertado e encosta em "Ajustes…"). "Proporção Original" começa 26 px à direita dos outros itens porque só ele reserva a coluna do ✓.
- **Como deveria ser:** nos menus do iOS/macOS, quando algum item tem marca de seleção, todos reservam a mesma coluna à esquerda. Os rótulos não quebram.
- **Correção:** `.menu .mi { white-space: nowrap; }`, aumentar o `min-width` para 260 px, e em `menu()` reservar `span.tick` em todos os itens quando algum tiver `tick !== undefined`.
- **Capturas:** `menu-mais-1400-claro.png`, `menu-mais-390-claro.png`

### 13. Ajustes no iPhone: rótulos cortados e "Aparência" some
- **Gravidade:** médio
- **Tela/tamanho:** Ajustes, 390
- **Arquivo:** `src/css/app.css:531` (`.sheet .row .lbl` com `white-space: nowrap` + ellipsis), `src/css/app.css:581` (`.sheet .row { height: 48px }`)
- **Problema:** aparecem "Abrir fotos e víd…", "Usar Windows Hello p…" e "Nomes de lugares (Op…". Na linha Aparência o rótulo é esmagado até sumir pelo segmentado Automático/Claro/Escuro.
- **Como deveria ser:** nas células do iOS o texto quebra em várias linhas (altura mínima de 44 pt), e controles largos vão para uma linha própria.
- **Correção:** `.sheet .row { height:auto; min-height:48px; padding-block:10px } .sheet .row .lbl { white-space: normal }`. No phone, a linha Aparência ganha `flex-wrap: wrap` com o segmentado em 100% de largura.
- **Captura:** `ajustes-390-claro.png`

### 14. Barra de seleção estoura a largura no iPhone
- **Gravidade:** médio
- **Tela/tamanho:** seleção, 390
- **Arquivo:** `src/css/app.css:558-559` (`.selbar`, `.count { min-width: 150px }`)
- **Problema:** a pílula encosta nas bordas da tela e "3 itens selecionados" quebra em 2 linhas.
- **Como deveria ser:** no iOS a contagem vai para o título da barra superior ("3 Itens Selecionados"), e embaixo ficam só ícones.
- **Correção:** no phone, `.selbar .count { min-width: 0; font-size: 13px; white-space: nowrap }`, ou mover a contagem para `setTitle()` e esconder `.count`. Também `max-width: calc(100vw - 24px)`.
- **Captura:** `selecao-390-claro.png`

### 15. Anos: o rótulo do ano dos cartões de cima fica escondido sob o título e a borda
- **Gravidade:** médio
- **Tela/tamanho:** Biblioteca › Anos, 1400 e 390
- **Arquivo:** `src/js/app.js` `yearsView` (`s.scrollTop = s.scrollHeight`), `src/css/app.css:263` (`.edge-top` de 96 px)
- **Problema:** ao abrir, a rolagem vai para o fim. Os anos dos cartões da primeira linha visível (2024/2025) ficam sob "Anos" e o esmaecimento branco. O cartão mais à esquerda aparece cinza/vazio (com `loading=lazy`, a imagem ainda não carregou e fica coberta pela borda).
- **Como deveria ser:** no iOS, a tela Anos abre mostrando os cartões inteiros, com o ano legível.
- **Correção:** ao abrir, rolar até um ponto em que a linha superior apareça inteira (`scrollTop = scrollHeight - clientHeight` e depois arredondar para o topo do cartão). Ou dar à `.cards` um `scroll-padding-top` de 76 px e usar `scrollIntoView({block:'end'})` no último cartão.
- **Capturas:** `anos-1400-claro.png`, `anos-390-escuro.png`

### 16. Botão remover pasta azul em vez de vermelho
- **Gravidade:** baixo
- **Tela/tamanho:** Ajustes, todos
- **Arquivo:** `src/css/app.css:532` (`.sheet .row .x { color: var(--red) }`) perde para `src/css/app.css:456` (`.row .ic { color: var(--accent) }`), que pinta o SVG direto
- **Como deveria ser:** no iOS, remover é ⊖ vermelho.
- **Correção:** `.sheet .row .x .ic { color: var(--red) }`. Se quiser o visual do iOS, usar um círculo vermelho preenchido com "−" branco.
- **Captura:** `ajustes-1400-claro.png`

### 17. Segmentado pequeno no escuro: a opção escolhida quase não aparece
- **Gravidade:** baixo
- **Tela/tamanho:** Ajustes › Aparência, escuro
- **Arquivo:** `src/css/app.css:542` (`.segsmall button.on { background: var(--bg-3) }` = `#1c1c1e` sobre vidro escuro)
- **Como deveria ser:** no modo escuro do iOS, o segmento escolhido é cinza claro (`#636366`).
- **Correção:** `:root[data-theme="dark"] .segsmall button.on { background: rgba(118,118,128,.55) }`, ou um token `--seg-on`.
- **Captura:** `ajustes-1400-escuro.png`

### 18. Botões da janela 4 px desalinhados com as pílulas do visualizador e do editor
- **Gravidade:** baixo
- **Tela/tamanho:** visualizador/editor no app sem moldura
- **Arquivo:** `src/css/app.css:101` (`.win-controls.glass { top: 12px; height: 40px }` → centro em 32), `src/css/viewer.css:23` e `:117` (`.v-top`/`.e-top` com `top: 12px; height: 48px` → centro em 36)
- **Problema:** "Editar ⋯" fica 4 px abaixo da pílula − □ ×. Na biblioteca o alinhamento está certo (barra de 64 px → centro em 32).
- **Correção:** `.v-top, .e-top { top: 8px }` (centro em 32), ou `html.win-frameless body:has(.viewer, .editor) .win-controls.glass { top: 16px }`.
- **Captura:** `sem-moldura-visualizador-info-1400-claro.png`

### 19. Botões do visualizador sem rótulo/tooltip
- **Gravidade:** baixo (acessibilidade)
- **Tela/tamanho:** visualizador, Informações e vídeo
- **Arquivo:** `src/js/viewer.js:550` (fechar Informações, só ícone ×), `src/js/viewer.js:249` (play/pausa), `src/js/viewer.js:252` (som), `src/js/viewer.js:253` (play grande)
- **Problema:** botões só com ícone, sem `title` nem `aria-label`. O leitor de tela lê "botão".
- **Correção:** `title`/`aria-label` "Fechar Informações", "Reproduzir"/"Pausar" (alternando), "Silenciar"/"Ativar Som". Os demais botões do app têm `title`. Seria bom o `h()` copiar `title` para `aria-label` quando não houver texto.
- **Captura:** `visualizador-info-1400-escuro.png`

### 20. Grade de fotos não navega pelo teclado
- **Gravidade:** médio (acessibilidade)
- **Tela/tamanho:** todas as grades
- **Arquivo:** `src/js/grid.js` (blocos são `div` sem `tabindex`/`role`), `src/css/app.css:349` (`.tile.focus` existe mas nunca é aplicado)
- **Problema:** não dá para chegar a uma foto com Tab/setas nem abrir com Enter. O estilo de foco já está pronto e nunca é usado.
- **Como deveria ser:** no Fotos do macOS/iPadOS com teclado, as setas movem a seleção, Espaço/Enter abre e o anel de foco fica visível.
- **Correção:** um `tabindex=0` só na grade (roving focus), `role="grid"`/`gridcell` com `aria-label` (data + tipo), setas atualizando `.focus` + `scrollToIndex`, Enter chamando `onOpen`.
- **Captura:** `foco-teclado-1400-claro.png` (o foco salta da barra direto para "Mais"; nenhuma foto é focável)

### 21. Foco visível só em parte dos controles
- **Gravidade:** baixo
- **Arquivo:** `src/css/app.css:600` (`.gbtn`, `.nav-item`, `.mi` apenas)
- **Problema:** os chevrons "Recolher" (`.nav-head button`), "+ Novo álbum", segmentados (`.seg button`, `.tabbar button`), `.switch`, `.row`, `.acard`/`.ycard`/`.mcard`/`.pin`, `.v-nav` e `.chip` usam o contorno padrão do Chromium (`auto 1px`), que destoa ou some sobre o vidro.
- **Correção:** um seletor global `:where(button, [role=switch], input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`. Para cartões com `overflow:hidden`, usar `outline-offset: -3px`.
- **Captura:** `foco-teclado-1400-claro.png`

### 22. Movimento reduzido não cobre as animações por JavaScript
- **Gravidade:** médio
- **Arquivo:** `src/js/memories.js:41` e `:51` (`img.animate(...)` Ken Burns, 6–8 s), `src/js/editor.js:337` (`scrollIntoView({behavior:'smooth'})`), `src/js/viewer.js` (zoom de abrir/fechar com estilos inline)
- **Problema:** a regra global (`src/css/app.css:580`) zera `transition`/`animation` do CSS, mas a Web Animations API não é afetada. As Memórias continuam com zoom/pan lento com `prefers-reduced-motion: reduce`. As transições inline do visualizador obedecem por causa do `!important`, mas o efeito de zoom vira um corte seco, sem crossfade alternativo.
- **Como deveria ser:** com "Reduzir Movimento" o iOS troca zoom/pan por dissolução.
- **Correção:** em `memories.js`, checar `matchMedia('(prefers-reduced-motion: reduce)')` e usar só opacidade. No editor, `behavior: reduce ? 'auto' : 'smooth'`. No visualizador, abrir/fechar com fade de 150 ms quando o movimento estiver reduzido.
- **Captura:** — (verificado no código e por script: `transitionDuration` = 1e-05s nos elementos CSS)

### 23. Ferramentas do editor cortadas sem esmaecimento e rótulos truncados
- **Gravidade:** baixo
- **Tela/tamanho:** editor, todos
- **Arquivo:** `src/css/viewer.css:135` (`.e-tools`), `:138` (`.e-tool .lbl { font-size: 10px; max-width: 64px; ellipsis }`)
- **Problema:** o carrossel termina em corte seco na borda ("Tonal…" pela metade). "Brilho Intenso" vira "Brilho Inten…". Rótulos de 10 px ficam abaixo do mínimo de legibilidade do iOS (11 pt).
- **Correção:** máscara `linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)` como a da régua (`.r-win`), `font-size: 11px` e `max-width: 72px`/largura do item 72 px.
- **Capturas:** `editor-1400-claro.png`, `editor-390-escuro.png`

### 24. Visualizador sem marcador de carregamento
- **Gravidade:** baixo
- **Tela/tamanho:** visualizador 1400 claro (demonstração)
- **Problema:** uma captura feita 1,8 s depois de abrir mostrou a área da foto toda em branco (as miniaturas da tira já tinham carregado). A miniatura `low` usa outro tamanho, diferente do da grade, e não está em cache. No app nativo a miniatura local deve chegar rápido, mas não há placeholder.
- **Correção:** usar a mesma URL/tamanho de miniatura da grade como `img.low` (já está em cache) e, se demorar mais que 300 ms, mostrar o `.spin`.
- **Captura:** `visualizador-1400-claro.png`

### 25. Informações em modo imersivo: painel claro "acinzentado" sobre o fundo preto
- **Gravidade:** baixo
- **Tela/tamanho:** visualizador imersivo + Informações, tema claro
- **Arquivo:** `src/css/viewer.css:7` (imersivo = `#000`), `src/css/viewer.css:76` (`--g-tint-strong` branco 78%)
- **Problema:** o vidro claro sobre preto vira um cinza `#c8c8c8` opaco, e o `--label-2` fica com contraste baixo.
- **Correção:** no imersivo, sair do imersivo ao abrir as Informações (o iOS faz isso), ou aplicar as variáveis escuras ao `.v-info` quando `.immersive`.
- **Captura:** `visualizador-imersivo-info-1400-claro.png` (para reproduzir: abrir uma foto, clicar na foto e apertar I)

### 26. Textos em português inconsistentes
- **Gravidade:** baixo
- **Arquivo/linhas:**
  - `src/js/app.js:354`: alerta de **um** item diz "Os itens ficarão…" (plural). Deveria ser "Esta foto ficará em Apagados Recentemente…" (singular) e o plural só quando `n > 1`.
  - `src/js/app.js:358`: toast singular diz "Movido para Apagados Recentemente", o plural diz "…movidos para **Apagados**". Usar sempre o nome da tela, "Apagados Recentemente".
  - `src/js/app.js:210`: o botão que encerra a seleção é "OK". No Fotos do iOS é "Cancelar" (ou ✕ no iOS 26).
  - `src/js/app.js:640`: "Apagados Recentemente está bloqueado" + "Use o Windows Hello para ver este **álbum**". Apagados/Ocultos são "coleções/utilidades", e o texto deveria nomear a tela: "Use o Windows Hello para ver Apagados Recentemente."
  - `src/js/viewer.js:555`: a lente aparece crua do EXIF em inglês ("back triple camera 6.765mm f/1.78"). O iOS mostra "Câmera Grande-angular — 24 mm ƒ1.78". Traduzir os padrões comuns (back/front, triple/dual, wide/ultra wide/telephoto) e trocar o ponto decimal por vírgula, como já é feito nas estatísticas ("ƒ1,78").
  - Mapa: os nomes dos países aparecem no idioma local ("United States", "Deutschland", árabe, tifinagh) porque os blocos padrão do OSM não são localizados. Para pt-BR, usar um provedor de blocos com rótulos em português ou só rótulos latinos.
- **Capturas:** `alerta-1400-claro.png`, `aviso-390-escuro.png`, `selecao-1400-claro.png`, `apagados-vazio-1400-claro.png`, `visualizador-info-1400-escuro.png`, `mapa-1400-claro.png`

### 27. Ação "Editar" duplicada no visualizador
- **Gravidade:** baixo
- **Arquivo:** `src/js/viewer.js:73` ("Editar" no topo) e `:101` (ícone de ajustes embaixo)
- **Como deveria ser:** no iOS 26 o editar fica só na barra inferior (ícone de ajustes) e o topo tem Voltar e "⋯".
- **Correção:** deixar só um. O ícone embaixo combina com o iOS 26; "Editar" textual no topo é coisa do iOS 17.
- **Captura:** `visualizador-900-claro.png`

### 28. Marcadores do mapa se sobrepõem
- **Gravidade:** baixo
- **Tela/tamanho:** Mapa, zoom inicial
- **Problema:** grupos "670" e "1.387" (SP/RJ) e "69"/"107" ficam empilhados um sobre o outro, e um contador cobre o outro.
- **Correção:** agrupar por distância em pixels (≥ 64 px) no zoom atual, ou deslocar os marcadores que colidirem.
- **Capturas:** `mapa-1400-claro.png`, `mapa-390-claro.png`

### 29. Barra lateral: a lista corta seco embaixo e em cima
- **Gravidade:** baixo
- **Arquivo:** `src/css/app.css:220` (`#nav`)
- **Problema:** o cabeçalho "Utilidades" aparece cortado pela metade na borda inferior do vidro. Ao rolar, os itens somem sob a busca sem transição.
- **Como deveria ser:** no iPadOS 26 a lista da barra lateral some suavemente nas bordas.
- **Correção:** `#nav { mask: linear-gradient(transparent, #000 12px, #000 calc(100% - 24px), transparent) }`.
- **Capturas:** `todas-1400-claro.png`, `foco-teclado-1400-claro.png`

### 30. Cor fixa clara no fixado "Mapa"
- **Gravidade:** baixo
- **Arquivo:** `src/css/app.css:439` (`.pin.map-pin { background: #dfe7ee; }`)
- **Problema:** sem foto de capa (biblioteca sem GPS), o cartão fica azul-claro no tema escuro.
- **Correção:** usar um token (`--map-bg`) com um valor no claro e outro no escuro (ex.: `#2a3138`).
- **Captura:** — (só aparece sem fotos com localização; visto no código)

### 31. Ícone do cartão "Apagados Recentemente" (fixado bloqueado) desalinhado
- **Gravidade:** baixo
- **Tela:** Coleções › Fixados
- **Arquivo:** `src/js/app.js` `pinTile` (estilo inline `color/background` no `.t`), `src/css/app.css:432`
- **Problema:** o nome quebra em 2 linhas e o ícone 🗑 fica centralizado na vertical em relação às duas linhas, solto. Os outros fixados têm uma linha só.
- **Correção:** `.pin .t { align-items: flex-start }` com o ícone em `margin-top: 2px`, ou `white-space: nowrap; text-overflow: ellipsis`. Trocar o `style` inline por uma classe `.pin.locked .t`.
- **Captura:** `colecoes-rolado-1400-claro.png`

### 32. Cartões "Dias Recentes": título passa por cima da divisão das fotos
- **Gravidade:** baixo
- **Tela:** Coleções › Dias Recentes
- **Arquivo:** `src/css/app.css:414` (`.dcard .t`)
- **Problema:** "Ter., 27 de outubro" atravessa a linha branca de 2 px entre as fotos. O gradiente de 0,55 não basta sobre fotos claras (a "Sexta-feira" sobre o céu claro fica fraca).
- **Correção:** gradiente mais alto (`padding-top: 60px`, até `rgba(0,0,0,.6)`) e `text-shadow` igual ao dos `.ycard`.
- **Captura:** `colecoes-1400-claro.png`

---

## Achados no CSS (organização, conflitos e regras mortas)

### 33. Regras duplicadas que se sobrescrevem
- **Gravidade:** baixo
- `.gbtn` tem `transition` em `src/css/app.css:173` e de novo em `:598`. O `:active` vale `scale(.9)` em `:177` e `scale(.86)` em `:599`. Só o segundo vale.
- `.menu` tem `animation: menu-in .38s` em `:485` e `.42s` em `:639`.
- A bolha da barra de abas é definida em `.tabbar .knob` (`:316`) e em `.tabbar > .knob` (`:679`).
- `:root[data-theme="dark"] .list { background: var(--bg-2) }` (`:453`) repete o valor herdado da regra de `:452`.
- `html.win-frameless .with-info .v-top { right: 394px }` (`:110`) é idêntica à de `src/css/viewer.css:29`.
- Há dois blocos `@media (prefers-reduced-motion: reduce)` (`:580` e `:644`).
- **Correção:** fundir cada par num lugar só. O arquivo cresceu por camadas (seção "movimento do Liquid Glass" no fim sobrescrevendo o começo).

### 34. Seletores mortos (nenhum JS aplica essas classes)
- **Gravidade:** baixo
- `.on-photo …` (`src/css/app.css:281`), `.menu .mi.checked::before` (`:494`, o menu usa `span.tick`), `.tile.focus` (`:349`), `.scroller.snap` (`:253`), `.glass.strong` (`:163`), `.glass.clear` (`:164`).
- **Correção:** remover, ou implementar (`.tile.focus` → achado 20).

### 35. Números mágicos e seletores frágeis
- **Gravidade:** baixo
- Largura do painel de Informações espalhada em 360/380/394/398 (`src/css/viewer.css:29,33,54,73`, `src/css/app.css:110`) → `--info-w`.
- 76 px de espaço sob a barra repetidos em `.page`, `.grid-head`, `.cards` (`:357`, `:361`, `:366`), além do `68px` inline em `app.js` (`gridView`) → `--top-safe`.
- Raio dos cartões varia sem regra: 18/20/22 px (`.acard .cv`, `.dcard`/`.pin`, `.ycard`/`.memcard`). O iOS 26 usa um raio concêntrico só para cartões de mídia.
- `src/css/viewer.css:143` `.e-tool .ring[style*="--neg: 1"]` depende do texto exato do `style` inline. `src/css/viewer.css:150` `.e-tool[title="Auto"]` depende do texto traduzido do `title`. Trocar por classes (`.neg`, `.auto`).

### 36. Cores fixas que ignoram o tema
- **Gravidade:** baixo
- `#e5484d`/`#c93b40` no fechar da janela (`src/css/app.css:97-98`): aceitável (padrão do Windows), mas poderia usar `--red`.
- `.pin.map-pin #dfe7ee` (achado 30).
- `.tile::after { background: #fff }` no hover (`:340`): no tema escuro o hover clareia. O macOS escurece levemente. Melhor `color-mix(in srgb, var(--label) 8%, transparent)`.
- `.seg .knob`/`.nav-knob`/`.lg-group > .hov` usam `inset … rgba(255,255,255,.25)` também no claro: some sobre o branco. Funciona, mas o realce de borda do vidro não aparece no tema claro.

### 37. Pilha de z-index sem escala definida
- **Gravidade:** baixo
- Valores em uso: 1, 2, 4, 5, 6, 15, 20, 25, 30, 55, 60, 100, 140, 150, 160, 200, 210, 260, 500, 2147483646, 2147483647. A falta de contexto em `#view` é a causa do achado 1. Repare também que a `.memory` (160) fica acima do `.scrim` (150): um alerta aberto durante uma memória fica com o fundo da memória sem esmaecer.
- **Correção:** tokens `--z-content`, `--z-chrome`, `--z-overlay`, `--z-modal`, `--z-toast` e `isolation: isolate` em `#view`, `.viewer` e `.editor`.

### 38. Barra de rolagem do carrossel diferente das outras
- **Gravidade:** baixo
- `src/css/app.css:402` `.hscroll { scrollbar-width: thin }`: no Chromium 121+ o `scrollbar-width` desliga o `::-webkit-scrollbar` personalizado (`:129-132`). O carrossel mostra a barra padrão do Windows, cinza e sempre visível, diferente da barra fina "só no hover" do resto do app.
- **Correção:** tirar o `scrollbar-width` do `.hscroll` (ou usar `scrollbar-color: transparent transparent` + hover).

---

## O que está bom

- O vidro (borda de luz em gradiente, reflexo que segue o cursor, sombra dupla) está consistente entre barra lateral, pílulas, menus, alertas e folhas, nos dois temas.
- A bolha que desliza entre itens da barra lateral e entre botões da pílula funciona sem travar. O segmentado "incha" ao pressionar como no iOS.
- O foco visível de `.gbtn`/`.nav-item` é claro (anel azul de 2 px). Todos os botões da biblioteca têm `title`.
- O tema escuro tem bom contraste geral. O mapa escuro (filtro de inversão) ficou bonito.
- Alerta, prompt e toast seguem as proporções do iOS 26 (pílulas de 46 px, raio de 30 px, texto centralizado).
- Nenhum erro de console ou de página nas 6 combinações de tamanho/tema.

---

## Resumo: 12 achados mais importantes

1. **(alto)** Mapa cobre a barra superior e a de abas (falta `z-index`/`isolation` em `#view`). No iPhone não há saída visível. `mapa-390-claro.png`
2. **(alto)** Esc não fecha menus, e menus não têm navegação por teclado nem `role="menuitem"` (`ui.js:20`). `menu-contexto-1400-claro.png`
3. **(alto)** A barra lateral escondida continua recebendo o Tab (só `opacity: 0`, `app.css:205`).
4. **(alto)** O alerta não move nem prende o foco e não tem `aria-modal` (`ui.js:53-77`). `alerta-1400-claro.png`
5. **(médio)** Subtítulo órfão na barra superior sobrepõe o título grande em álbuns (`app.js:682`). `album-nome-longo-390-claro.png`
6. **(médio)** `.edge-bottom` sempre ligado borra títulos de Memórias/Viagens mesmo sem barra embaixo (`app.css:270`). `colecoes-1400-claro.png`
7. **(médio)** Álbuns em Coleções com vãos enormes e "Novo Álbum" desalinhado (`.hscroll` sem `grid-auto-columns`, `app.css:402`). `colecoes-rolado-1400-claro.png`
8. **(médio)** Toast quebra em 3 linhas e cai sobre as barras no iPhone (`app.css:547`). `aviso-390-escuro.png`
9. **(médio)** Painel de Informações com 360 px fixos no iPhone espreme as barras do visualizador (`viewer.css:72`, `:29/:33/:54`). `visualizador-info-390-claro.png`
10. **(médio)** Grade de fotos inacessível pelo teclado; `.tile.focus` existe e nunca é usado (`grid.js`, `app.css:349`).
11. **(médio)** No iPhone, rodapé da grade e último cartão de Anos ficam atrás das barras; Ajustes e barra de seleção cortam/quebram texto (`app.css:353`, `:366`, `:531`, `:559`). `todas-390-claro.png`, `ajustes-390-claro.png`, `selecao-390-claro.png`
12. **(médio)** Movimento reduzido não para o Ken Burns das Memórias (WAAPI em `memories.js:41`) nem a rolagem suave do editor.

---

## Correções (03/11)

Arquivos: `src/css/app.css`, `src/css/viewer.css` (só o visualizador e o painel; as seções do editor não foram tocadas), `src/index.html`, `src/js/app.js`, `ui.js`, `grid.js`, `memories.js`, `viewer.js` e `util.js`. Antes de mexer, conferi o que os outros colegas já tinham corrigido (seções "Correções" dos relatórios 1 e 2). Testes no modo demonstração (`python tools/serve.py src 5425`), com Playwright/Chromium em 1400×900, 900×800 e 390×844, nos temas claro e escuro, e na janela sem moldura simulada. As capturas de depois estão em `docs/qa/capturas/depois/`. Também rodei um script de teclado e foco. Nenhum erro no console nem na página. Rodei `node --check` nos 6 JS alterados.

1. **Corrigido.** `#view` agora tem `z-index: 0; isolation: isolate`. No Mapa, o título, o "Mais", a barra lateral e as abas aparecem por cima, e `elementFromPoint` no "Mais" cai na barra. No iPhone/iPad, o +/− do mapa sobe acima das abas (`mapa-*`).
2. **Já estava corrigido** (Esc, ↑/↓, Home/End). Complementei: o foco entra no primeiro item e volta ao botão de origem ao fechar, e os itens têm `role="menuitem"`/`menuitemcheckbox` com `aria-checked`.
3. **Corrigido.** Fechada, a barra fica com `visibility: hidden`, que só vale depois do deslize de .55 s. Ao abrir, ela volta na hora. No 390, os 8 primeiros Tabs passam pela barra superior, pela grade e pelas abas, e nenhum cai na barra lateral. A barra aberta pela busca continua visível e com o foco no campo (`lateral-aberta-*`).
4. **Corrigido.** `modal()` em `ui.js`: `aria-modal`, `aria-labelledby` no título, alerta com `role="alertdialog"`, foco inicial (campo › botão principal › Cancelar quando o botão é destrutivo), Tab preso, `#app` inerte e foco devolvido ao fechar. As folhas usam uma pilha: Esc num alerta aberto sobre os Ajustes fecha só o alerta. Antes fechava os dois.
5. **Já estava corrigido** (`tbFade` no `.tb-title` inteiro). Confirmado em `album-*`.
6. **Corrigido.** `#main:has(#bottom:empty) .edge-bottom { display: none }`. Quando há barra embaixo, a faixa ficou mais leve (96 px e blur de 3 px). Os títulos de Memórias e Viagens ficam legíveis (`colecoes-1400-*`).
7. **Corrigido.** `.hscroll` usa `grid-auto-columns: max-content`, `justify-content: start` e `align-items: start`. `.acard` virou coluna flex. Os álbuns ficam encostados a 12 px e "Novo Álbum" alinha pelo topo (`colecoes-rolado-*`).
8. **Corrigido.** O aviso tem uma linha com reticências, `max-width: calc(100vw - 32px)` e `min-height: 44px`. No iPhone fica a 140 px do fundo, acima das duas barras. Ganhou `role="status"` (`aviso-390-*`).
9. **Corrigido.** O `.grid-foot` já tinha 180 px. Agora há `--bottom-safe` (120 px; 180 px no iPhone), usado por `.grid-foot`, `.page` e `.cards`, e o último cartão de Anos/Meses não fica atrás das barras (`anos-390-*`).
10. **Corrigido.** Na janela sem moldura no tamanho iPhone, os botões da janela ficam com 96 px e "Selecionar" vira ícone. O título passou de "O." para "Outubro de…" (`sem-moldura-todas-390-claro.png`).
11. **Já estava corrigido** (folha abaixo de 760 px). Complementei: `--info-w` no lugar de 360/380/394/398, inclusive no `fit()` do `viewer.js`. Também corrigi um efeito da janela sem moldura: o `top: 50px` puxava a folha para o alto da tela no 390 (`sem-moldura-visualizador-info-390-claro.png`).
12. **Corrigido.** `white-space: nowrap`. Quando algum item tem ✓, todos reservam a coluna, e os rótulos começam no mesmo x. Um defeito apareceu junto: a posição do menu era medida já encolhida pela animação (`scale(.82)`), e o menu mais largo saía da tela. Agora a medida usa `offsetWidth`, com limite na borda (`menu-mais-*`).
13. **Corrigido.** As linhas da folha usam `height: auto` e `min-height: 48px`, e o rótulo quebra linha. No iPhone, o segmentado de Aparência vai para uma linha própria, em largura total (`ajustes-390-*`).
14. **Já estava corrigido** (contagem sem `min-width` no phone).
15. **Não corrigido.** Subir a rolagem até o topo de um cartão inteiro deixa o ano mais recente cortado embaixo, atrás das barras. Para escolher um dos dois lados, é preciso uma decisão de desenho (talvez `scroll-snap`). Com o `--bottom-safe`, o cartão de 2026 aparece inteiro.
16. **Corrigido.** `.sheet .row .x .ic { color: var(--red) }`.
17. **Corrigido.** Token `--seg-on`: no claro, `--bg-3`; no escuro, `#636366` (`ajustes-1400-escuro.png`).
18. **Corrigido.** Sobre o visualizador ou o editor, a pílula da janela desce para `top: 16px` (centro em 36, igual ao das pílulas), com transição. O painel de Informações começa em 64 px (antes, 50), para não ficar por baixo dela (`sem-moldura-visualizador-info-1400-claro.png`).
19. **Já estava corrigido** (`aria-label` em todos os botões do visualizador).
20. **Corrigido.** A grade é uma parada só no Tab (`tabindex=0`, `role="listbox"`, `aria-activedescendant`). Os quadrados são `role="option"`, com `aria-label` (tipo e data) e `aria-selected`. ←→↑↓, Home/End e PageUp/PageDown movem o `.tile.focus`. Enter/Espaço abre a foto, e, no modo de seleção, marca e desmarca. O anel só aparece pelo teclado e some ao clicar. Ao fechar o visualizador, o foco volta à grade (`foco-grade-1400-claro.png`).
21. **Corrigido.** Um anel global `:where(button, a, [role=switch], [role=button], [tabindex], input[type=range]):focus-visible` (2 px, `--accent`). Nas faixas de Coleções e nos Fixados ele fica para dentro (`-3px`).
22. **Parcialmente.** Com "Reduzir Movimento", as Memórias não fazem mais o Ken Burns e ficam só com a dissolução (medido: 0 animações de `transform`, contra 1 no modo normal). O editor (`scrollIntoView`) está em `editor.js`, fora dos meus arquivos. A dissolução no lugar do zoom ao abrir o visualizador também não foi feita: mexe na animação de abrir/fechar, que é da frente do visualizador.
23. **Não corrigido.** São seções do editor, que estão mudando para `editor.css` com outro colega.
24. **Não corrigido.** O marcador de carregamento mexe no carregamento `low`/`hi` do `viewer.js`, que o colega do visualizador acabou de refazer. Fica com essa frente.
25. **Corrigido.** No modo imersivo, o `.v-info` usa as variáveis do tema escuro.
26. **Parcialmente.** Corrigidos: o alerta de um item diz "Esta foto ficará…"/"Este vídeo ficará…"; o botão que sai da seleção é "Cancelar"; a tela trancada diz "Use o Windows Hello para ver Apagados Recentemente."; a lente da Apple vem traduzida ("Câmera tripla traseira — 6,765 mm ƒ1,78"); os avisos já diziam "Apagados Recentemente". Não corrigido: os nomes de países no mapa dependem do provedor de blocos (`map.js`, fora dos meus arquivos).
27. **Não corrigido.** É decisão de produto, e a frente do visualizador também deixou para depois.
28. **Não corrigido.** O agrupamento por distância está em `map.js`, fora dos meus arquivos.
29. **Corrigido.** `#nav` ganhou uma máscara que esmaece 10 px em cima e 22 px embaixo.
30. **Corrigido.** Token `--map-bg`: `#dfe7ee` no claro, `#2a3138` no escuro.
31. **Corrigido.** O ícone alinha pela primeira linha (`align-items: flex-start`). O estilo inline virou `.pin.locked .t`.
32. **Parcialmente.** O gradiente ficou mais alto e mais escuro, e o texto ganhou `text-shadow`. O título continua passando sobre a divisão branca das fotos, que é o desenho do cartão.
33. **Corrigido.** Fundi `.gbtn` (transição e `:active` que valiam), a animação do `.menu` (.42 s), a bolha da barra de abas, o `.list` escuro repetido e os dois blocos de movimento reduzido. `html.win-frameless .with-info .v-top` não era duplicata: vence `html.win-frameless .v-top` pela especificidade. Ficou, agora com `--info-w`.
34. **Corrigido.** Removi `.on-photo`, `.menu .mi.checked::before`, `.scroller.snap`, `.glass.strong` e `.glass.clear`. O `.tile.focus` passou a ser usado (achado 20).
35. **Parcialmente.** Entraram `--info-w`, `--top-safe` (inclusive no espaçador de 68 px do `gridView`) e `--bottom-safe`. Os raios dos cartões não mudaram, porque mudaria a aparência. Os seletores frágeis do editor (`[style*="--neg"]`, `[title="Auto"]`) ficam em seções que não posso editar.
36. **Parcialmente.** No escuro, o hover do quadrado escurece em vez de clarear, e `.pin.map-pin` usa um token. O vermelho do fechar da janela continua o padrão do Windows. O realce branco da bolha no tema claro não mudou, porque é ajuste fino de vidro sem defeito funcional.
37. **Parcialmente.** `#view` isolado, que era a causa do achado 1. A escala de tokens de z-index não foi feita, porque é uma refatoração ampla que mexe em `viewer.css`/`editor.css`. Memória sobre alerta não acontece na prática: a memória segura o teclado e não abre alertas.
38. **Corrigido.** `scrollbar-width` saiu do `.hscroll`, que voltou à barra fina "só no hover".

Outras mudanças feitas junto:
- A barra superior veio antes de `#view` no DOM, para o Tab passar por ela antes da grade. O empilhamento visual continua pelo z-index.
- O `index.html` ganhou `<link rel="stylesheet" href="css/editor.css">`, que o colega do editor pediu no comentário do arquivo. O arquivo não foi tocado.
