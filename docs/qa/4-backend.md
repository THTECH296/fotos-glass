# QA 4 — Backend (src-tauri)

Revisão de `src-tauri/` do Fotos Glass, feita em 03/11/2026 sobre a cópia de trabalho da versão 1.1.3. O `main.rs` tem alterações ainda não commitadas (vídeo editado, `save_render_raw`, capa). As linhas citadas valem para o instantâneo das 13h05; ainda batiam às 13h20.

## O que foi rodado

- `cargo clippy --all-targets` (com `CARGO_TARGET_DIR=%LOCALAPPDATA%\fotos-qa-target`) compila sem erros. Só aparecem 3 avisos de estilo em `scan.rs:163`, `scan.rs:224` e `scan.rs:240` (`is_multiple_of`, closure redundante, lifetime explícito). Nenhum deles é bug.
- Crate de teste próprio em `%TEMP%\fotos-qa-tests`, com cópia literal de `date_from_name` e da conta de Range:
  - `bytes=500-100` → `start=500, end=100, n=18446744073709551217`, ou seja, estouro e alocação impossível (achado B1).
  - `bytes=-500` → serve os bytes 0–500 em vez dos 500 últimos (achado B9).
  - `bytes=0-` num arquivo de 0 bytes → resposta 206 com 1 byte inventado e `Content-Range: bytes 0-0/0`.
  - Datas pelo nome: 22 casos testados. `IMG_`, `VID_`, `PXL_`, WhatsApp, Screenshot, signal e "Captura de tela" saem certos. `DSC_2019`, `IMG_9999`, timestamp em ms e "Foto 2023" ficam sem data, como deveriam. 29/02 em ano não bissexto é recusado. Problema encontrado: `PXL_` usa UTC (achado B14).
- Registro do Windows consultado só para leitura. Hoje `HKCU\Software\Classes\Fotos.Imagem\shell\open\command` aponta para `C:\Users\thith\AppData\Local\fotos-build\release\fotos.exe`, uma pasta de build e não a instalação (achado B8).
- A lista de extensões de `hooks.nsh` foi conferida contra `PHOTO_EXT`/`VIDEO_EXT`: 63 + 15 nos dois lados, sem diferença.
- Nenhum arquivo do app foi alterado. O app também não foi aberto, porque abrir regravaria o registro.

---

## Bugs confirmados (pelo código e/ou por teste)

### B1 — ALTO — Range invertido derruba o app inteiro
`main.rs:255-257`
- **O que acontece:** com `Range: bytes=500-100`, `end - start + 1` estoura o `u64`. Em release o valor dá a volta (o teste acima mostra o número), `vec![0u8; ...]` entra em pânico com "capacity overflow" e, como `Cargo.toml` tem `panic = "abort"`, o processo inteiro morre. Em debug o pânico é na subtração.
- **Como provocar:** no console do WebView, `fetch('http://foto.localhost/<id-de-um-jpg>', {headers:{Range:'bytes=500-100'}})`. O `<video>` do Chromium não manda esse Range, então na prática é preciso JS. Ainda assim é um crash do processo vindo de um cabeçalho.
- **Correção:** validar antes de alocar. Se `len == 0`, ou `start >= len`, ou `end < start`, responder **416** com `Content-Range: bytes */len`. Tratar também o sufixo `-N` (ver B9).

### B2 — ALTO — `state.json` corrompido é tratado como "não existe" e é sobrescrito com o estado vazio
`main.rs:277-279` (e `store.js:66-71`)
- **O que acontece:** `load_state` devolve `Null` tanto quando o arquivo falta quanto quando o JSON está inválido. O frontend fica com `DEFAULT`, e o próximo `save()` grava por cima. Somem álbuns, favoritos, ocultos, legendas, edições e a marca dos apagados.
- **Como provocar:** truncar o `state.json` (ou escrever lixo nele) em `%LOCALAPPDATA%\br.com.fotos.app\` e abrir o app. Em produção isso acontece com queda de energia logo depois do `rename`: não há `FlushFileBuffers`, então o NTFS pode deixar o arquivo com o tamanho certo cheio de zeros. Também acontece quando o fallback de escrita direta (linha 304) é interrompido.
- **Correção:** (1) antes de cada `rename`, copiar o `state.json` válido para `state.bak.json` (ou manter N cópias rotativas). (2) Em `load_state`, se o parse falhar, tentar o `.bak`. Se também falhar, renomear o corrompido para `state.corrompido-<data>.json` e devolver um erro ou marcador para o frontend **não** gravar por cima sem avisar. (3) Chamar `File::sync_all()` no temporário antes do `rename`.

### B3 — ALTO — Fechar o app durante "Salvando vídeo" deixa a edição corrompida e já apagou a anterior
`main.rs:417-420`, `main.rs:395-396`, `main.rs:649-666`
- **O que acontece:** `save_render_raw` primeiro apaga `{id}.mp4/.webm/.jpg` e só depois grava o novo arquivo, com centenas de MB, direto no destino. O fechamento (`app.js:45-46`) espera só o `flushSave()`, e depois `RunEvent::Exit` chama `TerminateProcess`. Um fechamento no meio da gravação deixa um MP4/WebM truncado como "edição", com capa e `editV` apontando para ele. A edição anterior já foi apagada. `save_render` (foto) tem a mesma ordem apagar→gravar: se a gravação falhar (disco cheio), perde-se a edição antiga.
- **Como provocar:** editar um vídeo longo, clicar em Salvar e fechar a janela logo em seguida. Ou encher o disco e salvar uma edição de foto.
- **Correção:** gravar em `{id}.{ext}.tmp`, chamar `sync_all`, renomear para o nome final e só então remover as outras extensões. Manter um contador global de gravações em andamento (`AtomicUsize`) e, em `encerrar_agora`, esperar até ~10 s enquanto ele for > 0 antes de chamar `TerminateProcess`. Fazer o mesmo para `export_items`/`import_paths`, que também deixam cópias pela metade no destino do usuário.

### B4 — MÉDIO-ALTO — Windows Hello "falha aberta": erro ou ausência de Hello desbloqueia os álbuns protegidos
`shell.rs:176-186` + `app.js:644-645`
- **O que acontece:** `verify()` devolve `"unavailable"` quando o Hello não está configurado, quando está desativado por política (`DisabledByPolicy`), quando o dispositivo está ocupado (`DeviceBusy`) **e quando `RequestVerificationAsync` dá erro** (`Err(_) => "unavailable"`). O frontend trata `"unavailable"` como `"ok"`. Também chama `RequestVerificationAsync` sem janela dona. Em apps Win32 a Microsoft recomenda `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd)`, e sem ela o diálogo pode abrir atrás da janela ou falhar.
- **Como provocar:** num PC sem PIN/Hello, abrir o álbum protegido: abre direto. Ou desativar o Hello por política.
- **Correção:** separar `"not_configured"` (permitir, se essa for a decisão de produto) de `"error"`/`"busy"`/`"policy"` (negar). Usar `RequestVerificationForWindowAsync` com o HWND da janela principal.

### B5 — MÉDIO — `id` sem validação em comandos que gravam ou apagam: path traversal fora de `edicoes\`
`main.rs:393-397` (`save_render`), `main.rs:423-426` + `61-66` (`delete_render`/`remove_renders`), `main.rs:466` (`set_wallpaper` → `render_of`)
- **O que acontece:** `id` vai direto para `renders.join(format!("{id}.jpg"))`. Com `id = "..\\..\\..\\..\\..\\Users\\thith\\Pictures\\IMG_0001"`:
  - `delete_render` apaga **definitivamente**, sem Lixeira, `IMG_0001.jpg`, `.mp4`, `.webm` e `.capa.jpg` nessa pasta;
  - `save_render` grava bytes arbitrários em `qualquer\coisa.jpg`.
  
  Hoje só `save_render_raw` valida o id, e a regra `is_ascii_hexdigit() || c == 'd'` é estranha porque `'d'` já é hexadecimal.
- **Como provocar:** `__TAURI__.core.invoke('delete_render', {id:'..\\..\\..\\..\\..\\Users\\<user>\\Pictures\\teste'})` no console. É preciso conseguir executar JS no WebView. Não achei XSS: o `h()` usa `textContent`, e o único `html:` é o do Leaflet, só com ids. Mas `csp: null` + `withGlobalTauri: true` tornam isso a última barreira.
- **Correção:** uma função `fn valid_id(id) -> bool { id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) }` aplicada em **todos** os comandos que recebem id e em `target()` (`/r/<id>`). Melhor ainda: aceitar só ids que existem em `PATHS`.

### B6 — MÉDIO — `open_path` executa qualquer coisa pelo Explorador
`main.rs:386-390`
- **O que acontece:** o comando recebe uma string livre e roda `explorer <string>`. O Explorador abre `.exe`, `.bat`, `.lnk`, URLs e `shell:` com a ação padrão. Na prática, é "rodar programa" exposto ao WebView. O frontend só usa isso para a pasta da rota e para `https://devlumo.com.br`.
- **Correção:** separar em `open_folder(path)` (aceitar só se `Path::is_dir()`) e `open_url(url)` (aceitar só `https://`, via `ShellExecuteW`/`open`). Não passar arquivos executáveis.

### B7 — MÉDIO — Comandos síncronos pesados rodam na thread principal e congelam a interface
`main.rs:277` (`load_state`), `282-307` (`save_state`, com até **2,16 s** de `sleep` nas tentativas), `338` (`cached_index`, que lê e parseia o `index.json` inteiro), `361` (`trash_files`), `393` (`save_render`, decodifica base64 de JPEG grande), `402` (`save_render_raw`, grava centenas de MB), `577` (`open_default_settings` → `assoc::register`, ~250 escritas no registro)
- **O que acontece:** no Tauri 2, comandos sem `async` rodam na thread principal, a mesma do WebView. Enquanto o vídeo editado é gravado, a janela não responde nem para arrastar. O `LOCK` de `save_state` é redundante pelo mesmo motivo.
- **Correção:** marcar como `async` (ou `#[tauri::command(async)]`) e fazer o trabalho em `spawn_blocking`.

### B8 — MÉDIO — Todo executável que roda se registra como "app de fotos", inclusive builds de teste
`main.rs:609-611`, `assoc.rs:16-19`
- **O que acontece:** `assoc::register()` roda a cada abertura e grava `current_exe()` em `Fotos.Imagem`/`Fotos.Video`/`Applications\fotos.exe`. **Confirmado agora:** o registro desta máquina aponta para `...\AppData\Local\fotos-build\release\fotos.exe`, não para a instalação. Quem escolheu o Fotos como padrão passa a abrir a build de teste. Se essa pasta for apagada, o duplo clique numa foto quebra.
- **Correção:** registrar só quando o exe estiver na pasta de instalação (comparar com `%LOCALAPPDATA%\Fotos\` ou com a chave de desinstalação do NSIS), ou só no instalador (`NSIS_HOOK_POSTINSTALL`). Em `debug_assertions` nunca registrar.

### B9 — MÉDIO — Range com sufixo e intervalos fora do arquivo respondem errado
`main.rs:253-266`
- `bytes=-500` (os últimos 500 bytes) devolve os bytes 0–500 (teste).
- `bytes=20000-` num arquivo de 10 000 bytes devolve o último byte com 206, quando deveria ser 416.
- Num arquivo vazio, `206 bytes 0-0/0` traz um byte zero inventado.
- `read_exact` falhando (arquivo encolheu) envia zeros silenciosamente.
- **Correção:** um parser de Range de verdade (`-N`, `N-`, `N-M`, 416), usando `read` com o número real de bytes lidos.

### B10 — MÉDIO — EXIF de TIFF/RAW lê o arquivo inteiro para a memória durante o scan
`scan.rs:276-277` (`exif::Reader::read_from_container`)
- **O que acontece:** no kamadak-exif 0.5.5, quando o arquivo é TIFF (`is_tiff`), o leitor chama `reader.read_to_end(&mut buf)`. Isso vale para DNG, CR2, NEF, ARW, ORF, PEF, RW2, SRW, 3FR, TIF etc., que são TIFF por dentro, ou seja, 25–150 MB por arquivo. Com até 8 threads, o scan inicial de uma pasta de RAW lê **todos os bytes** de cada arquivo e pode usar ~1 GB de RAM de pico. TIFF de scanner com 1–2 GB pode estourar a memória.
- **Correção:** para TIFF/RAW, ler só os primeiros ~1–2 MB e chamar `Reader::read_raw` (os IFDs de EXIF ficam quase sempre no começo). Se falhar, ficar sem EXIF. Ou limitar por tamanho.

### B11 — MÉDIO — Formatos de vídeo que o app não toca são registrados como "abre com Fotos Glass"
`assoc.rs:45-51` + `main.rs:216, 239-244` + `viewer.js:265`
- **O que acontece:** WMV, ASF, AVI, MKV, 3GP, 3G2, MTS, M2TS, MPG, MPEG e VOB não estão em `NATIVE`. O `foto://` devolve um JPEG 2560 do primeiro quadro (gerado e guardado em `grandes\`) e o visualizador mostra "Este formato de vídeo não abre aqui → Abrir no Player". Esse botão chama `open_with_default` → `explorer arquivo.mkv`. Se o usuário tiver posto o Fotos Glass como padrão de vídeo, o Explorador **abre o próprio Fotos de novo**, e fica num ciclo.
- **Correção:** não declarar esses 11 formatos em `FileAssociations`/`OpenWithProgids` (só em "Abrir com", ou nada). Em `open_with_default`, se o padrão for o próprio Fotos (`UserChoice` = `Fotos.Video`), abrir com `OpenAs_RunDLL` ou com o Filmes e TV. Não gerar JPEG grande para vídeo no `foto://`.

### B12 — MÉDIO — Cache de miniaturas e de imagens grandes cresce para sempre; arquivos de cache podem ficar corrompidos
`main.rs:163, 181, 184, 194` (`mini\`, `grandes\`)
- **Crescimento:** o nome inclui `mtime`, então cada alteração do original cria um arquivo novo e o antigo nunca sai. Arquivos apagados ou que saíram da biblioteca também deixam o cache. `grandes\` guarda um JPEG 2560 q92 (~1–3 MB) para cada HEIC/RAW/TIFF já aberto. Nada limpa isso.
- **Corrupção:** `fs::write(&file, &jpg)` não é atômico. Com o `TerminateProcess` no fechamento, ou com duas tarefas da fila gerando a mesma chave ao mesmo tempo (grade e visualizador pedindo o mesmo item), pode sobrar um JPEG cortado. Como o cache é lido só pela existência do arquivo, essa miniatura fica cinza pela metade **para sempre**, até o original mudar de `mtime`.
- **Como provocar:** rolar a biblioteca com centenas de HEIC e fechar o app no meio. Ou olhar o tamanho de `%LOCALAPPDATA%\br.com.fotos.app\grandes` depois de uma semana de uso.
- **Correção:** gravar em `.tmp` e renomear. Limpeza por LRU e tamanho máximo (por exemplo, 1 GB para `grandes\` e 500 MB para `mini\`) na abertura, numa thread. Ao gravar uma chave nova, apagar `{key}_{size}*_` com `mtime` antigo.

### B13 — MÉDIO — Importar arrastando é recursivo, sem limite e duplica a própria biblioteca
`main.rs:489-512`, `app.js:1045`
- **O que acontece:** soltar **qualquer** pasta na janela copia recursivamente todas as fotos e vídeos dela para `folders[0]\Importados\<data>`, sem confirmação. Soltar `C:\`, `Imagens` (a própria biblioteca) ou uma pasta que já está na biblioteca duplica tudo. Se a pasta solta contém o destino, o `WalkDir` também entra em `Importados\<hoje>` e copia de novo o que acabou de copiar. A ordem do NTFS faz `X (2).jpg` vir antes de `X.jpg`, então em geral termina, mas com duplicatas.
- **Correção:** ignorar origens que já estão dentro de alguma pasta da biblioteca. Excluir `target` do walk (`filter_entry`). Para pastas, contar antes e pedir confirmação acima de N arquivos ou X GB. Copiar com `.tmp` e renomear.

### B14 — BAIXO-MÉDIO — Datas de vídeo do Pixel (`PXL_...mp4`) ficam com o fuso errado
`scan.rs:215-225`
- **O que acontece:** para vídeos, a data do nome tem prioridade sobre `PKEY_Media_DateEncoded`. O Pixel (Google Camera) põe a hora **UTC** no nome. Um vídeo gravado às 22h em Brasília vira 01h do dia seguinte. Fotos não sofrem porque o EXIF vem primeiro.
- **Correção:** para vídeos, preferir `DateEncoded` (já convertido para local) e usar o nome só como último recurso. Ou tratar `PXL_` como UTC.

### B15 — BAIXO-MÉDIO — Data de criação inválida joga fotos sem EXIF para 01/01/1970
`scan.rs:131, 227`, `main.rs:554, 561`
- **O que acontece:** `secs()` devolve 0 para hora anterior a 1970. Em compartilhamentos SMB/NAS e em arquivos extraídos de certos zips, a data de criação vem como 0 (1601), e `mtime.min(ctime)` = 0 → **1970-01-01**. O `.max(0)` não ajuda.
- **Correção:** `let ctime = if ctime > 0 { ctime } else { mtime };` e, no fallback, `min` só entre valores > 0.

### B16 — BAIXO — `export_items` para tudo no primeiro id desconhecido
`main.rs:447`
- `path_of(&id)?` dentro do laço devolve erro no meio da exportação: o que já foi copiado fica copiado, o Explorador não abre e o usuário vê "erro" sem saber quanto foi exportado. Erros de `fs::copy` são contados em silêncio.
- **Correção:** `continue` para id desconhecido e devolver `{copiados, falhas}`.

### B17 — BAIXO — `trash_files` em lote: uma falha cancela tudo e deixa estado inconsistente
`main.rs:361-370`
- `trash::delete_all` usa um único `IFileOperation`. Se um arquivo estiver em uso (vídeo aberto num player), a operação termina com `GetAnyOperationsAborted` → `Err`, mas os anteriores **já foram para a Lixeira**. O backend devolve erro, o `purgeOld` engole (`catch {}`), `dropRefs` não roda e as edições em `edicoes\` desses itens ficam órfãs.
- **Correção:** mandar um item por vez (ou, depois do erro, conferir com `exists()` quais saíram) e devolver a lista dos que foram de fato apagados.

### B18 — BAIXO — `reveal` com vírgula no caminho
`main.rs:375`
- `explorer /select,C:\a,b\c.jpg`: o Rust só põe aspas quando há espaço, e o Explorador separa por vírgula, então abre a pasta errada.
- **Correção:** `raw_arg(format!("/select,\"{}\"", p.display()))`.

### B19 — BAIXO — `index.tmp` compartilhado entre scans simultâneos
`scan.rs:174-178`
- Dois `scan_library` ao mesmo tempo gravam o mesmo `index.tmp`, e um pode renomear o conteúdo truncado do outro. Hoje o `rescan` tem a trava `scanning`, mas `open_file` + import + rescan podem se cruzar. A consequência é só um rescan completo, sem perda de dados.
- **Correção:** temporário com sufixo único (como em `save_state`) ou um `Mutex` em volta de `scan`.

### B20 — BAIXO — Arquivos pequenos (< 4 KB) somem da biblioteca
`scan.rs:123`
- GIFs/PNGs pequenos legítimos (stickers, ícones, prints minúsculos) nunca entram. Pelo duplo clique (`open_file`) eles aparecem, o que é inconsistente.

### B21 — BAIXO — Desinstalação deixa chaves vazias
`hooks.nsh:17-86`
- `assoc::register` cria `HKCU\Software\Classes\.<ext>` e `\OpenWithProgids` para 78 extensões, mesmo quando a chave não existia antes. O hook remove só o **valor**, então sobram até 156 chaves vazias. O `UserChoice` apontando para `Fotos.Imagem` também fica, e o Windows mostra "escolha um app" no próximo duplo clique (esperado, mas vale saber).
- **Correção:** depois de `DeleteRegValue`, chamar `DeleteRegKey /ifempty` em `...\.<ext>\OpenWithProgids` e em `...\.<ext>`.

### B22 — BAIXO — `release.yml`
`.github/workflows/release.yml`
- Não confere se a tag `vX.Y.Z` bate com `tauri.conf.json`/`Cargo.toml`. Hoje a working copy está em 1.1.3; uma tag errada publica um instalador com versão interna diferente.
- Não roda `cargo clippy`/`cargo test` antes de publicar.
- As actions estão presas por tag (`@v4`, `@v2`), não por SHA, e as permissões `contents/id-token/attestations: write` valem para o workflow todo. Para um job que publica binário com atestado, o ideal é fixar por SHA.
- O instalador não é assinado (SmartScreen avisa). Isso é informativo: o README já explica o SHA-256 e o atestado.

---

## Suspeitas (plausíveis pelo código, não reproduzidas)

### S1 — ALTO — O scan baixa a biblioteca inteira do OneDrive
`scan.rs:209, 276` + `main.rs:323-326`
- `default_folders` inclui `OneDrive\Imagens|Pictures|Fotos` automaticamente. No scan, `imagesize::size` e `File::open`+EXIF **leem** cada arquivo. Em arquivo "só online" (Arquivos sob Demanda), qualquer leitura de dados dispara a hidratação: o primeiro scan pode baixar dezenas de GB e encher o disco. As miniaturas pelo Shell não precisam disso, porque o OneDrive fornece a miniatura.
- **Verificar:** uma pasta do OneDrive com arquivos só na nuvem, abrir o app e ver se o ícone de nuvem vira "disponível neste dispositivo".
- **Correção:** pegar `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000) / `RECALL_ON_OPEN` (0x40000) / `OFFLINE` pelo `MetadataExt::file_attributes()` e, nesses arquivos, pular EXIF/imagesize e usar as propriedades do Shell (`System.Photo.DateTaken`, dimensões), que vêm do provedor sem baixar.

### S2 — MÉDIO — `panic = "abort"` + parsers de arquivos do usuário = possível crash a cada abertura
`Cargo.toml` (`[profile.release] panic = "abort"`), `scan.rs:209, 277`
- Qualquer pânico dentro do `kamadak-exif`/`imagesize` com um arquivo malformado (já houve pânicos de fuzzing nesses crates no passado) derruba o processo. Como o scan roda na abertura, o app passaria a fechar sempre ao abrir. Com `abort`, nem dá para usar `catch_unwind`.
- **Correção:** `panic = "unwind"` em release e `std::panic::catch_unwind` em volta de `read_item` e de cada tarefa da fila (que, além disso, hoje perderia o worker para sempre).

### S3 — MÉDIO — A fila de miniaturas para inteira se os workers travarem no Shell
`main.rs:81-110`
- São 3 a 8 workers sem timeout. `GetImage` em vídeo corrompido, em codec de terceiros com defeito ou em compartilhamento de rede que caiu pode demorar minutos ou travar. Com todos os workers presos, **todas** as miniaturas e o `foto://` de HEIC/RAW (mesma fila) param. A fila também não tem limite nem cancelamento: rolar 50 mil itens enfileira milhares de tarefas que serão feitas mesmo depois que a `<img>` saiu da tela.
- **Correção:** filas separadas para `foto://` grande e para miniaturas. Descartar tarefas cuja resposta já foi cancelada, ou limitar a fila e manter só as N mais recentes. Watchdog que cria um worker novo se um ficar > 30 s numa tarefa.

### S4 — MÉDIO — COM STA em thread do pool do tokio
`main.rs:536`
- `open_file` chama `shell::com_init()` (STA) dentro de `spawn_blocking`. A thread do pool fica STA para sempre, sem bomba de mensagens, e é reutilizada por outros `spawn_blocking` (`verify_user`, `set_wallpaper`, `scan_library`). Objetos COM que precisem de callback no apartamento podem travar. Também nunca há `CoUninitialize` nas threads do scan.
- **Correção:** fazer o trabalho COM numa thread dedicada (ou na fila de miniaturas), ou inicializar MTA (`COINIT_MULTITHREADED`) em threads sem janela, já que `IShellItem2::GetProperty` funciona em MTA.

### S5 — MÉDIO — Lixeira em pendrive ou rede pode apagar de vez
`main.rs:363` (crate `trash` 5.2.9: `FOF_NO_UI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING`)
- Em unidades sem Lixeira (rede, alguns pendrives), o `IFileOperation` apaga definitivamente. Com `FOF_NO_UI`, o aviso de "excluir permanentemente" pode não aparecer ou aparecer sem janela dona. O app diz "vai para a Lixeira em 30 dias".
- **Verificar:** biblioteca num compartilhamento SMB, apagar e esperar o expurgo (ou adiantar o relógio).
- **Correção:** antes de mandar, conferir se o volume tem Lixeira (`SHQueryRecycleBinW` na raiz) e, se não tiver, pedir confirmação explícita ou não expurgar automaticamente.

### S6 — BAIXO — Cache HTTP de 1 h para o original
`main.rs:119`
- `Cache-Control: max-age=3600` em `foto://<id>` e `thumb://<id>`, cujas URLs não mudam quando o arquivo é alterado fora do app. Depois de girar ou editar no Paint, o app mostra a versão velha por até 1 h. As edições do próprio app têm `?v=`, então estão certas.
- **Correção:** incluir `mtime` na URL (`&m=`) ou usar `no-cache` com `ETag` = `mtime`.

### S7 — BAIXO — Caminhos longos (> 260) e nomes com UTF-16 inválido
`shell.rs:39, 148`, `scan.rs:189`
- O `SHCreateItemFromParsingName` com caminho > MAX_PATH costuma falhar, então essas fotos ficam sem miniatura. Nomes com surrogate solto viram `U+FFFD` no `to_string_lossy`, e `path` no índice deixa de apontar para o arquivo: 404, falha na lixeira e o lote inteiro do B17 falha. Acentos comuns funcionam (a conversão para UTF-16 está correta).

### S8 — BAIXO — `open-file` da segunda instância pode se perder na abertura
`main.rs:586-589`
- Se a segunda instância chegar antes de o frontend registrar o `listen('open-file')`, o evento se perde. Melhor guardar em `LAUNCH` também e deixar o frontend consumir.

### S9 — BAIXO — Papel de parede convertido limitado a 2560 px
`main.rs:471`
- HEIC/RAW/WebP viram JPEG 2560 px. Em monitor 4K/5K o papel de parede fica ampliado e borrado. Para isso, gerar um tamanho próprio (até 3840/5120) em vez de reaproveitar o cache `grandes\`.

### S10 — INFO — Superfície de segurança
`tauri.conf.json:29-31`, `capabilities/default.json`
- `csp: null`, `withGlobalTauri: true` e todos os comandos do app liberados sem lista de permissões. Hoje não achei caminho de XSS: o `h()` usa `textContent`, o Leaflet é local e os nomes vindos do Nominatim não passam por `innerHTML`. Mesmo assim, B5 e B6 transformariam qualquer XSS futuro em apagar arquivos ou rodar programas. Recomenda-se uma CSP mínima (`default-src 'self'; img-src 'self' http://thumb.localhost http://foto.localhost https://tile.openstreetmap.org data: blob:; media-src http://foto.localhost blob:; connect-src https://nominatim.openstreetmap.org`).

---

## Itens revisados sem problema
- `shell::image`: bitmap 0×0 tratado, `DeleteObject` sempre chamado e alfa pré-multiplicado correto. `shrink` e `crop_square` não dividem por zero nem saem do buffer para w,h > 0, o que `image()` garante.
- `rat`/`dms`: denominador zero tratado. `raw.get(..19)` não entra em pânico com UTF-8.
- `try_at`: o `unwrap` é seguro (12:00:00) e os limites de índice são conferidos em `digits`.
- `save_render_raw` valida a extensão (`mp4`/`webm`) e o id (ver nota no B5).
- `save_state`: o temporário único por gravação resolve a colisão antiga; ver B2 sobre `fsync` e backup.
- `hooks.nsh`: as 78 extensões batem com o código. Também remove `RegisteredApplications` ("Fotos" e "Fotos Glass").

---

## Resumo — 10 achados mais graves
1. **B1** `main.rs:255-257` — `Range: bytes=500-100` estoura o `u64` e, com `panic=abort`, derruba o app.
2. **B2** `main.rs:277-279` — `state.json` corrompido vira `Null` e é sobrescrito: perdem-se álbuns, favoritos e ocultos (sem backup nem fsync).
3. **B3** `main.rs:417-420` / `661-666` — fechar durante a gravação do vídeo editado deixa o arquivo truncado e a edição anterior já foi apagada.
4. **S1** `scan.rs:209,276` — o scan lê cada arquivo e pode baixar toda a biblioteca do OneDrive (pasta incluída por padrão).
5. **B4** `shell.rs:176-186` — Windows Hello falha aberta: erro, política ou ausência de Hello desbloqueia os álbuns protegidos.
6. **B5** `main.rs:393-426` — `delete_render`/`save_render` aceitam `..\` no id e apagam ou gravam fora de `edicoes\`.
7. **B6** `main.rs:386-390` — `open_path` passa string livre ao Explorador, que executa programas.
8. **B8** `assoc.rs:16-19` / `main.rs:609` — cada exe aberto se registra como app de fotos; o registro aponta hoje para `fotos-build\release\fotos.exe`.
9. **B10** `scan.rs:277` — EXIF de RAW/TIFF lê o arquivo inteiro para a RAM, em até 8 threads.
10. **B7** `main.rs:282-307,402` — `save_state` (até 2,1 s de sleep) e `save_render_raw` (centenas de MB) rodam na thread principal e congelam a janela.

---

## Correções (03/11)

`cargo check`, `cargo clippy --all-targets` (sem avisos, inclusive os 3 antigos do `scan.rs`) e `cargo test` (9 testes: Range, ids, datas pelo nome, PXL em UTC, data de criação zerada) passam. O app não foi aberto e nada foi commitado. O `hooks.nsh` foi compilado com o makensis 3.13 num script de teste.

- **B1** corrigido: `faixa()` valida antes de alocar; invertido, fora do arquivo ou arquivo vazio respondem 416 com `Content-Range: bytes */len`.
- **B2** corrigido (lado do backend): `sync_all` antes do rename, cópia do anterior em `state.bak.json` a cada gravação; JSON inválido é guardado como `state.corrompido-<data>.json` e o backup entra no lugar. Sem backup válido ainda devolve `null` (o frontend começa vazio, mas o corrompido fica guardado para recuperação manual; avisar o usuário exige mudança no `store.js`).
- **B3** corrigido: vídeo, capa e foto editados gravam em `.tmp` + `sync_all` + rename e só depois apagam as outras extensões; contador `GRAVANDO` (vídeo, foto, estado, exportar, importar) que o `encerrar_agora` espera por até 10 s.
- **B4** corrigido no backend: `verify` devolve `ok`, `not_configured` (sem Hello/PIN), ou recusa `cancel`/`busy`/`policy`/`error`; usa `RequestVerificationForWindowAsync` com o HWND da janela principal (cai na versão sem janela se a interop falhar). Falta o `app.js` trocar `'unavailable'` por `'not_configured'` (ver abaixo).
- **B5** corrigido: `valid_id` (16 hex) em `save_render`, `save_render_raw`, `delete_render`, `remove_renders`, `render_of`, `trash_files`, `export_items`, `set_wallpaper` e em `/r/<id>` dos protocolos.
- **B6** corrigido: `open_path` saiu; `open_folder` (só pasta absoluta que existe) e `open_url` (só `https://`, via `ShellExecuteW`). O `api.js` tem `openFolder`/`openUrl` e um `openPath` de compatibilidade que encaminha para um dos dois.
- **B7** corrigido: `load_state`, `save_state`, `cached_index`, `trash_files`, `save_render`, `open_default_settings` viraram `async` + `spawn_blocking`; `save_render_raw` virou `#[tauri::command(async)]` (sem copiar o corpo).
- **B8** corrigido: `assoc::register` só roda em release e quando o exe é `%LOCALAPPDATA%\Fotos\fotos.exe` (sem diferenciar maiúsculas). O registro desta máquina continua apontando para `fotos-build` até o exe instalado abrir uma vez.
- **B9** corrigido: `-N`, `N-`, `N-M`, 416 e leitura com o número real de bytes lidos (arquivo que encolheu não inventa zeros).
- **B10** corrigido: TIFF/RAW lê só os primeiros 2 MB (`read_raw`); se o IFD estiver cortado, tenta 16 MB e para por aí.
- **B11** corrigido: só MP4/M4V/MOV/WebM entram em `FileAssociations`/`OpenWithProgids`/`SupportedTypes`; os valores antigos dos outros 11 formatos são apagados no próximo `register`. `open_with_default` abre o "Abrir com" (`OpenAs_RunDLL`) quando o padrão da extensão é o próprio Fotos. O JPEG grande do primeiro quadro no `foto://` continua (não é bug, só custo).
- **B12** corrigido: cache grava por `.tmp` + rename; limpeza 20 s depois da abertura tira `.tmp` largados, versões antigas da mesma chave e, acima de 500 MB (`mini\`) / 1 GB (`grandes\`), os mais antigos até 80% do limite.
- **B13** parcialmente: origens dentro das pastas da biblioteca (lidas do `state.json`) ou do destino são ignoradas, o walk não desce nelas, cópia por `.tmp` + rename e teto de 10 000 arquivos / 50 GB. A confirmação antes de importar depende do `app.js` (comando novo `import_preview`).
- **B14** corrigido: vídeo usa `DateEncoded` antes do nome; nome `PXL_` é tratado como UTC.
- **B15** corrigido: o fallback usa o menor entre mtime/ctime que seja > 0.
- **B16** corrigido: id desconhecido é pulado; falhas vão para o `erros.log`. O retorno continua sendo o número copiado (o `app.js` espera um número).
- **B17** corrigido: depois do `delete_all`, confere um a um o que saiu, limpa só esses e devolve erro dizendo quantos ficaram (o frontend então não esquece nenhum que ainda existe).
- **B18** corrigido: `raw_arg("/select,\"...\"")`.
- **B19** corrigido: `Mutex` em volta do `scan` e temporário com o pid.
- **B20** corrigido: só arquivo de 0 byte é pulado; o filtro de largura < 48 px continua.
- **B21** corrigido: macro `FotosLimpaExt` apaga `.<ext>\OpenWithProgids` e `.<ext>` com `/ifnosubkeys /ifnovalues` (só se ficaram vazias).
- **B22** não corrigido: o `release.yml` está fora de `src-tauri/` (fora do escopo desta rodada).
- **S1** corrigido: arquivos com OFFLINE/RECALL_ON_OPEN/RECALL_ON_DATA_ACCESS não são lidos no scan; dimensões e data saem de `GPS_FASTPROPERTIESONLY` (DateTaken, tamanho; para vídeo, duração e DateEncoded). Limite: se o arquivo for baixado depois sem mudar o mtime, o EXIF completo (câmera, GPS) não é relido.
- **S2** corrigido: `panic = "unwind"`, `catch_unwind` em `read_item` (devolve item básico) e em cada tarefa da fila; pânicos vão para o `erros.log`.
- **S3** corrigido: filas separadas (miniaturas e `foto://` grande), limite de 1500/24 tarefas com descarte da mais antiga (503), vigia que cria substituto para trabalhador preso > 30 s (até o dobro).
- **S4** corrigido: `open_file`, `trash_files`, `verify_user` e a conversão do papel de parede rodam numa thread própria em vez do pool do tokio.
- **S5** não corrigido: exige UI de confirmação para volumes sem Lixeira.
- **S6** corrigido: as URLs dos originais levam `&m=<mtime>` (`api.js`); respostas de erro saem com `no-store`.
- **S7** não corrigido: caminhos > 260 e UTF-16 inválido pedem mudar o id/caminho guardado no índice.
- **S8** parcialmente: enquanto o frontend não chamou `launch_file`, o arquivo da segunda instância fica guardado em `LAUNCH`. Entre o `launch_file` e o `listen` ainda pode se perder; o `app.js` precisa registrar o `listen` antes.
- **S9** não corrigido: o Shell entrega no máximo 2560 px pelo cache; gerar um tamanho maior pede outro caminho de decodificação.
- **S10** não corrigido: uma CSP sem rodar o app pode quebrar mapa, blobs e vídeos; fica para quando der para testar.

### O que o `app.js` precisa mudar
1. `unlock()` (~linha 644): `if (r === 'ok' || r === 'unavailable')` → `if (r === 'ok' || r === 'not_configured')`. Para `busy`/`policy`/`error`, mostrar um aviso (ex.: "Windows Hello indisponível agora" / "bloqueado pela política do PC"), sem liberar.
2. Linha ~179: `api.openPath(route.path)` → `api.openFolder(route.path)`.
3. Linha ~501: `api.openPath('https://devlumo.com.br')` → `api.openUrl('https://devlumo.com.br')`.
4. `importPaths()` (~linha 466): antes de copiar, `const [n, bytes] = await api.importPreview(paths, S.data.folders[0])`; se `n === 0`, avisar "Nada para importar" (já está na biblioteca); acima de ~200 arquivos ou ~2 GB, pedir confirmação. Pôr `catch` para mostrar o erro do teto (`String(e)`), que hoje vira rejeição sem aviso.
5. `boot()` (~linha 1038-1040): registrar `listen('open-file', …)` **antes** de `await api.launchFile()` (S8).
6. Opcional: `deleteForever`/`purgeOld` já tratam erro; a mensagem do `trash_files` agora diz quantos foram e quantos ficaram.
