# QA 2 — Visualizador de fotos e vídeos

Frente: `src/js/viewer.js`, `src/css/viewer.css`, `openFromPath` em `src/js/app.js` e a apresentação em `src/js/memories.js`.
Data: 03/11/2026.

**Como foi testado:** revisão do código e testes no Chromium headless (Playwright para Python) em modo demonstração, com `python -m http.server 5412 --directory src`. Não usei `tools/serve.py` porque ele ignora a porta (achado 24). Antes de carregar a página, injetei contadores em `addEventListener`/`removeEventListener` e em `HTMLMediaElement.play`. Nenhum arquivo do app foi alterado.

**Sobre as linhas:** os números se referem ao `viewer.js` lido no início do QA. Outra pessoa está editando esse arquivo agora (o `git status` já mostra `M src/js/viewer.js`), então as linhas podem ter mudado um pouco.

**Limites do modo demonstração:** os "vídeos" não têm arquivo de vídeo real e o Nominatim é bloqueado por CORS. Por isso, os achados de vídeo e de nomes de lugares que dependem do app nativo aparecem como "confirmado por leitura do código" ou como suspeita.

---

## A. Bugs confirmados no navegador

### 1. Alto: o painel de informações é refeito sozinho enquanto você digita a legenda, e as letras viram atalhos
- **Onde:** `viewer.js:203` (o `resolvePlace(...).then(... if (V?.info) renderInfo())`) e `viewer.js:524-529` (`renderInfo` recria a `textarea`).
- **O que acontece:** ao chegar numa foto com GPS cujo nome de lugar ainda não está guardado, `show()` pede o nome ao Nominatim. Quando a resposta chega (ou falha), `renderInfo()` reconstrói o painel inteiro, inclusive a `textarea` da legenda. O foco vai para o `body`, e as próximas teclas caem no `onKey` do visualizador: **E** abre o editor, **F** favorita, **I** fecha o painel, **Espaço** alterna a interface e **Delete** pede para apagar. No app nativo a fila do Nominatim espera 1,1 s entre pedidos, então isso acontece 1 a 3 s depois de trocar de foto, justamente quando a pessoa começa a digitar.
- **Medido:** depois de `→` com o painel aberto, a `textarea` era outro elemento 1,5 s depois em 2 de 4 fotos. Num teste digitando "Legenda de teste", o texto não foi salvo e o foco terminou no `body`.
- **Reproduzir:** abrir uma foto, apertar **I**, apertar **→** para ir a uma foto com GPS, clicar na legenda e digitar logo em seguida.
- **Correção:** no `.then`, só atualizar `.i-place` e o título, sem refazer o painel. Se precisar refazer, conferir `cur() === it` e não recriar a `textarea` quando `document.activeElement` for ela. Também vale ignorar atalhos de uma letra quando `e.target` estiver dentro de `.v-info`.

### 2. Alto: um listener de `resize` acumula a cada abertura e prende o DOM antigo
- **Onde:** `viewer.js:410` (dentro de `bindGestures`, chamado em toda abertura).
- **O que acontece:** cada `openViewer` registra mais um `addEventListener('resize', ...)` na `window`, e nenhum é removido. Ao redimensionar, cada um chama `fit` e `renderStrip` (que recria 37 `<img>`). A closure pertence ao mesmo escopo dos handlers que usam `stage`, então cada viewer fechado continua preso na memória: `.v-stage`, slides e imagens grandes.
- **Medido:** `win:resize` foi de 1 para 21 depois de abrir e fechar 20 vezes, e para 24 no fim da sessão.
- **Reproduzir:** abrir e fechar qualquer foto várias vezes e depois redimensionar a janela.
- **Correção:** guardar o handler em `V.onResize`, registrar em `openViewer` e remover em `closeNow`, como já é feito com o `keydown`. Ou registrar uma única vez no nível do módulo.

### 3. Alto: foto aberta pelo Explorador, fora da biblioteca, fica num "limbo" ao favoritar, ocultar ou apagar
- **Onde:** `app.js:526-533` (`openFromPath` usa itens que não estão em `S.all`/`S.byId`), `viewer.js:433-436` (`del`), `viewer.js:475` (Ocultar), `store.js:131` e `store.js:393`.
- **O que acontece:** **F** e **Delete** gravam `favorites[id]` e `deleted[id]` no estado, e aparece o aviso "Movido para Apagados Recentemente". Só que o item não está em `S.all`, então não aparece em Apagados, Favoritos ou Ocultos. O `purgeOld` filtra por `S.byId.has(id)`, então o arquivo **nunca** vai para a Lixeira. O estado guarda ids órfãos para sempre. Se a pasta for adicionada à biblioteca depois, a foto já aparece apagada ou oculta.
- **Medido:** simulei com `openViewer` usando itens `fora0..2`. Depois de **F** e **Delete**, o estado ficou com `{"fav":{"fora1":1},"del":{"fora1":...}}`, e `SETS.deleted.get()` e `SETS.favorites.get()` não continham o item.
- **Reproduzir (nativo):** dar duplo clique numa foto de `Downloads` (fora das pastas da biblioteca), apertar **Delete** e confirmar, depois abrir Apagados Recentemente.
- **Correção:** marcar esses itens (por exemplo `it.external = true`). No visualizador, para externos, "Apagar" deve chamar direto `api.trash` com confirmação ("vai para a Lixeira do Windows"), e Favoritar/Ocultar/Álbum devem ficar desativados com uma explicação. Outra opção é importar o item para a biblioteca ou incluí-lo em `S.all`/`S.byId` antes de permitir essas ações.

### 4. Médio: clique simples com zoom desfaz o zoom só na tela, e o estado interno continua com zoom
- **Onde:** `viewer.js:413-418` (`toggleChrome` chama `fit` sem zerar `V.scale/x/y`) e `viewer.js:381`.
- **O que acontece:** com zoom, um clique esconde a interface e `fit` devolve a mídia ao tamanho de ajuste, mas `V.scale` continua 2,6 e a classe `.zoomed` (cursor de mão) continua. O primeiro **Esc** "tira um zoom" que não aparece. Ao arrastar, a foto **pula** de volta para um zoom ainda maior, porque a base do modo imersivo é maior.
- **Medido:** depois do duplo clique, a mídia tinha 2357×1768. Depois do clique simples, 1200×900 com `.zoomed` ainda ativo. Arrastando 20 px, foi para 3120×2340.
- **Correção:** em `toggleChrome`, manter o zoom (recalcular `_base` e chamar `apply()` com o `scale` atual, que é o que o iOS faz) ou zerá-lo de vez (`V.scale=1; V.x=V.y=0; apply(true)`). As duas coisas no meio do caminho é que não podem ficar.

### 5. Médio: duplo clique pisca a interface (esconde e mostra) antes do zoom
- **Onde:** `viewer.js:340-344` e `viewer.js:380-381`.
- **O que acontece:** os dois `pointerup` sem movimento chamam `toggleChrome()` duas vezes. A barra some e volta, e `fit` anima a foto duas vezes enquanto o `zoomAt` mede o retângulo no meio da transição.
- **Medido:** 3 mudanças de classe no `.viewer` num único duplo clique (`immersive` liga, desliga, e `zoomed` liga).
- **Correção:** atrasar o toque simples em cerca de 250 ms e cancelar se vier um `dblclick`, como o reconhecedor de toque do iOS. Ou tratar o duplo clique no `pointerup` comparando com o tempo do toque anterior.

### 6. Médio: clicar no vídeo não reproduz nem pausa, só esconde a interface
- **Onde:** `viewer.js:350` (`stage.setPointerCapture`) e `viewer.js:269` (o `click` do `<video>`), além de `viewer.js:381`.
- **O que acontece:** com a captura do ponteiro no `stage`, o `pointerup` e o `click` saem com alvo no `stage`, não no `<video>`. O listener de clique do vídeo nunca dispara, e `e.target.closest('video')` em `end` dá `null`, então o clique alterna a interface.
- **Medido:** clicando no vídeo, a contagem de `play()` continuou em 5 e `immersive` foi de false para true.
- **Correção:** no `pointerdown`, guardar `p.onVideo = !!e.target.closest('video')`. No `end`, se `!p.moved && p.onVideo`, alternar play/pause (e decidir se a interface também alterna). Remover o `click` do `<video>`.

### 7. Médio: Delete num item de Apagados Recentemente "apaga de novo" e zera o prazo de 30 dias
- **Onde:** `viewer.js:586` (`Delete` chama `del()`), `viewer.js:476` (Apagar no menu "…") e `viewer.js:433`.
- **O que acontece:** para item já apagado, os botões da tela estão certos (Recuperar/Apagar, chamando `deleteNow`), mas a tecla **Delete** e o "Apagar" do menu chamam `deleteItems`. Aparece o diálogo errado ("ficarão em Apagados Recentemente por 30 dias"), o `deleted[id]` ganha um timestamp novo (o prazo recomeça) e o item sai da lista.
- **Medido:** `deleted` passou de `{"d2534":…309247}` para `{"d2534":…312862}`.
- **Correção:** em `del()`, `if (isDeleted(it)) return deleteNow(it)`. O menu "…" de um item apagado também deveria mostrar só Recuperar e Apagar Agora (hoje oferece Ocultar, Papel de Parede, Adicionar ao Álbum e outros).

### 8. Médio: um único gesto de trackpad pula várias fotos
- **Onde:** `viewer.js:319-333`.
- **O que acontece:** o acumulador `wheelNav` continua somando durante o `navLock` (320 ms). Quando a trava libera, já passou de 50 e dispara outro `step`. A inércia do trackpad do Windows gera eventos por cerca de 1 s, então um único gesto avança 3 a 6 fotos. O acumulador também nunca se esvazia: rolagens pequenas e espaçadas acabam navegando.
- **Medido:** 40 eventos de 15 px em cerca de 0,7 s avançaram **6 fotos**.
- **Correção:** zerar `wheelNav` enquanto `Date.now() < navLock` e depois de 150 a 200 ms sem eventos. Para trackpad (deltas pequenos e contínuos), exigir uma pausa entre gestos antes de navegar de novo.

### 9. Médio: navegar rápido acumula slides e baixa todas as fotos em resolução cheia
- **Onde:** `viewer.js:158-196` e `viewer.js:120-137`, `215-218`.
- **O que acontece:** cada `show()` cria um slide novo com `img.hi` em resolução cheia e só remove o antigo 430 ms depois. Segurar **→** deixa dezenas de slides vivos e dispara o download e a decodificação de todas as fotos puladas, sem cancelar. Os `preload` em ±1 somam mais.
- **Medido:** depois de 25 setas rápidas, 26 `.v-slide` no DOM e 24 `img.hi` carregando. Em 0,8 s voltou a 1.
- **Correção:** remover na hora os slides além do anterior imediato. Atrasar o `hi.src` em cerca de 150 ms (cancelando se a foto mudar) e limpar `hi.src` nos slides descartados para abortar o pedido.

### 10. Médio: com janela estreita, o painel de informações esmaga a foto
- **Onde:** `viewer.js:148` (`aw = W - 380`) e `viewer.css:72-78` (painel de 360 px fixos), com `tauri.conf.json` em `minWidth: 360`.
- **O que acontece:** com 420 px de largura, a foto ficou com **40×71 px** atrás do painel. Com 360 px, `aw` fica negativo, e largura e altura negativas são ignoradas pelo CSS, mantendo um tamanho velho.
- **Correção:** abaixo de cerca de 760 px, abrir o painel como folha que sobe de baixo, por cima da foto (como no iPhone), sem descontar 380 px. Usar `Math.max(0, …)` em `fit`.

### 11. Médio: música da Apresentação continua tocando no pause e dá erro ao fechar duas vezes
- **Onde:** `memories.js:98-101` (`music?.pause()`/`resume()`), `memories.js:110` (`music2`) e `memories.js:114-121`, `200-205`.
- **O que acontece:** (a) se a apresentação começou sem música e a pessoa ligou a música depois (`music2`), o botão Pausar não pausa a música, porque só `music` é suspenso. (b) Depois de desligar a música, Pausar/Continuar chama `suspend`/`resume` num `AudioContext` já fechado, o que gera promessa rejeitada sem tratamento. (c) Clicar duas vezes em Fechar (ou Fechar enquanto o fade de 450 ms roda) chama `stop()` duas vezes.
- **Medido:** `pageerror: Cannot close a closed AudioContext.` ao clicar duas vezes em Fechar.
- **Correção:** usar uma única variável `music` (trocar a referência ao religar), fazer `close()` idempotente (`if (closed) return`) e proteger `ctx.close()`, `suspend()` e `resume()` com `.catch(() => {})` e checagem de `ctx.state`.

### 12. Baixo: Esc não fecha o menu "…" e as setas não navegam nele
- **Onde:** `viewer.js:577` (o `onKey` sai cedo quando existe `.menu`) e `ui.js:20-51` (o `menu` não tem tratamento de teclado).
- **O que acontece:** com o menu "…" aberto, **Esc** não faz nada, **↓** não muda o item focado e **Enter** não ativa nada. O menu só fecha com o mouse. Medido: o menu continuou aberto depois de Esc e de ↓+Enter.
- **Correção:** em `ui.menu`, registrar um `keydown` (Esc fecha, ↑/↓ movem o foco entre `.mi`, Enter ativa) e focar o primeiro item ao abrir.

### 13. Baixo: setas durante a animação de fechar trocam a foto
- **Onde:** `viewer.js:31-64` (o `keydown` só é removido em `closeNow`, 400 ms depois).
- **Medido:** Esc e, 100 ms depois, → mudaram o título de 03:39 para 04:52 durante o fechamento. A animação de volta ao quadrado fica com a foto errada.
- **Correção:** em `closeViewer`, remover o listener de teclado na hora (ou ignorar teclas quando `V.el.classList.contains('closing')`) e evitar chamar `closeViewer` duas vezes.

### 14. Baixo: `play()` sem `.catch` gera erros não tratados
- **Onde:** `viewer.js:249`, `253`, `269`, `587`.
- **Medido:** `pageerror: The element has no supported sources.` duas vezes. Vídeo com erro de formato e play pelo botão ou pelo Espaço gera rejeição sem tratamento.
- **Correção:** usar `video.play().catch(() => {})` em todos os pontos (a linha 212 já faz isso).

### 15. Baixo: acessibilidade do visualizador
- **Medido:** **22 de 33** botões do visualizador sem nome acessível (as miniaturas da tira, os controles de vídeo, o fechar do painel). As 37 `<img>` da tira estão sem `alt`. O `.viewer` não tem `role="dialog"` nem `aria-modal`.
- **Também:** o foco não entra no visualizador ao abrir nem volta ao quadrado ao fechar. As setas `.v-nav` ficam com `opacity: 0` mesmo focadas pelo Tab (`viewer.css:49-51` não tem `:focus-visible`). **Esc** dentro da legenda não sai do campo (medido). **Espaço** com foco num botão alterna a interface em vez de acionar o botão (`viewer.js:587`).
- **Correção:** `role="dialog" aria-modal="true" aria-label="Visualizador"`. Adicionar `aria-label` nos botões só com ícone (Reproduzir/Pausar, Som, Fechar informações, e "Foto N de M" na tira). Usar `.v-nav:focus-visible { opacity: 1 }`. Focar o botão Voltar ao abrir e devolver o foco ao quadrado ao fechar. Esc na legenda deve tirar o foco do campo. No Espaço, não interceptar quando `e.target` for um `button`.

### 16. Baixo: servidor de teste ignora a porta
- `tools/serve.py:8` ignora a porta passada (fica sempre em 5310). `python tools/serve.py src 5412` não sobe na 5412. Correção: `int(sys.argv[2]) if len(sys.argv) > 2 else 5310`.

---

## B. Confirmados por leitura do código (precisam do app nativo ou de vídeo real)

### 17. Médio: a Apresentação aberta pelo "…" não para o vídeo
- **Onde:** `viewer.js:468`.
- **O que acontece:** "Apresentação" chama `playMemory` sem `stopVideo()`. O vídeo continua tocando por baixo, com o som misturado à trilha da apresentação. O `onKey` do visualizador fica inativo (existe `.memory`), então não dá para pausá-lo pelo teclado.
- **Correção:** chamar `stopVideo()` antes de `playMemory`.

### 18. Baixo: atalhos ignoram Ctrl, Alt e Meta
- **Onde:** `viewer.js:576-593`.
- **O que acontece:** **Ctrl+F** favorita a foto (a pessoa queria buscar), **Ctrl+E** abre o editor, **Ctrl+Shift+I** alterna o painel, **Alt+←** navega. **Ctrl+C** não copia a foto (no Fotos do Mac copia).
- **Correção:** `if (e.ctrlKey || e.altKey || e.metaKey)` só aceitar Ctrl+`+`/`-`/`0` (zoom) e Ctrl+C (copiar), deixando o resto passar.

### 19. Baixo: "Apagar agora" sem tratamento de erro
- **Onde:** `viewer.js:105-115` (`deleteNow`).
- **O que acontece:** se `api.trash` falhar (arquivo em uso, sem permissão), a promessa é rejeitada sem tratamento. O diálogo fecha e nada acontece, sem nenhum aviso. Em `app.js:361-375`, `deleteForever` tem `try/catch` com alerta.
- **Correção:** copiar o `try/catch` de `deleteForever`.

### 20. Baixo: depois de Editar ou Reverter, zoom e textos ficam velhos
- **Onde:** `viewer.js:452-459` e `480-490`.
- **O que acontece:** o slide é trocado, mas `V.scale/x/y` e a classe `.zoomed` não são zerados (mesmo problema do achado 4). O painel de informações (dimensões, MP depois de recortar), o título e as ações (`revert` não chama `renderActions`) não são atualizados. O vídeo editado não volta a tocar.
- **Correção:** criar um helper `replaceSlide(it)` que zera o zoom e chama `renderActions`, `renderStrip` e, se o painel estiver aberto, `renderInfo`.

### 21. Baixo: a animação do painel de informações é anulada
- **Onde:** `viewer.js:519-521`.
- **O que acontece:** a `transition` de .45s definida na linha 520 é sobrescrita na hora por `apply(false)`, que define `transition: none`. A foto muda de tamanho de uma vez enquanto o painel desliza por .55s.
- **Correção:** zerar o zoom antes e chamar `apply(true)` (ou não chamar `apply`).

### 22. Baixo: navegação dá a volta do fim para o começo
- **Onde:** `viewer.js:161` (`(index + len) % len`).
- **O que acontece:** na última foto, → (ou deslizar) vai para a primeira, e na primeira, ← vai para a última. O Fotos do iOS para nas pontas com efeito elástico. A tira de miniaturas pula de uma ponta à outra.
- **Correção:** em `step`, limitar a `0..len-1` e fazer um "bounce" visual nas pontas.

### 23. Baixo: "Reexibir" no álbum Ocultos não tira a foto da lista
- **Onde:** `viewer.js:475`.
- **O que acontece:** dentro de Ocultos, Reexibir deixa a foto na lista do visualizador, o que é incoerente com Ocultar, que remove.
- **Correção:** remover da lista quando o item deixa de pertencer à coleção aberta (passar um predicado `belongs(it)` ao abrir).

### 24. Baixo: textos e diferenças em relação ao Fotos do iOS 26/27
- "Abrir no Player" (`viewer.js:265`) mistura inglês. Melhor "Abrir com o App Padrão", como no menu.
- O erro de "Copiar" mostra `e.message` cru do navegador, em inglês (`viewer.js:509`).
- O título do botão "Favoritar (F)" não muda para "Desfavoritar" e o botão de informações não tem estado visual: `viewer.css:46` (`.v-actions .gbtn.on .ic[class] { color: inherit }`) anula o realce `.on`.
- "Editar" aparece duas vezes: em texto no topo (`viewer.js:73`) e como ícone embaixo (`viewer.js:101`). No iOS 18 e depois, fica só o ícone de ajustes na barra de baixo.
- Faltam: deslizar para cima para abrir as informações (`viewer.js:364` trata para cima como `'none'`), ver a foto vizinha durante o arrasto lateral e animar de volta ao quadrado quando fecha com zoom (`viewer.js:46` cai no fade).

---

## C. Suspeitas (não reproduzidas)

### S1. Médio: corrida entre "abrir pelo Explorador" e editor ou diálogo aberto
`viewer.js:436` e `viewer.js:452-459`. Se chegar um `open-file` (`app.js:1040`) enquanto o editor ou o diálogo de apagar estão abertos, `openViewer` troca `V`. Ao terminar: (a) o callback do editor faz `V.cur.replaceWith(slide(it))` no viewer **novo**, mostrando a foto editada A com o título e o índice da foto B; (b) `afterRemoval()` usa `cur()` do viewer novo e tira **outro item** da lista. Correção: guardar `const v = V` no início e sair se `V !== v`. `afterRemoval(it)` deve receber o item.

### S2. Médio: tela sensível ao toque (pinça com dois dedos)
`viewer.js:347-351`. Só existe zoom com Ctrl+roda (pinça de trackpad). Em notebooks com tela touch, o segundo dedo sobrescreve `p` e o gesto vira um arrasto ou deslize errado (`touch-action: none` também bloqueia o zoom do navegador). Sugestão: rastrear os ponteiros num `Map` e calcular a escala pela distância entre os dois.

### S3. Baixo/Médio: zoom máximo muito alto
`viewer.js:295`. O zoom máximo é `max(4, it.w/b.w * 8)`, ou seja, 8× além do 1:1. Num panorama de 6000 px o elemento passa de 40.000 px de largura, o que pesa na GPU e na memória. Para HEIC, TIFF e RAW, o `foto://` entrega um JPEG de 2560 px (`main.rs:239-244`), então o zoom passa a borrar bem antes do limite. Sugestão: limitar a cerca de 2 a 3× da resolução real servida.

### S4. Baixo: `img.hi` sem `onerror`
`viewer.js:133`. Se a foto cheia falhar, a tela fica na miniatura de 720 px sem aviso, e o zoom amplia a miniatura borrada.

### S5. Baixo: custo do `resize`
`viewer.js:410`. O `resize` refaz a tira inteira (37 `<img>`) a cada evento enquanto a janela é arrastada, multiplicado pelos listeners do achado 2. Sugestão: `requestAnimationFrame` ou debounce.

### S6. Baixo: menu de contexto padrão do WebView2
Não há `contextmenu` no visualizador, então o botão direito na foto deve abrir o menu padrão do WebView2 (Voltar/Recarregar/Salvar imagem). No Fotos, o botão direito é o mesmo menu "…".

### S7. Baixo: dois mapas Leaflet por foto
`viewer.js:203`. Quando o lugar está guardado como `''` (busca que falhou), `resolvePlace` resolve na hora e o `.then` chama `renderInfo()` de novo. Cada troca de foto com o painel aberto cria dois mapas Leaflet.

### S8. Baixo: a tira de miniaturas pula em vez de deslizar
`viewer.js:226-245`. A tira é recriada inteira a cada foto (janela de ±18), então o `translateX` em transição não corresponde ao conteúdo novo.

### S9. Fora desta frente
No fim da sessão, os listeners de `pointerup` na `window` foram de 5 para 12 e os de `pointermove` de 1 para 3, ao trocar de tela. Provavelmente vem de `grid.js:296`, que registra na `window` a cada grade criada. Vale a frente da grade conferir.

---

## Resumo: 10 achados mais graves
1. Alto: o painel de informações se refaz sozinho e rouba o foco da legenda, e as letras viram atalhos (E/F/Delete). `viewer.js:203`, `viewer.js:524-529`
2. Alto: listener de `resize` acumula a cada abertura (21 depois de 20) e prende o DOM antigo. `viewer.js:410`
3. Alto: foto aberta pelo Explorador, fora da biblioteca, fica em "limbo" ao favoritar, ocultar ou apagar e nunca vai para a Lixeira. `app.js:526-533`, `viewer.js:433-436`
4. Médio: clique simples com zoom desfaz o zoom só na tela, e o próximo arrasto pula para zoom maior. `viewer.js:413-418`
5. Médio: clicar no vídeo não reproduz nem pausa (captura do ponteiro), só esconde a interface. `viewer.js:350`, `viewer.js:269`
6. Médio: Delete em Apagados Recentemente apaga de novo e zera o prazo de 30 dias. `viewer.js:586`, `viewer.js:433`
7. Médio: um gesto de trackpad pula 6 fotos. `viewer.js:319-333`
8. Médio: navegar rápido acumula 26 slides e baixa todas as fotos em resolução cheia. `viewer.js:158-196`
9. Médio: a Apresentação aberta pelo visualizador não para o vídeo, e a música dá erro ou não pausa. `viewer.js:468`, `memories.js:98-121`
10. Médio: janela estreita com painel de informações deixa a foto com 40×71 px. `viewer.js:148`, `viewer.css:72`

---

## Correções (03/11)

Arquivos alterados: `src/js/viewer.js`, `src/css/viewer.css` (só visualizador e painel) e `src/js/memories.js`. Conferido com Playwright em `http.server 5422` (modo demonstração) antes e depois; `node --check` nos dois JS.

1. **Corrigido.** O `.then` do `resolvePlace` só troca o título e o `.i-place` (sem refazer o painel); `renderInfo` reaproveita a legenda focada e devolve o cursor. Medido: "Legenda de teste" salva, foco ficou na `textarea`, editor não abriu (antes abria).
2. **Corrigido.** `resize` registrado em `openViewer` e removido em `closeNow`, com `requestAnimationFrame`. Medido: 0 listeners a mais e 0 visualizadores vivos depois de 20 aberturas + `gc()` (antes 20 e 20).
3. **Parcialmente.** No viewer, item fora de `S.byId` (ou com `it.external`) tem Favoritar desativado, sem Ocultar/Álbum, e Apagar vai direto para a Lixeira com aviso próprio. Falta `app.js` marcar `external` em `openFromPath` (não podia editar).
4. **Corrigido.** Clique simples com zoom mantém o zoom: recalcula a base, `clamp()` e `apply(true)`. Arrastar não pula mais.
5. **Corrigido.** Toque simples espera 260 ms e é cancelado pelo segundo toque. Medido: 1 mudança de classe no duplo clique (antes 3).
6. **Corrigido.** `pointerdown` guarda `onVideo` antes da captura; o `pointerup` sem movimento toca/pausa. O `click` do `<video>` saiu.
7. **Corrigido.** `del()` em item apagado chama `deleteNow`; o menu "…" de item apagado mostra só Recuperar, Mostrar no Explorador e Apagar Agora. O prazo de 30 dias não é mais zerado.
8. **Corrigido.** O gesto termina depois de 180 ms sem eventos. Rolagem suave (trackpad) navega uma vez por gesto, e a roda do mouse (passos de 100) navega por passo, com trava de 320 ms. Medido: 40×15 px = 1 foto (antes 5 ou 6); 3 passos do mouse = 3 fotos.
9. **Corrigido.** Slides além do que está saindo são descartados na hora (`discard` cancela a `img.hi`). A foto cheia espera 150 ms ao deslizar, e a pré-carga das vizinhas espera 300 ms. Medido: 2 slides e 0 `img.hi` carregando depois de 25 setas (antes 26 e 24).
10. **Corrigido.** Abaixo de 760 px, o painel vira folha por cima da foto (`@media` + `sheetMode()`), e `fit` usa `Math.max(0, …)`. Medido: foto 360×360 com o painel aberto em 360 px.
11. **Corrigido.** `memories.js` usa uma variável `music` só (religada pausada fica suspensa), `close()` é idempotente, e `suspend`/`resume`/`close` conferem `ctx.state` e têm `.catch`. Sem `pageerror` ao fechar duas vezes.
12. **Corrigido.** O teclado do menu já existe em `ui.js` (outro desenvolvedor). O viewer só foca o primeiro item ao abrir o "…" e não disputa as teclas. Medido: Esc fecha só o menu.
13. **Corrigido.** `closeViewer` tira o `keydown` na hora e ignora uma segunda chamada (`v.closing`).
14. **Corrigido.** Todo `play()` passa por `playV()` com `.catch`.
15. **Corrigido, exceto o foco no quadrado.** Agora há `role="dialog"`, `aria-modal`, `aria-label` em todos os botões só com ícone (0 de 36 sem nome), `alt` nas imagens, `.v-nav:focus-visible`, foco no visualizador ao abrir, Esc na legenda saindo do campo e Espaço respeitando o botão focado. Ao fechar, o foco volta ao elemento que estava focado antes, e não ao quadrado (a grade não expõe o elemento do quadrado).
16. **Não corrigido.** `tools/serve.py` está fora dos arquivos desta frente.
17. **Corrigido.** "Apresentação" chama `stopVideo()`, e `playMemory` pausa qualquer `<video>` da página ao abrir.
18. **Corrigido.** Com Alt nada é tratado. Com Ctrl/Meta, só valem `+`/`-`/`0` (zoom) e Ctrl+C (copiar foto); o resto segue adiante.
19. **Corrigido.** `deleteNow` tem `try/catch` com alerta e trata `trash` que devolve 0 como erro.
20. **Corrigido.** O novo `replaceSlide(it)` zera o zoom e refaz ações, tira e painel. O vídeo editado volta a tocar.
21. **Corrigido.** `toggleInfo` zera o zoom e usa `apply(true)`.
22. **Corrigido.** Não dá mais a volta nas pontas: empurrão elástico, resistência no arrasto, e as setas ‹ › somem na primeira e na última foto.
23. **Corrigido.** Se o visualizador abriu com todos os itens ocultos (álbum Ocultos), Reexibir tira a foto da lista.
24. **Parcialmente.** "Abrir com o App Padrão", erro de copiar em português, título Favoritar/Desfavoritar, fundo no botão de informações ativo (`aria-pressed`) e deslizar para cima para abrir as informações foram feitos. Não feitos: tirar o "Editar" duplicado do topo (decisão de produto), mostrar a foto vizinha durante o arrasto e animar o fechamento com zoom.
- **S1. Corrigido no viewer.** `del`/`deleteNow`/`edit`/`revert`/Ocultar guardam `const v = V`, e `afterRemoval(it, v)` recebe o item e não mexe num visualizador aberto depois.
- **S2. Não corrigido.** A pinça com dois dedos em tela touch exige reescrever o rastreio de ponteiros; não dá para testar aqui.
- **S3. Corrigido.** O zoom máximo caiu para 3× a resolução real (mínimo 4×).
- **S4. Corrigido.** `img.hi` tem `onerror`: o zoom fica limitado a 2× sobre a miniatura.
- **S5. Corrigido.** O `resize` passa por `requestAnimationFrame`.
- **S6. Corrigido.** O botão direito na foto abre o menu "…".
- **S7. Corrigido.** Junto com o 1: o painel não é mais refeito quando o lugar chega.
- **S8. Não corrigido.** Fazer a tira deslizar exige reaproveitar os botões em vez de recriá-los; é refatoração, e o efeito é só visual.
- **S9. Não corrigido.** Fica com a frente da grade (`grid.js`).
