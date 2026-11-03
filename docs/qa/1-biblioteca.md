# QA 1 — Biblioteca e navegação

Escopo: grade virtual (`src/js/grid.js`), Anos/Meses/Todas, Coleções, álbuns, busca, seleção, menus de contexto, barra lateral, Fixados, Apagados/Ocultos, zoom, atalhos e layouts phone/tablet/desktop.

Como foi testado:
- Revisão de `app.js`, `grid.js`, `store.js`, `ui.js`, `util.js`, `api.js`, `motion.js`, `app.css` e `index.html`.
- Testes no modo demonstração com Playwright (Chromium headless) em http://127.0.0.1:5411: 1400×900, 800×1000 e 375×812, tema claro e escuro. As imagens do picsum e as respostas do Nominatim foram simuladas, para o teste não depender da rede. O código do app não foi alterado.
- Os listeners de `window` e os `setInterval` foram contados com um script injetado na página.
- O console não mostrou erros no fluxo normal. O único erro (`TypeError`) aparece no achado 8.

Observação de ferramenta: `tools/serve.py` ignora o argumento de porta (linha 8 fixa `5310`). Para usar a 5411, rodei uma cópia do script que respeita a porta.

---

## Bugs confirmados

### 1. Alto — Delete/Backspace em "Apagados Recentemente" apaga de novo e reinicia o prazo de 30 dias
- **Onde:** `src/js/app.js:977` (atalho) → `deleteItems` em `app.js:352-358` → `softDelete` em `store.js:362-366`
- **O que acontece:** em Apagados Recentemente, a tecla Delete chama `deleteItems`, que é a exclusão "suave" da biblioteca. O diálogo mostra o texto errado ("Os itens ficarão em Apagados Recentemente por 30 dias…" e o botão "Apagar Foto"). Ao confirmar, `S.data.deleted[id] = Date.now()` grava a data de agora e o item volta a ter 30 dias.
- **Reproduzir:** apague uma foto, deixe a data dela 20 dias no passado, abra Apagados (o selo mostra "10 dias"), toque em Selecionar, escolha a foto, aperte Delete e confirme. O selo passa a mostrar **"30 dias"** (reproduzido).
- **Correção:** no atalho, quando `R.route.view === 'set' && R.route.key === 'deleted'`, chamar `deleteForever([...R.sel])`, como já faz a barra de seleção dessa tela.

### 2. Alto — A busca não se atualiza depois de apagar, ocultar ou remover itens
- **Onde:** `src/js/app.js:995` e `app.js:1006`. A lista de telas atualizadas no `onChange` não inclui `search`, e a linha 1006 exclui `search` de propósito.
- **O que acontece:** quando um resultado é apagado ou ocultado pelo menu de contexto (ou pela barra de seleção), a foto continua na grade e a contagem ("2.483 itens para…") fica igual.
- **Reproduzir:** busque "jpg", clique com o botão direito no 1º resultado, escolha Apagar e confirme. O item `d0` continua sendo o 1º da grade e a contagem não muda (reproduzido).
- **Correção:** no `onChange`, para `r.view === 'search'`, fazer `R.grid.setItems(search(r.q))` e atualizar o texto do `.page-head p`, ou chamar `renderView(scrollTop)`.

### 3. Alto — No iPhone/iPad (phone/tablet) o campo de busca some ao digitar a 1ª letra
- **Onde:** `src/js/app.js:550` (`go({view:'search'})`) + `app.js:98` (`go` tira `side-open`)
- **O que acontece:** no layout compacto, a busca fica dentro da barra lateral, que abre por cima da tela. Na 1ª letra (depois de 180 ms), `go()` fecha a barra. O foco continua no input escondido: a pessoa segue digitando sem ver o que escreve e não consegue apagar nem corrigir o texto.
- **Reproduzir:** em 375 px ou 800 px, toque na bolinha de busca e digite "2024". Depois disso `body.side-open` vale `false` e `activeElement` continua `#search` (reproduzido; captura `phone-busca`).
- **Correção:** não fechar a barra quando a rota nova é `search` (`if (route.view !== 'search') document.body.classList.remove('side-open')`). Melhor ainda, como no iOS: pôr um campo de busca próprio no topo da tela de busca no layout compacto.

### 4. Alto — "Duplicados" mostra fotos Ocultas sem pedir desbloqueio
- **Onde:** `src/js/store.js:187` (`duplicates()` usa `live()`, que só tira os apagados) + `store.js:132`
- **O que acontece:** uma foto oculta que tenha cópia aparece em Utilidades › Duplicados, uma tela sem trava. A contagem da barra lateral também conta essas fotos. Isso vaza o conteúdo de Ocultos. Não reproduzi no demo, que não tem duplicados, mas o código não deixa dúvida.
- **Correção:** em `duplicates()`, usar `library()` no lugar de `live()`, ou filtrar `!isHidden(i)`.

### 5. Médio-alto — Cada grade deixa listeners presos em `window` (vazamento de memória)
- **Onde:** `src/js/grid.js:295-296` (adiciona `pointermove`/`pointerup` em `window`) e `grid.js:23-27` (`destroy()` não remove esses listeners)
- **O que acontece:** cada tela de grade cria um `VGrid` novo, e o listener mantém vivo o `VGrid` antigo: o array `items` (até 50 mil objetos) e o `pool` de tiles do DOM. Todos os `move` antigos continuam rodando a cada movimento do mouse.
- **Reproduzir:** alterne Biblioteca ↔ Coleções 10 vezes. Os listeners `pointermove` em `window` passam de **1 para 12** (medido).
- **Correção:** guardar `move`/`up` em `this` e chamar `removeEventListener` no `destroy()`. Também cancelar `drag.loop` ali.

### 6. Médio — `segmented()` vaza um listener `pointerup` e um `ResizeObserver` a cada `renderChrome`
- **Onde:** `src/js/ui.js:147-149`
- **O que acontece:** `renderChrome()` roda a cada navegação, a cada clique de seleção e a cada mudança de tamanho, e cada chamada cria 1 ou 2 controles segmentados. Cada controle adiciona `addEventListener('pointerup')` em `window` e um `ResizeObserver` que nunca são desfeitos. Os dois seguram o elemento já removido.
- **Reproduzir:** depois das mesmas 20 navegações, os listeners `pointerup` em `window` passam de **5 para 38** (medido).
- **Correção:** soltar o "press" com listeners no próprio elemento (`pointerup`, `pointerleave` e `pointercancel` em `el`, ou `setPointerCapture`). Para o `ResizeObserver`, desconectar quando `!el.isConnected`, ou criar o controle uma vez só e reaproveitá-lo.

### 7. Médio — Cartão de Ano/Mês clicado deixa um `setInterval` rodando para sempre
- **Onde:** `src/js/app.js:741-753` (`cycler`)
- **O que acontece:** o intervalo só é limpo no `mouseleave`. Quando o cartão é clicado, a tela troca e o cartão sai do DOM, e o `mouseleave` nunca dispara. O intervalo segue criando `<img>` de 720 px a cada 1,5 s: no app instalado isso gera miniaturas sem parar, e no demo, downloads.
- **Reproduzir:** em Anos, passe o mouse num cartão, clique nele e vá para Coleções. Em 6 s, sem nenhum `.ycard`/`.mcard` no DOM, **2 intervalos continuam disparando** (4 vezes cada), e houve pedidos de imagem 720 px parado em Coleções (medido).
- **Correção:** dentro do tick, `if (!card.isConnected) return clearInterval(timer)`. Também dá para limpar no `click` ou registrar a limpeza em `R.cleanup`.

### 8. Médio — Shift+clique depois que a lista encolhe dá `TypeError` e a seleção quebra
- **Onde:** `src/js/grid.js:232-234` (`lastClick` não é zerado em `setItems`, `grid.js:29-36`)
- **O que acontece:** `lastClick` guarda um índice da lista antiga. Se itens saem da grade (ocultar, apagar, remover do álbum) e a pessoa usa Shift+clique, o laço passa do fim da lista nova: `this.items[k].id` dá **"Cannot read properties of undefined (reading 'id')"**. O intervalo selecionado também fica errado, porque os índices mudaram.
- **Reproduzir:** toque em Selecionar, clique no último item, oculte outro pelo menu de contexto e dê Shift+clique em qualquer item. Aparece o erro no console (reproduzido).
- **Correção:** em `setItems`, guardar o *id* do último clique (não o índice) e recalcular o índice. Se o id não estiver mais na lista, zerar `lastClick`.

### 9. Médio — A seleção mantém itens que saíram da grade (risco de apagar o que não se vê)
- **Onde:** `src/js/app.js:720` (Ocultar no menu de contexto) e `app.js:714` (Remover do Álbum), que não chamam `endSelect`. Também `app.js:997-1003`: o `onChange` não filtra `R.sel`.
- **O que acontece:** em modo seleção com 3 itens marcados, Ocultar pelo menu de contexto tira os 3 da grade. A barra continua com "3 itens selecionados" e `R.sel` guarda os 3 ids. Se a pessoa marcar outros e apertar Apagar, os itens ocultos também vão para Apagados. "Selecionar Tudo"/"Desmarcar Tudo" também erra a contagem.
- **Reproduzir:** reproduzido: `{selecting: true, sel: 3, count: '3 itens selecionados', hidden: 3}`.
- **Correção:** no `onChange`, depois de `setItems`, apagar de `R.sel` os ids que não estão em `items` e redesenhar a barra. Também chamar `endSelect()` depois das ações do `tileMenu` que tiram itens da grade.

### 10. Médio — Botões de zoom invertidos
- **Onde:** `src/js/app.js:214-215`
- **O que acontece:** "Diminuir (Ctrl −)", com ícone de lupa "−", chama `zoom(-1)`, que **aumenta** as fotos (7 → 6 colunas). "Aumentar (Ctrl +)" faz o contrário (6 → 10 colunas em 2 cliques). Os atalhos Ctrl+= e Ctrl+- funcionam certo, então botão e atalho com o mesmo nome fazem coisas opostas.
- **Reproduzir:** medido: inicial 7 colunas, "Diminuir" → 6, "Aumentar" ×2 → 10.
- **Correção:** trocar os sinais: "Diminuir" → `zoom(1)`, "Aumentar" → `zoom(-1)`.

### 11. Médio — Coleções é redesenhada inteira a cada nome de lugar resolvido
- **Onde:** `src/js/store.js:427-428` (`resolvePlace` chama `save()` → `emit`) + `app.js:1006` (o `onChange` chama `renderView`) + `app.js:873/875` (`debouncedRefresh` redundante)
- **O que acontece:** o Nominatim responde cerca de 1 nome por segundo, e cada resposta reconstrói a página toda: as seções repetem a animação `rise`, as imagens são recriadas e as faixas horizontais voltam ao início. Com as Viagens e Memórias carregando nomes, a tela "pisca" por vários segundos e não dá para rolar as faixas.
- **Reproduzir:** limpe o estado, abra Coleções e role "Dias Recentes" para `scrollLeft = 300`. Depois de 6 s a seção original não está mais no DOM e o `scrollLeft` voltou a **2** (medido, com 6 pedidos ao Nominatim).
- **Correção:** gravar `places` sem disparar `emit` (por exemplo, `save({silent:true})` só com `persist()`). Na tela, trocar só os textos dos cartões, ou fazer uma única atualização no fim (manter só o `debouncedRefresh`).

### 12. Médio — O cabeçalho e o subtítulo da barra ficam com a contagem antiga
- **Onde:** `src/js/app.js:997-1003` (o `onChange` só atualiza `.grid-foot b`)
- **O que acontece:** em Favoritos, Vídeos, álbuns e outras telas com título, depois de tirar um item o cabeçalho continua com o número velho. A barra superior também (`.tb-title span`).
- **Reproduzir:** marque 3 favoritos, abra Favoritos e desfavorite 1 pelo menu. Resultado: `head: '3 Fotos'`, `foot: '2 Fotos'`, `tiles: 2`, `tbsub: '3 Fotos'` (reproduzido).
- **Correção:** guardar `sub` como função das `items` e atualizar `.grid-head p` e `setTitle(title, sub)` junto com o rodapé.

### 13. Médio — Barra de seleção estoura a tela no iPhone (375 px)
- **Onde:** `src/css/app.css:558-561` (`.selbar .count { min-width: 150px }`, 6 botões de 42 px)
- **O que acontece:** a barra vai de x = −4 até 379 numa tela de 375: os botões das pontas ficam cortados e "1 item selecionado" quebra em 2 linhas.
- **Reproduzir:** em 375×812, toque em Selecionar e escolha 1 foto (captura `phone-selecao`).
- **Correção:** em `html[data-size="phone"]`, usar `.selbar .count { min-width: 0; padding: 0 6px; font-size: 13px; white-space: nowrap }` e `.selbar .gbtn.round { width: 38px }`, ou levar Exportar/Álbum para o menu "Mais", como no iOS.

### 14. Médio — Esc não fecha o menu de contexto (e encerra a seleção por baixo dele)
- **Onde:** `src/js/ui.js:20-51` (o `menu()` não trata teclado)
- **O que acontece:** com um menu aberto, Esc não o fecha. Em modo seleção, o Esc chega ao atalho global e chama `endSelect()`, e o menu continua aberto agindo sobre ids que não estão mais selecionados. O menu também não aceita setas nem Enter.
- **Reproduzir:** clique com o botão direito numa foto e aperte Esc: `.menu` continua no DOM (reproduzido).
- **Correção:** no `menu()`, registrar um `keydown` em captura que fecha com Esc (`stopPropagation`) e navega com ↑/↓/Enter, e removê-lo em `closeMenu()`. Incluir `.menu` no guarda do atalho global (`app.js:968`).

### 15. Baixo-médio — No topo das telas com título, o subtítulo fica sozinho na barra superior
- **Onde:** `src/js/app.js:679-683` (só o `<b>` recebe `opacity`) e `app.js:689`
- **O que acontece:** em Vídeos aparece "188 Vídeos" pequeno no canto da barra, logo acima do cabeçalho grande "Vídeos / 188 Vídeos". O texto fica duplicado e solto.
- **Reproduzir:** abra Vídeos: `bOp: '0'`, `spanOp: '1'` (captura `d-videos`).
- **Correção:** aplicar a opacidade ao `.tb-title` inteiro, como no iOS, onde o título pequeno só aparece depois de o grande rolar para fora.

### 16. Baixo-médio — No iPhone, o rodapé da grade fica atrás da barra inferior
- **Onde:** `src/css/app.css:353` (`.grid-foot { padding-bottom: 110px }`). No phone a barra inferior tem 2 linhas (cerca de 130 px).
- **O que acontece:** no fim da Biblioteca, "2.483 Fotos, 188 Vídeos" fica coberto pelo controle Anos/Meses/Todas (captura `phone-library`).
- **Correção:** `html[data-size="phone"] .grid-foot { padding-bottom: 180px; }`, que é o mesmo valor do `.page`.

### 17. Baixo-médio — A barra de seleção "pula" a cada foto marcada
- **Onde:** `src/js/app.js:312-318` (`onSel` → `renderChrome()` recria `#bottom`) + `app.css:558` (`.selbar { animation: rise … }`)
- **O que acontece:** cada clique, e cada tile durante o arrasto, recria a barra inteira. A animação de entrada (deslize de 14 px) toca de novo e a bolha de hover do vidro some. No arrasto isso acontece dezenas de vezes por segundo.
- **Correção:** criar a `selbar` uma vez e só atualizar o texto da contagem e o estado `disabled` e de favorito dos botões.

### 18. Baixo — Ctrl+= / Ctrl+- mudam e gravam o zoom em telas sem grade
- **Onde:** `src/js/app.js:972-973` e `zoom()` em `app.js:273-278`
- **O que acontece:** em Coleções, Anos e Meses o atalho muda `settings.zoom` (medido: 4 → 3 em Coleções) e o `save()` redesenha a tela à toa. A próxima grade abre com outro tamanho sem a pessoa ter visto a mudança. No limite (0 ou 9), `save()` também roda sem nada mudar.
- **Correção:** `if (!R.grid) return;` no começo de `zoom()`, e só chamar `save()` se o valor mudou.

### 19. Baixo — Pasta da barra lateral inclui pastas "irmãs" com o mesmo começo
- **Onde:** `src/js/app.js:622-623` e `app.js:1016` (`norm(i.path).startsWith(p)`)
- **O que acontece:** a pasta `C:\Fotos` também mostra os arquivos de `C:\Fotos 2\…` e `C:\Fotos-antigas\…`.
- **Reproduzir:** o prefixo `C:\Users\Demo\Pic` (sem separador no fim) pegou os 2.675 itens (medido).
- **Correção:** normalizar com a barra no fim: `const p = norm(r.path.replace(/\\?$/, '\\'))`.

### 20. Baixo — A busca não ignora palavras de ligação
- **Onde:** `src/js/store.js:324-331`
- **O que acontece:** "fotos de 2024" traz **335** resultados e "fotos 2024" traz **580** (medido). O "de" vira um termo obrigatório e só casa com nomes que o contêm, como "dezembro" ou "Demo".
- **Correção:** tirar stopwords (`de, do, da, dos, das, em, no, na, e, com`) da lista de tokens.

### 21. Baixo — Vídeos em Apagados Recentemente não mostram os dias restantes
- **Onde:** `src/js/grid.js:134-138` (`if (it.video) … else if (this.badge)`)
- **O que acontece:** o selo de duração toma o lugar do selo "N dias".
- **Reproduzir:** apague um vídeo e abra Apagados: o tile mostra só "0:53" (reproduzido).
- **Correção:** desenhar o `badge` (dias) mesmo quando é vídeo. Ele já fica numa faixa própria (`.days`) embaixo.

### 22. Baixo — Ocultos/Apagados ficam desbloqueados até fechar o app
- **Onde:** `src/js/app.js:646`. `R.unlocked` nunca volta a `false`.
- **O que acontece:** depois de desbloquear uma vez, Ocultos e Apagados abrem direto pelo resto da sessão, mesmo minimizando o app ou o deixando aberto. O iOS tranca de novo quando o app vai para segundo plano.
- **Reproduzir:** verificado `R.unlocked === true` depois de sair da tela.
- **Correção:** voltar `R.unlocked = false` no `blur`/`visibilitychange` da janela, ou ao sair das rotas trancadas.

### 23. Baixo — Dois itens destacados ao mesmo tempo na barra lateral
- **Onde:** `src/js/app.js:115` (`navItem`)
- **O que acontece:** "Mapa" aparece em Fixados e em Coleções, e "Vídeos" em Fixados e em Tipos de Mídia, e os dois recebem `.active`. A bolha (`motion.js`) vai para o primeiro, mas ao recolher a seção Fixados ela pula para o segundo.
- **Reproduzir:** medido: `['Mapa','Mapa']` e `['Vídeos','Vídeos188']`.
- **Correção:** marcar como ativo só o primeiro item que bate com a rota (por exemplo, guardar uma flag durante o `renderNav`).

### 24. Baixo — Ctrl+A alterna: na 2ª vez desmarca tudo
- **Onde:** `src/js/app.js:974` → `selectAll` (`app.js:305-311`)
- **O que acontece:** a 1ª vez seleciona 2.674 itens e a 2ª deixa 0 (medido). No Windows e no macOS, Ctrl+A sempre seleciona tudo.
- **Correção:** no atalho, sempre adicionar todos os itens e deixar o comportamento de alternar só no botão "Selecionar Tudo"/"Desmarcar Tudo".

### 25. Baixo — Textos e plurais em português
- `app.js:769` "`${ys.length} anos`" → "1 anos"; o mesmo vale para `app.js:792` "meses", `app.js:917` "memórias", `app.js:927` "viagens" e `app.js:602` "grupos de cópias". Usar um `plural(n, 'ano', 'anos')`.
- `app.js:345` o toast "Reexibido" fica no singular para qualquer quantidade ("3 itens reexibidos").
- `app.js:354` o botão diz "Apagar Foto" mesmo quando o item é um vídeo. O iOS usa "Apagar Vídeo" / "Apagar N Itens".
- `app.js:358` o toast diz "movidos para Apagados", mas o nome da coleção é "Apagados Recentemente".
- `app.js:640-641` a tela trancada diz "ver este álbum" e "Ver Álbum" para Ocultos e para Apagados Recentemente, que não são álbuns. O iOS usa "Ver Álbum" só em Ocultos. Sugestão: "Usar Windows Hello para ver" com o botão "Ver".
- `app.js:325` "1 item selecionado". O iOS usa "1 Foto Selecionada" / "3 Itens Selecionados".

### 26. Baixo — A grade da busca ignora "Proporção Original"
- **Onde:** `src/js/app.js:946-949` (o `VGrid` da busca é criado sem `aspect`)
- **Correção:** passar `aspect: S.data.settings.aspect` e chamar `g.setAspect(...)`, como faz o `gridView`.

### 27. Baixo — Sair da busca sempre leva à Biblioteca, e o texto fica no campo
- **Onde:** `src/js/app.js:551`, `app.js:554` e `go()` (`app.js:93-101`)
- **O que acontece:** quem estava num álbum, buscou e apertou Esc cai em Biblioteca › Todas, e não volta ao álbum. Se a pessoa sai da busca pela barra lateral, o termo continua escrito no campo.
- **Correção:** guardar a rota anterior ao entrar na busca e voltar a ela. Em `go()`, limpar `#search` quando a rota nova não é `search`.

### 28. Baixo — Voltar ao tamanho desktop sempre reabre a barra lateral
- **Onde:** `src/js/app.js:81`
- **O que acontece:** se a pessoa ocultou a barra no desktop, a estreitar a janela até tablet e a alargar de novo, a barra reaparece.
- **Correção:** guardar a preferência (`settings.sideOff`) e aplicá-la quando o tamanho for desktop.

---

## Suspeitas (não reproduzidas ou dependentes do app instalado)

### S1. Médio — Cada `save()` desmonta e remonta todos os tiles e pode piscar as miniaturas
- **Onde:** `src/js/app.js:998` (`R.grid.setItems`) → `grid.js:29-36`, mais `release`/`pool.pop()`
- **Raciocínio:** recolher uma seção da barra, favoritar ou dar zoom chama `save()`, e o `onChange` chama `setItems` sempre. O `pool` é LIFO, então cada `<img>` reaproveitado recebe outra `src`, perde a classe `.ok` (opacity 0) e faz o fade outra vez. No demo as imagens simuladas carregam na hora e não vi o efeito (0 sem `.ok` depois de 60 ms). No app, com `thumb.localhost`, a grade visível pode piscar inteira.
- **Sugestão:** quando `items` tiver o mesmo tamanho e os mesmos ids, só chamar `refresh` dos selos. Ao reconstruir, preferir reaproveitar o tile que já estava no mesmo índice.

### S2. Baixo-médio — Rolagem pode "andar" um pouco ao abrir a grade e ao redimensionar
- **Onde:** `src/js/grid.js:17-18` (`ResizeObserver` no scroller) + `app.js:954-958` (`ResizeObserver` no host)
- **Raciocínio:** são dois observadores. Um recalcula a largura com as colunas antigas e restaura a âncora, e o outro troca as colunas e restaura de novo. Na 1ª renderização, a barra de rolagem de 11 px aparece depois de `layout()`, então os tiles nascem 11 px largos demais e são corrigidos no quadro seguinte.
- **Sugestão:** um único observador que calcula as colunas e o layout juntos.

### S3. Baixo — Arrasto para selecionar não trata `pointercancel` nem `lostpointercapture`
- **Onde:** `src/js/grid.js:291-296`
- **Raciocínio:** se o `pointerup` se perder (alerta do sistema, Alt+Tab no meio do arrasto, toque), `drag` continua ativo e o laço de `requestAnimationFrame` roda sem parar. Os próximos movimentos sem botão apertado continuam selecionando.
- **Sugestão:** usar `host.setPointerCapture(e.pointerId)` e tratar `pointercancel`/`lostpointercapture` como `up`.

### S4. Baixo — Sem navegação por teclado na grade
- **Onde:** `src/js/grid.js` (a classe `.tile.focus` existe no CSS, mas nunca é usada)
- **Raciocínio:** no Fotos do Mac/iPad, as setas movem o foco, Espaço/Enter abre e Shift+setas estende a seleção. Os tiles aqui são `div` sem `tabindex`, `role` ou `alt`, o que também é um problema de acessibilidade.

### S5. Baixo — Diferenças em relação ao Fotos do iOS 26/27
- **Apagar em álbum:** a lixeira da barra de seleção (`app.js:337`) apaga da biblioteca. O iOS pergunta "Remover do Álbum" ou "Apagar". Remover do álbum só está em "Mais".
- **Recuperar Tudo:** `app.js:250` não pede confirmação; o iOS pede.
- **Aba Biblioteca:** tocar nela (`app.js:229`) volta sempre a "Todas" e perde o modo Anos/Meses.
- **Utilidades:** "Importações 0" e "Duplicados 0" aparecem mesmo vazios. O iOS esconde as utilidades vazias.

### S6. Baixo — Custo do `renderNav` em bibliotecas grandes
- **Onde:** `src/js/app.js:155-156` + `store.js:50` (`cache.clear()` em todo `save`)
- **Raciocínio:** cada `save()` refaz `library()`, os 6 tipos de mídia, `duplicates()` e `featured()` só para as contagens da barra lateral. Com 50 mil itens, cada favorito ou recolhimento de seção pode custar dezenas de ms. Não medi, porque o demo tem cerca de 2,7 mil itens.

### S7. Baixo — Ctrl+= dentro do campo de busca cai no zoom da WebView
- **Onde:** `src/js/app.js:971` (o `return` de `typing` vem antes do `preventDefault` do zoom)
- **Raciocínio:** com o foco no campo de busca, Ctrl+= / Ctrl+- dão zoom na página inteira da WebView2.

---

## Capturas de tela

Ficam em `docs/qa/capturas/`: `1-d-videos.png` (achado 15), `1-phone-selecao.png` (13), `1-phone-busca.png` (3), `1-phone-library.png` (16), `1-tablet-colecoes.png` e `1-d-meses-escuro.png`. O tema escuro não mostrou problemas de contraste nas telas de Biblioteca, Meses e Coleções.

---

## Correções (03/11)

Arquivos: `app.js`, `grid.js`, `store.js`, `ui.js`, `util.js`, `app.css` e `tools/serve.py`. Conferido no modo demonstração (http://127.0.0.1:5421) com Playwright: 1400/800/375 px, tema claro e escuro, sem erros no console. Depois de 20 navegações Biblioteca ↔ Coleções mais 7 cliques de seleção, os listeners de `window` e os `ResizeObserver` ficaram iguais aos do início.

1. **Corrigido.** Delete/Backspace (e a lixeira do visualizador) sobre itens que já estão em Apagados não reiniciam mais o prazo. Aparece "Cancelar / Recuperar / Apagar Agora".
2. **Corrigido.** O `onChange` também atualiza a busca: grade, "N itens para…", rodapé e seleção. Sem resultados, a tela é refeita.
3. **Corrigido.** `go()` não fecha a barra lateral quando a rota é `search`. No phone/tablet, Enter fecha a barra para mostrar os resultados. Não foi feito o campo próprio no topo, como no iOS.
4. **Corrigido.** `duplicates()` usa `library()`, então ocultos não aparecem. Não dá para reproduzir no demo, que não tem duplicados.
5. **Corrigido.** `VGrid.destroy()` remove os listeners de `window` (`unbind`) e para o laço do arrasto.
6. **Corrigido.** O "press" do `segmented()` fica no próprio elemento. Há um `ResizeObserver` único, que solta os controles que saíram do DOM.
7. **Corrigido.** O `cycler` para quando o cartão sai do DOM, no clique e no `R.cleanup`. Medido: 0 intervalos ativos em Coleções.
8. **Corrigido.** `lastClick` guarda o id e recalcula o índice. Shift+clique depois de ocultar não dá erro.
9. **Corrigido.** `pruneSelection()` tira de `R.sel` o que saiu da grade e atualiza a barra.
10. **Corrigido.** Os botões foram trocados. "Diminuir" leva de 7 para 10 colunas e "Aumentar" volta.
11. **Corrigido.** `resolvePlace` grava com `saveQuiet()`, sem `emit`. As telas trocam só o título dos cartões (`data-geo`). A faixa de Coleções continua no DOM e no mesmo lugar.
12. **Corrigido.** `sub` é uma função da lista. Cabeçalho, subtítulo da barra e rodapé são atualizados juntos.
13. **Corrigido.** No phone, a contagem não tem `min-width`, não quebra linha e os botões têm 38 px. A barra ocupa de x=15 a 359 em 375 px.
14. **Corrigido.** O `menu()` trata Esc (fecha só o menu), ↑/↓/Home/End e Enter, e segura as demais teclas. O atalho global ignora quando há `.menu`.
15. **Corrigido.** A opacidade vale para o `.tb-title` inteiro (`tbFade`) e sobrevive ao `renderChrome`.
16. **Corrigido.** `html[data-size="phone"] .grid-foot { padding-bottom: 180px }`.
17. **Corrigido.** A `selbar` é criada uma vez. Cada clique só atualiza a contagem, o `disabled`, o favorito e "Selecionar/Desmarcar Tudo".
18. **Corrigido.** `zoom()` não faz nada sem grade nem no limite. Grava com `saveQuiet()`, sem redesenhar.
19. **Corrigido.** `folderItems()` compara com o separador no fim.
20. **Corrigido.** Stopwords saem da busca. "fotos de 2024" e "fotos 2024" trazem 580 resultados cada.
21. **Corrigido.** O selo de dias aparece também em vídeos.
22. **Corrigido.** A trava volta ao sair de Ocultos/Apagados e quando a janela fica oculta (`visibilitychange`). Não usa `blur`, porque o próprio diálogo do Hello tira o foco.
23. **Corrigido.** Só o primeiro item que bate com a rota fica `.active`.
24. **Corrigido.** Ctrl+A sempre seleciona tudo. O botão continua alternando.
25. **Corrigido.** `plural()` em `util.js`: anos, meses, memórias, viagens, grupos e dias. Toasts de reexibir, ocultar e recuperar. "Apagar Vídeo"/"Apagar Foto"/"Apagar N Itens". "Apagados Recentemente" nos toasts. Tela trancada: "Ver Álbum" só em Ocultos ("Ver" em Apagados). Contagem como no iOS ("1 Foto Selecionada", "3 Itens Selecionados").
26. **Corrigido.** A grade da busca usa `aspect`.
27. **Corrigido.** Esc ou campo vazio volta à rota anterior à busca. `go()` limpa o campo quando a rota não é `search`.
28. **Corrigido.** `settings.sideOff` guarda a barra ocultada no desktop e é aplicado no início e ao voltar ao tamanho desktop.
- S1. **Parcialmente.** `setItems` com a mesma lista e `refresh()` atualizam os tiles no lugar, sem trocar `src`. Recolher seção, zoom e nomes de lugares não emitem mais. Quando a lista muda de fato, a grade ainda é reconstruída.
- S2. **Não corrigido.** Unificar os dois `ResizeObserver` mexe na âncora da rolagem. O risco é maior que o ganho sem o app instalado para medir.
- S3. **Corrigido.** `pointercancel` e `blur` encerram o arrasto. Não usei `setPointerCapture`, porque desvia o `click`.
- S4. **Não corrigido.** Navegação por teclado e ARIA na grade são uma funcionalidade nova (foco, `tabindex`, Shift+setas), fora do escopo de correção.
- S5. **Corrigido.** A lixeira num álbum pergunta "Remover do Álbum / Apagar". "Recuperar Tudo" confirma. A aba Biblioteca volta ao último modo. Importações e Duplicados vazios ficam escondidos.
- S6. **Não corrigido.** É otimização de cache por chave em `store.js`. Não medi com 50 mil itens.
- S7. **Corrigido.** Ctrl+= e Ctrl+- sempre têm `preventDefault`, inclusive com o foco no campo de busca.
- `tools/serve.py`: **corrigido**, `python tools/serve.py <pasta> [porta]` (padrão 5310).
- Pedidos de outros colegas no `app.js`: o `unlock` libera só em `ok`/`not_configured` (mais `unavailable` apenas fora do app, no demo). Em `error`/`busy`/`policy` mostra um aviso, e em `cancel` fica calado. `api.openPath` foi trocado por `openFolder` (pasta da barra lateral) e `openUrl` (link DevLumo), com recuo `api.openFolder?.(p) ?? api.openPath?.(p)`.
