# QA 3 — Editor (foto e vídeo)

- Alvo: `src/js/editor.js` (771 linhas, gravado em 03/11/2026 13:01, sem mudanças durante o teste), `src/css/viewer.css` (seção do editor), `save_render_raw`/`save_render`/`delete_render` em `src-tauri/src/main.rs`.
- Teste automatizado: Playwright (Chromium, WebGL por SwiftShader), servidor estático em `http://127.0.0.1:5413` (modo demonstração, fotos do picsum). `api.saveRender`/`api.deleteRender` interceptados para ler o JPEG gerado.
- Vídeo: revisado só por leitura (o modo demonstração não tem vídeo real; abrir um "vídeo" demo cai no `onerror` e fecha o editor, como esperado).
- Capturas em `docs/qa/capturas/3-editor-*.png`.
- Nada em `src/` ou `src-tauri/` foi alterado.

Legenda: **[T]** = reproduzido no navegador; **[L]** = confirmado por leitura/cálculo (caminho de código inequívoco).

---

## Bugs confirmados

### 1. Caixa de corte fica no lugar errado depois de girar, trocar de aba ou redimensionar — ALTO [T]
- **Onde:** `editor.js:243-246` (`render` define `canvas.style.width/height` e chama `placeCrop()` no mesmo quadro), `editor.js:427-431` (`placeCrop` mede `getBoundingClientRect()` do canvas) + `viewer.css:112` (`.e-canvas { transition: width .3s, height .3s }`).
- **O que acontece:** o canvas anima o tamanho por 0,3 s; `placeCrop` mede o tamanho *antigo* e ninguém reposiciona a caixa quando a animação acaba. A caixa fica maior/menor que a foto, ou fora dela.
- **Reproduzir:** Cortar → 16:9 → Girar 90°: a foto vira retrato e a caixa continua 16:9 cobrindo o fundo preto (`3-editor-girar-16x9.png`). Ou: fazer um corte → Ajustar → voltar a Cortar (caixa com 375 px de largura num canvas de 1006 px). Ou redimensionar a janela em Cortar: canvas em x=122..879, caixa em x=392..1006 e y=64 (`3-editor-caixa-corte-deslocada.png`).
- **Correção:** chamar `placeCrop()` também em `canvas.addEventListener('transitionend', …)` (ou num `ResizeObserver` do próprio canvas), ou calcular a caixa a partir de `dw/dh` (tamanho final) em vez do retângulo medido.

### 2. Proporção travada não é respeitada ao arrastar alças — ALTO [T]
- **Onde:** `editor.js:455-465`.
- **O que acontece:** quando a dimensão derivada passa de 1, ela é cortada em 1 (`Math.min(1, …)`) mas a outra dimensão não é recalculada. Nas alças `n`/`s`, `w` satura em 1 e `hh` fica livre. Resultado: "Quadrado" vira 1,08:1, "9:16" vira 1,17:1, e o JPEG salvo sai com uma proporção que não existe na lista.
- **Reproduzir:** foto paisagem → Cortar → 9:16 → arrastar a alça direita até o fim: a razão vai de 0,56 para 1,17 (`3-editor-916-proporcao-quebrada.png`). Com Quadrado, arrastar o canto `se` para baixo e para a direita: 614×566. Num teste com 16:9 + girar + alça `s`, o arquivo salvo saiu com **1013×1651** e `aspect: "16:9"` gravado.
- **Correção:** depois de calcular `w`/`hh`, se um deles passar do limite disponível (`1 - x` ou `1 - y`, não só 1), reduzir esse lado e recalcular o outro pela razão. Fazer o mesmo cálculo para todas as alças, ancorando o lado oposto.

### 3. Girar com proporção travada inverte a proporção e mantém o rótulo antigo — MÉDIO [T]
- **Onde:** `editor.js:399-404`.
- **O que acontece:** `rotate()` troca `w↔h` do recorte normalizado. Em pixels, um 16:9 vira 9:16, mas `st.aspect` continua `'16:9'` e o chip continua aceso. Na próxima alça, `ratioOf('16:9')` tenta voltar a 16:9 e a caixa salta (somado ao bug 2, sai uma proporção qualquer).
- **Reproduzir:** Cortar → 16:9 → Girar 90° → mexer numa alça.
- **Correção:** ao girar, trocar a proporção pela inversa (`16:9`→`9:16`, `4:3`→`3:4`…), como no iOS, ou refazer `setAspect(st.aspect)` com o quadro já girado.

### 4. Com "Espelhar" ligado, "Girar" gira no sentido horário e o recorte vai para a região errada — MÉDIO [T]
- **Onde:** `editor.js:395` (espelhar), `editor.js:399-403` (girar), shader `editor.js:59-62` (o espelho é aplicado antes da rotação de 90°).
- **O que acontece:** sem espelho, o botão gira no sentido anti-horário (correto). Com espelho, a mesma soma `rot+3` vira rotação **horária** na tela, mas o recorte continua sendo transformado como anti-horário, então ele seleciona outra parte da foto.
- **Reproduzir (teste T10, lendo os cantos do canvas):** espelhado, TL=133 / TR=213 / BL=185 / BR=217. Depois de girar, TL=176 (≈BL antigo) e TR=135 (≈TL antigo), ou seja, sentido horário.
- **Correção:** se `st.flip`, usar `st.rot = (st.rot + 1) % 4` (ou aplicar o espelho depois da rotação no shader) e manter a transformação do recorte anti-horária.

### 5. "Espelhar" não espelha o recorte nem o endireitar — MÉDIO [L]
- **Onde:** `editor.js:395` (`st.flip = !st.flip; render()`), shader `editor.js:55-59`.
- **O que acontece:** (a) o recorte fica parado na tela enquanto a imagem vira por baixo. Quem cortou a metade esquerda passa a ver a metade direita da foto. (b) O ângulo de endireitar é aplicado antes do espelho, então um horizonte corrigido com +5° fica torto em −10° depois de espelhar.
- **Reproduzir:** cortar só a metade esquerda → Espelhar → Concluído. Ou endireitar o horizonte → Espelhar.
- **Correção:** no clique de espelhar, `st.crop[0] = 1 - st.crop[0] - st.crop[2]` e `st.angle = -st.angle`, e chamar `straight.upd()`.

### 6. Perda do contexto WebGL salva um JPEG todo preto — ALTO [T]
- **Onde:** não existe tratamento de `webglcontextlost`/`webglcontextrestored`. O salvamento fica em `editor.js:641-646`.
- **O que acontece:** se o contexto se perde (reset do driver, suspensão, muitas abas WebGL), a prévia fica preta e "Concluído" grava um JPEG preto, que passa a substituir a foto na grade e no visualizador.
- **Reproduzir:** com o editor aberto, `canvas.getContext('webgl').getExtension('WEBGL_lose_context').loseContext()` → Concluído. O arquivo salvo tem 1013×1800 com **todos os canais = 0**.
- **Correção:** antes de `toDataURL`, checar `gl.isContextLost()` e abortar com aviso. Tratar `webglcontextlost` (com `preventDefault`) e `webglcontextrestored` refazendo `glSetup` + textura.

### 7. Vazamento de memória: cada edição fica presa na memória inteira (incluindo a foto em resolução cheia) — ALTO [T]
- **Onde:** `editor.js:266` (`addEventListener('pointerup', …)` em `window`, nunca removido). Também `ui.js:147-149` (o `segmented` registra `pointerup` global e um `ResizeObserver` que nunca é desligado).
- **O que acontece:** a função anônima do `pointerup` mantém vivo o escopo inteiro de `openEditor`: `srcEl` (o canvas 2D com a foto em até 8192×8192, ~256 MB), o canvas WebGL, o `<video>`, `st` etc.
- **Reproduzir:** abrir e fechar (Esc) o editor 4 vezes, forçar o GC e contar `HTMLCanvasElement` por CDP: **0 → 8 canvas presos** (1800×1013, 1350×1800, … mais os de exibição). Com fotos reais de 48 MP, são ~200 MB por edição.
- **Correção:** guardar a função e chamar `removeEventListener('pointerup', fn)` em `close()`, ou usar um `AbortController` para todos os listeners globais. No `segmented`, idem, mais `ro.disconnect()`. Em `close()`, também zerar `srcEl = null` e `c2.width = 0`.

### 8. Enter repetido reexecuta "Concluído" (duas gravações; no vídeo, duas exportações simultâneas) — ALTO [T foto / L vídeo]
- **Onde:** `editor.js:604` (Enter chama `finish()` direto) e `editor.js:624-627` (`doneBtn.disabled` não protege contra o teclado).
- **O que acontece:** foto: dois `saveRender` e `onDone` chamado 2 vezes (medido). Vídeo: a 2ª `exportVideo` cria outra caixa, chama `video.pause()` e `video.currentTime = a` no **mesmo** `<video>` da 1ª exportação (a gravação volta ao início e duplica trechos). Com som, `createMediaElementSource` lança `InvalidStateError` e deixa uma segunda caixa "Preparando…" presa na tela.
- **Reproduzir:** mexer em algo e apertar Enter duas vezes rápido.
- **Correção:** uma flag `busy` no início de `finish()` (`if (busy) return; busy = true`), e ignorar Enter/Espaço enquanto `exporting`.

### 9. Exportação de vídeo: a interface continua clicável e altera o arquivo no meio da gravação — ALTO [L]
- **Onde:** `.e-export` (`viewer.css:224`) é só uma caixa no centro, não um bloqueio. `setTab` (`editor.js:569-578`) → `buildFilters()` (`editor.js:365-385`) chama `draw(150, ~84)`. O Auto (`editor.js:341`) chama `draw(64,64)`. Reverter, Girar, Espelhar e as réguas mexem em `st`.
- **O que acontece:** durante a gravação, clicar em "Filtros" redimensiona o canvas gravado para 150 px e troca o filtro temporariamente. Girar ou Reverter muda a imagem a partir daquele ponto, e o `st` salvo em `edits` fica diferente do que foi gravado. Espaço (`editor.js:602`) pausa o vídeo e deixa um congelamento na gravação (o vigia retoma em até 0,5 s).
- **Reproduzir (leitura):** Concluído num vídeo editado → durante "Salvando vídeo", clicar em Filtros ou em Girar.
- **Correção:** um véu modal cobrindo `.editor` durante a exportação (ou `el.inert = true` com exceção da caixa). `draw()`/`buildFilters()` devem sair se `exporting`, e o atalho de Espaço deve ser ignorado.

### 10. O laço de prévia continua ativo durante a exportação e pode fazer o vídeo voltar ao início — ALTO [L]
- **Onde:** `onFrame` em `editor.js:554-561` (`if (!video.paused && video.currentTime >= b) video.currentTime = a`) contra o `tick` da exportação em `editor.js:725` (termina quando `currentTime >= b - 0.02`).
- **O que acontece:** os dois callbacks de `requestVideoFrameCallback` rodam no mesmo quadro, e `onFrame` roda primeiro (foi registrado antes). Se um quadro cai em `≥ b` sem ter passado por `[b-0.02, b)` (a 30 fps, os quadros andam 33 ms, então isso acontece em ~40% das vezes quando o fim foi aparado), `onFrame` volta para `a` antes de `tick` ver o fim. A gravação recomeça e o vídeo salvo sai com o trecho repetido, uma ou mais vezes.
- **Reproduzir (leitura):** aparar o fim de um vídeo 30 fps → Concluído. Repetir algumas vezes e comparar a duração do arquivo com o trecho.
- **Correção:** em `onFrame`, `if (exporting) { requestVideoFrameCallback(onFrame); return; }`. Na exportação, comparar com `metadata.mediaTime` do callback e terminar quando passar de `b`.

### 11. Repetir a exportação depois de cancelar (ou depois de um erro) quebra o editor — ALTO [L]
- **Onde:** `editor.js:686-694` e `editor.js:746-749`.
- **O que acontece:** `actx.createMediaElementSource(video)` só pode ser chamado **uma vez** por elemento. No 2º "Concluído" com som, ele lança `InvalidStateError` sem `catch`. Fica `exporting = true` (o `render()` nunca mais desenha), a caixa "Preparando…" fica na tela e o vídeo pausado. Além disso: depois de um "problema", o código faz `actx.close()` e a prévia fica **sem som** para sempre (o elemento continua ligado ao contexto fechado). Depois de cancelar, o `AudioContext` nunca é fechado, nem no `close()`.
- **Reproduzir:** vídeo com som → Concluído → Cancelar na caixa → Concluído de novo.
- **Correção:** criar `actx`/`srcNode`/`dest` uma única vez (preguiçosamente) e reaproveitar. Durante a exportação, desligar `srcNode` de `actx.destination` e ligar no `dest`. Depois, voltar. Fechar o `actx` em `close()`. Envolver `exportVideo` num `try/finally` que restaure `exporting=false`, remova a caixa e reabilite o botão.

### 12. Vídeo já editado nunca volta ao original por "Reverter" + "Concluído" — MÉDIO [L]
- **Onde:** `editor.js:135-136` (`st = {...blank(), ...prev}` e `delete st.v`, mas **`ext` continua**), `editor.js:625` (comparação com `blank()`), `editor.js:768` (grava `ext`).
- **O que acontece:** como `st.ext` existe, `clean` nunca é verdadeiro num vídeo que já foi salvo. Reverter + Concluído **reexporta o vídeo inteiro** em tempo real, com perda de qualidade e sem som se a reprodução foi bloqueada, em vez de apagar a cópia.
- **Reproduzir:** editar e salvar um vídeo → abrir de novo → Reverter → Concluído.
- **Correção:** `delete st.ext` junto com `st.v` (guardar o `ext` à parte), ou comparar só as chaves de `blank()`.

### 13. Exportação sem verificar o resultado: arquivo vazio, falha do MediaRecorder, "som" mudo — ALTO [L]
- **Onde:** `editor.js:695-702` (sem `rec.onerror`), `editor.js:757-761` (salva `new Blob(chunks)` sem checar tamanho) e `editor.js:711-714`.
- **O que acontece:** se o encoder falhar (ex.: `avc1.640028` é H.264 nível 4.0, que vai até ~1080p. Uma saída de 3840×2160 passa desse nível), o MediaRecorder para, `onstop` dispara, `chunks` fica vazio e o app grava um **MP4 de 0 bytes** como a versão editada. Ele aparece quebrado no visualizador e "Revertido" só pelo menu. Se o `play()` com som for recusado, o código grava mudo sem avisar, mesmo com o som ligado.
- **Correção:** tratar `rec.onerror` como problema. Recusar `bytes.length < 1024`. Escolher o nível pelo tamanho (`avc1.640033` para 4K, ou deixar só `video/mp4`). Avisar "salvo sem som" no fallback mudo.

### 14. Editor abre como tela preta vazia, sem indicador nem saída, durante o carregamento — MÉDIO [T]
- **Onde:** `editor.js:139-144` (o `div.editor` vazio entra no `body`; `stage`, com o spinner, só entra em `el` na linha 589). O Esc só é registrado na linha 606.
- **O que acontece:** foto grande, HEIC (convertida pelo Shell) ou vídeo pesado deixam uma tela preta em z-index 140 sem spinner (`loading` nunca aparece: medido, `stageInEditor: false`, `children: 0`). Se o `<video>` não disparar nem `loadeddata` nem `error` (arquivo travado), a tela preta fica **para sempre**, e as teclas do visualizador também estão bloqueadas porque `.editor` existe.
- **Correção:** fazer `el.append(stage)` antes dos `await` e mostrar um botão Cancelar e o Esc já no carregamento. Pôr um tempo limite (ex.: 15 s) no carregamento do vídeo.

### 15. Sem WebGL o editor trava a tela inteira — MÉDIO [L]
- **Onde:** `editor.js:101-103` e `147`.
- **O que acontece:** `getContext('webgl')` pode devolver `null` (GPU na lista de bloqueio, driver ruim, limite de contextos). `glSetup` lança `TypeError`, mas o `div.editor` preto já está no `body` e nunca é removido. O app fica coberto até recarregar.
- **Correção:** `if (!gl) { el.remove(); toast('Não foi possível iniciar o editor (WebGL indisponível)'); return; }`, mais um `try/catch` em volta do setup.

### 16. "Auto" apaga os ajustes manuais e não os devolve ao desligar — MÉDIO [T]
- **Onde:** `editor.js:324-331`, `editor.js:339-358`.
- **O que acontece:** com Exposição = 30, ligar Auto põe −6. Desligar põe **0** (o 30 do usuário se perde). O mesmo vale para contraste, sombras, realces, vibração e brilho intenso.
- **Correção:** guardar os valores antes de ligar o Auto e restaurá-los ao desligar. Ou fazer o Auto como camada separada, somada aos ajustes.

### 17. "Reverter" (barra superior) deixa a interface de vídeo dessincronizada — BAIXO [L]
- **Onde:** `editor.js:255` com `syncAll` (`editor.js:579-587`).
- **O que acontece:** `blank()` zera `trim` e `mute`, mas `video.muted`, o ícone do som (`paintMute`) e a faixa (`paintTrim`) não são atualizados. Com o vídeo pausado, a faixa continua mostrando o corte antigo, e a prévia continua muda ou com som ao contrário do estado real.
- **Correção:** em `syncAll`, chamar `paintTrim()`, `paintMute()` e `video.muted = st.mute` (expor essas funções fora do `if (isVideo)`).

### 18. Nitidez tem metade da régua sem efeito (`POSITIVE` declarado e nunca usado) — BAIXO [L]
- **Onde:** `editor.js:28` (`POSITIVE` sem uso) e `editor.js:308` (a régua é sempre −100..100), shader `editor.js:71-72` (`if (sh > 0.)`).
- **O que acontece:** de −100 a 0 a Nitidez não faz nada, mas marca o botão como alterado e gera uma cópia salva. A Vinheta negativa clareia as bordas (pode ser intencional).
- **Correção:** usar `POSITIVE` para criar a régua com `min = 0` nessas ferramentas (`ruler(…, POSITIVE.has(tool) ? 0 : -100, 100)`, recriando ou ajustando o mínimo em `pickTool`).

### 19. Textura limitada a 8192 px: a cópia salva perde resolução — BAIXO [L]
- **Onde:** `editor.js:183-186`, `641-644`.
- **O que acontece:** panoramas maiores que 8192 px (e qualquer imagem maior que `MAX_TEXTURE_SIZE`) são reduzidos e a cópia editada sai menor que o original, sem aviso. Também não há conferência de que `gl.drawingBufferWidth/Height` é igual a `w/hh` (o Chromium reduz o buffer em silêncio quando não consegue alocar), então um JPEG grande pode sair menor ou cortado.
- **Correção:** avisar ou renderizar em blocos. Pelo menos conferir `gl.drawingBufferWidth === w` antes do `toDataURL`.

### 20. Cancelar/Esc durante o "Gravando o arquivo…" ou o salvamento da foto não cancela — BAIXO [L]
- **Onde:** `editor.js:620-623` contra `editor.js:624-656` e `757-768`.
- **O que acontece:** no fim da exportação, `exporting` já é `false`. Esc abre "Descartar alterações?", o usuário confirma e o editor fecha, mas a gravação continua. `S.data.edits` é salvo, `close()` roda de novo e `onDone` também. Com o botão X durante a exportação de vídeo, o editor fecha, o `<video>` perde o `src` e o vigia termina 4 s depois com o toast "O vídeo parou de tocar…" já fora do editor.
- **Correção:** durante `finish()` em andamento, desabilitar o X e o Esc (ou fazer o Esc virar "cancelar exportação" até o fim).

### 21. Vazamentos menores ao fechar — BAIXO [L]
- `editor.js:684`: as faixas de `canvas.captureStream()` e de `dest.stream` nunca recebem `.stop()`.
- `editor.js:537-552`: o segundo `<video>` da faixa de quadros continua buscando se o editor for fechado no meio. `onloadeddata` sem `onerror` deixa a promessa pendurada para sempre. No fim falta `fv.load()` depois de `removeAttribute('src')`.
- `editor.js:608-619`: `cancelAnimationFrame(raf)` não é chamado. `loseContext()` roda antes do fade-out, e o canvas some (fica preto) durante os 300 ms de saída.
- **Correção:** parar as faixas, abortar a faixa de quadros com uma flag `closed`, chamar `cancelAnimationFrame`, e perder o contexto só no `setTimeout` que remove o `el`.

### 22. Trecho de vídeo: laço só funciona com o fim aparado; vídeos com menos de 0,5 s quebram — BAIXO [L]
- **Onde:** `editor.js:557` (o laço exige `!video.paused`, mas no fim natural o vídeo pausa sozinho) e `editor.js:525-526`.
- **O que acontece:** sem aparar o fim, "tocar" para no final em vez de repetir. Com `dur < 0.5`, `a = min(t, b-0.5)` fica negativo e `b = max(t, a+0.5)` passa da duração.
- **Correção:** tratar `ended` como laço (`video.currentTime = a; play()`) e limitar o trecho mínimo a `Math.min(0.5, dur)`.

### 23. "Redefinir" (Cortar) não desfaz Girar/Espelhar — BAIXO [L]
- **Onde:** `editor.js:397`.
- **O que acontece:** só zera o recorte, o ângulo e a proporção. No iOS, "Redefinir" volta toda a geometria.
- **Correção:** incluir `st.rot = 0; st.flip = false`.

### 24. `save_render_raw` apaga a cópia anterior antes de gravar a nova e roda no thread principal — BAIXO [L]
- **Onde:** `main.rs:413-420` e `main.rs:401-402`.
- **O que acontece:** (a) a capa nova é gravada antes. Se a gravação do vídeo falhar, a capa nova fica junto do vídeo antigo, que **já foi apagado** (linhas 417-419). `S.data.edits` mantém a versão antiga apontando para um arquivo que não existe mais. (b) Comando síncrono do Tauri: centenas de MB escritos no thread principal congelam a janela.
- **Correção:** gravar em `{id}.tmp` e depois renomear, só então apagar as outras extensões. Tornar o comando `async` (ou `spawn_blocking`).

---

## Suspeitas (não reproduzidas; precisam de vídeo real ou do app nativo)

### S1. Janela minimizada ou coberta durante a exportação gera vídeo travado — ALTO
- **Onde:** `editor.js:716-740`.
- O WebView2 marca a página como `hidden` quando a janela é minimizada ou totalmente coberta (oclusão). Aí `requestVideoFrameCallback`/`rAF` param e o `setInterval` vai para 1×/s (ou menos). O vídeo com som continua tocando, mas o canvas só é redesenhado pelo vigia, e o arquivo sai a ~1-2 fps. Como a exportação leva o tempo real do vídeo, é provável que o usuário troque de janela.
- **Sugestão:** ouvir `visibilitychange`: pausar e retomar (o MediaRecorder tem `pause()`/`resume()`) ou cancelar com aviso. A longo prazo, usar WebCodecs (`VideoDecoder`/`VideoEncoder`) offline, que não depende de tempo real.

### S2. `captureStream(30)` limita vídeos de 60 fps a 30 fps — BAIXO
- **Onde:** `editor.js:684`.
- Gravações de 60 fps saem com metade dos quadros. Sugestão: ler a taxa (por `getVideoPlaybackQuality` ou pelo intervalo do `mediaTime`) e usar `captureStream(0)` + `track.requestFrame()` a cada `draw`.

### S3. Vídeos de celular com rotação nos metadados (retrato) — MÉDIO
- **Onde:** `editor.js:168-169`, `199`.
- `videoWidth/videoHeight` vêm já girados, mas o `texImage2D` de um `<video>` ignorou a matriz de rotação em várias versões do Chromium. Testar com um MOV/MP4 retrato do iPhone: a prévia pode sair deitada ou esticada.

### S4. `dur` infinito ou zero — BAIXO
- **Onde:** `editor.js:474`, `505`, `546`.
- WebM sem duração no cabeçalho dá `duration = Infinity`. `fv.currentTime = Infinity` lança `TypeError` (promessa rejeitada sem tratamento), e `paintTrim` gera `NaN%`.
- **Sugestão:** `Number.isFinite(dur) && dur > 0`, senão desabilitar a aba Vídeo.

### S5. Duplo clique rápido em "Editar" abre dois editores — BAIXO
- **Onde:** `viewer.js:447-452`.
- `edit()` espera o `import()`. Dois cliques antes dele resolver chamam `openEditor` duas vezes. Sugestão: `if (document.querySelector('.editor')) return;` no início de `openEditor`.

### S6. A cópia JPEG perde EXIF (data/GPS/câmera) — BAIXO
- **Onde:** `editor.js:644`.
- `toDataURL` não carrega metadados. Se `export_items` exporta a versão editada, os metadados se perdem no arquivo exportado (verificar no Rust).

### S7. PNG com transparência fica preto — BAIXO
- **Onde:** `editor.js:199`, textura `RGB`.
- Áreas transparentes viram preto na cópia JPEG. Sugestão: pintar o `c2` de branco antes do `drawImage`.

### S8. Sem `pointercancel`/`lostpointercapture` — BAIXO
- **Onde:** régua `editor.js:286-295`, corte `433-470`, faixa `514-533`, comparar `259-271`.
- Se o ponteiro é cancelado (toque, troca de janela no meio do arraste), `d`/`cd`/`td`/`showOrig` ficam presos: o próximo movimento continua arrastando, ou o "ORIGINAL" fica na tela.

---

## O que funcionou (foto, modo demonstração)
- Régua de Ajustar (arrastar, ímã no 0, valor no anel do botão), filtros com miniaturas e intensidade.
- Concluído salva o JPEG nas dimensões do recorte. Reabrir restaura filtro, proporção e valores.
- Concluído sem mudanças fecha sem gravar. Esc com mudanças pede confirmação, e Esc no alerta só fecha o alerta.
- Reverter + Concluído (foto) apaga a edição e chama `deleteRender`.
- Endireitar a 40° não deixa bordas pretas no JPEG (o `zoomFor` está correto).
- Girar sem espelho: anti-horário e recorte transformado corretamente.
- Vídeo no modo demonstração: falha ao carregar, aviso e editor removido, sem travar.
- Nenhum erro de JavaScript no console durante os testes (só avisos de desempenho do `readPixels` no SwiftShader).

## Observação de ferramenta
- `tools/serve.py:8` ignora o argumento de porta: sempre usa 5310. O teste usou `python -m http.server 5413 --directory src`.

---

## Correções (03/11)

Só `src/js/editor.js` foi alterado, mais um `src/css/editor.css` novo (opcional: apaga os controles enquanto salva; precisa de `<link rel="stylesheet" href="css/editor.css" />` no `index.html`). Foto conferida no navegador (Playwright + SwiftShader, porta 5423); vídeo revisado só por leitura.

- **1. Caixa de corte fora do lugar** — corrigido: `placeCrop` usa o tamanho final do canvas (`disp`), não o medido no meio da transição; o arraste usa a mesma escala; `transitionend` reposiciona de reforço. Girar 16:9, voltar de Ajustar e redimensionar a janela: caixa = canvas ao pixel.
- **2. Proporção travada nas alças** — corrigido: um lado manda, o outro sai da razão, lado oposto ancorado e limite aplicado aos dois. O arquivo sai com a razão exata (múltiplo do par inteiro: Quadrado 1013×1013, 9:16 1017×1808).
- **3. Girar inverte a proporção e mantém o rótulo** — corrigido: o rótulo vira junto (16:9 → 9:16). Entraram os chips 2:3 e 4:5 para o 3:2 e o 5:4 terem inversa.
- **4. Espelhar + Girar no sentido errado** — corrigido: com espelho a rotação interna é a oposta; os cantos medidos confirmam o giro anti-horário.
- **5. Espelhar não espelha recorte nem endireitar** — corrigido: `crop.x = 1 - x - w` e `angle = -angle`.
- **6. Perda de contexto WebGL grava JPEG preto** — corrigido: `webglcontextlost` (com `preventDefault`) trava o Concluído e mostra "Recuperando o editor"; `webglcontextrestored` refaz programa e textura. Antes do `toDataURL`, `isContextLost()` e um pixel com alfa 255; senão nada é gravado. Testado: perda → 0 gravações; restauração → JPEG normal.
- **7. Vazamento de memória** — corrigido: listeners globais num `AbortController`; a `<video>`, a faixa de quadros e o `AudioContext` fecham no `close()`; a foto 2D é zerada. O callback do `segmented` passa por um gancho fora do escopo e o segmented é solto da árvore. Medido: 2 canvas presos por edição → 0. (O `pointerup`/`ResizeObserver` do próprio `ui.js` continuam lá, mas só seguram o segmented.)
- **8. Enter repetido grava duas vezes** — corrigido: flag `busy` em `finish()`; Enter/Espaço ignorados durante o salvamento; `e.repeat` ignorado. Testado: Enter 3× → 1 gravação, `onDone` 1×.
- **9. Interface clicável durante a exportação** — corrigido: `inert` no palco e nas barras durante o salvamento; `setTab`/`buildFilters`/Espaço bloqueados; Esc só cancela a exportação.
- **10. Laço da prévia volta o vídeo durante a exportação** — corrigido (leitura): `onFrame` não mexe no vídeo com `exporting`; o fim usa `metadata.mediaTime`.
- **11. Repetir a exportação quebra o editor** — corrigido (leitura): `createMediaElementSource` uma vez só por vídeo (nó reaproveitado, ligado à gravação e depois de volta às caixas); `try/finally` restaura tudo; `AudioContext` fecha no `close()`.
- **12. Reverter + Concluído reexporta o vídeo** — corrigido: `ext` sai do `st` ao abrir e "limpo" compara só as chaves de `blank()`; aí a cópia é apagada.
- **13. Exportação sem verificar o resultado** — corrigido (leitura): `rec.onerror`, arquivo com menos de 1 KB é recusado, nível do H.264 pelo tamanho (4.0 / 5.0 / 5.1 `avc1.640033`, saída limitada a 3840×2160 em pixels), aviso de "salvo sem som" quando cai na gravação muda.
- **14. Tela preta sem indicador nem saída** — corrigido: palco com indicador e botão X entram antes do carregamento; Esc sai; vídeo com limite de 20 s.
- **15. Sem WebGL trava a tela** — corrigido: `glSetup` devolve `null`/erro → editor removido com aviso.
- **16. Auto apaga os ajustes manuais** — corrigido: valores guardados em `st.autoBase` e devolvidos ao desligar (testado: 50 → Auto → 50). Mexer numa régua com Auto ligado encerra o Auto mantendo os valores.
- **17. Reverter dessincroniza a interface do vídeo** — corrigido: `syncAll` repinta faixa e som e acerta `video.muted`.
- **18. Nitidez com metade da régua sem efeito** — corrigido: régua 0..100 (`ruler.range`); valores negativos salvos viram 0. A vinheta continua −100..100 (negativa clareia as bordas, como no iOS).
- **19. Textura limitada a 8192 px** — parcialmente: confere `drawingBufferWidth/Height` e, se o Chromium reduziu, salva menor porém inteiro; avisa quando a cópia sai reduzida. Renderizar em blocos para passar de 8192 px fica para depois.
- **20. Cancelar/Esc durante a gravação** — corrigido: X, Esc e Reverter ignorados enquanto salva; na fase "Gravando o arquivo…" o Cancelar some.
- **21. Vazamentos menores** — corrigido: faixas paradas (`track.stop()`), faixa de quadros abortável e com `onerror`/`fv.load()`, `cancelAnimationFrame`, `loseContext` só depois do fade.
- **22. Laço sem fim aparado / vídeo < 0,5 s** — corrigido: `ended` volta ao início do trecho; trecho mínimo `min(0,5, dur)`.
- **23. Redefinir não desfaz Girar/Espelhar** — corrigido.
- **24. `save_render_raw` (Rust)** — não corrigido: fora do escopo (só `editor.js` podia ser alterado).
- **S1. Janela minimizada durante a exportação** — corrigido (leitura): `visibilitychange` pausa vídeo e gravação e retoma quando a janela volta.
- **S2. 60 fps viram 30** — não corrigido: trocar para `captureStream(0)` + `requestFrame()` sem poder testar vídeo real é arriscado.
- **S3. Vídeo retrato do iPhone** — não corrigido: precisa de arquivo real para reproduzir.
- **S4. Duração infinita ou zero** — corrigido: só aceita duração finita > 0; sem ela a faixa fica desligada e nada vira `NaN`.
- **S5. Duplo clique abre dois editores** — corrigido: `openEditor` sai se já existe um editor aberto.
- **S6. Cópia JPEG perde EXIF** — não corrigido: depende do Rust/exportação.
- **S7. PNG transparente fica preto** — corrigido: fundo branco antes do `drawImage`.
- **S8. Sem `pointercancel`** — corrigido: régua, corte, faixa e comparar tratam `pointercancel`/`lostpointercapture` (e `blur` no comparar).
- **Ferramenta (`tools/serve.py`)** — não corrigido: fora do escopo.
