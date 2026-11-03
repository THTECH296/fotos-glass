#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assoc;
mod scan;
mod shell;

use base64::Engine;
use scan::Item;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, OnceLock, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    http::{Request, Response},
    AppHandle, Emitter, Manager, UriSchemeResponder,
};
use tauri_plugin_dialog::DialogExt;

/// id → caminho do arquivo original
static PATHS: OnceLock<RwLock<HashMap<String, PathBuf>>> = OnceLock::new();
static DIRS: OnceLock<Dirs> = OnceLock::new();

struct Dirs {
    root: PathBuf,
    thumbs: PathBuf,
    full: PathBuf,
    renders: PathBuf,
}

fn paths() -> &'static RwLock<HashMap<String, PathBuf>> {
    PATHS.get_or_init(|| RwLock::new(HashMap::new()))
}
fn dirs() -> &'static Dirs {
    DIRS.get().expect("dirs")
}
fn remember(items: &[Item]) {
    // não limpa: arquivos abertos fora da biblioteca (duplo clique) continuam acessíveis
    let mut m = paths().write().unwrap_or_else(|e| e.into_inner());
    for i in items {
        m.insert(i.id.clone(), PathBuf::from(&i.path));
    }
}
fn path_of(id: &str) -> Result<PathBuf, String> {
    paths().read().unwrap_or_else(|e| e.into_inner()).get(id).cloned().ok_or_else(|| "Arquivo não encontrado".to_string())
}

/// Os ids são o FNV-1a de 16 dígitos hexadecimais (scan::id_for). Todo id que vem do WebView passa
/// por aqui antes de virar caminho: sem isso, "..\..\" apagava ou gravava fora de edicoes\.
fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn check_id(id: &str) -> Result<(), String> {
    valid_id(id).then_some(()).ok_or_else(|| "id inválido".to_string())
}

/// Extensões da cópia editada: JPEG para foto, MP4/WebM para vídeo.
const RENDER_EXT: &[&str] = &["mp4", "webm", "jpg"];

/// a cópia editada que existir (ou o caminho .jpg, se ainda não houver nenhuma)
fn render_of(id: &str) -> PathBuf {
    if !valid_id(id) {
        return dirs().renders.join("id-invalido");
    }
    RENDER_EXT
        .iter()
        .map(|e| dirs().renders.join(format!("{id}.{e}")))
        .find(|p| p.exists())
        .unwrap_or_else(|| dirs().renders.join(format!("{id}.jpg")))
}
/// apaga as cópias editadas de `id`, menos a extensão `manter` (a que acabou de ser gravada)
fn remove_renders_except(id: &str, manter: Option<&str>) {
    if !valid_id(id) {
        return;
    }
    for e in RENDER_EXT.iter().filter(|e| Some(**e) != manter) {
        let _ = fs::remove_file(dirs().renders.join(format!("{id}.{e}")));
    }
}
fn remove_renders(id: &str) {
    remove_renders_except(id, None);
    if valid_id(id) {
        let _ = fs::remove_file(poster_of(id));
    }
}
/// primeiro quadro do vídeo editado, usado como miniatura
fn poster_of(id: &str) -> PathBuf {
    dirs().renders.join(format!("{id}.capa.jpg"))
}

// ---------- gravação segura ----------

/// Gravações de dados do usuário em andamento. O `encerrar_agora` espera chegar a zero (até 10 s)
/// antes do TerminateProcess: antes, fechar no meio de "Salvando vídeo" deixava o MP4 cortado.
static GRAVANDO: AtomicUsize = AtomicUsize::new(0);
struct Gravando;
impl Gravando {
    fn new() -> Self {
        GRAVANDO.fetch_add(1, Ordering::SeqCst);
        Gravando
    }
}
impl Drop for Gravando {
    fn drop(&mut self) {
        GRAVANDO.fetch_sub(1, Ordering::SeqCst);
    }
}

fn tmp_ao_lado(dest: &Path) -> PathBuf {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let nome = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    dest.with_file_name(format!("{nome}.{}-{}.tmp", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)))
}

/// rename com algumas tentativas: antivírus e o indexador seguram o destino por instantes
fn renomear(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    let mut i = 0;
    loop {
        match fs::rename(tmp, dest) {
            Err(_) if i < 4 => {
                i += 1;
                std::thread::sleep(Duration::from_millis(40 * i));
            }
            r => return r,
        }
    }
}

/// Grava num temporário e renomeia: quem lê vê o arquivo antigo inteiro ou o novo inteiro, nunca
/// pela metade. `sync`: força o disco antes do rename (dados do usuário; o cache dispensa).
fn gravar_atomico(dest: &Path, bytes: &[u8], sync: bool) -> std::io::Result<()> {
    let tmp = tmp_ao_lado(dest);
    let r = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        if sync {
            f.sync_all()?;
        }
        drop(f);
        renomear(&tmp, dest)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// Cópia para a pasta do usuário (exportar/importar): copia com nome temporário e só no fim
/// ganha o nome certo, para um fechamento no meio não deixar uma foto cortada com cara de inteira.
fn copiar_atomico(src: &Path, dest: &Path) -> std::io::Result<()> {
    let _g = Gravando::new();
    let tmp = tmp_ao_lado(dest);
    let r = fs::copy(src, &tmp).and_then(|_| renomear(&tmp, dest));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// Trabalho pesado fora da thread principal (comandos síncronos do Tauri rodam nela, junto com o
/// WebView: a janela congelava enquanto o vídeo editado era gravado).
async fn em_segundo_plano<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Como `em_segundo_plano`, mas numa thread nova só para isso. Para trabalho COM (Shell, Lixeira,
/// Windows Hello): o CoInitialize STA deixaria a thread do pool do tokio STA para sempre, e ela é
/// reaproveitada por outros comandos.
async fn em_thread_propria<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || std::thread::spawn(f).join())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "falha interna".to_string())
}

// ---------- filas de miniaturas (LIFO: o que acabou de aparecer na tela vem primeiro) ----------

/// Tarefa da fila. Recebe `true` quando foi descartada sem rodar (a fila encheu): só responde.
type Job = Box<dyn FnOnce(bool) + Send>;

struct Trab {
    /// ms (relógio `agora_ms`) em que começou a tarefa atual; 0 = parado
    desde: AtomicU64,
    /// substituído pelo vigia por estar preso: sai depois de terminar a tarefa atual
    aposentado: AtomicBool,
}
struct Pool {
    jobs: Mutex<Vec<Job>>,
    cv: Condvar,
    /// tarefas na fila acima disso: a mais antiga (que já saiu da tela) é descartada
    limite: usize,
    /// trabalhadores normais; o vigia cria até o dobro quando eles travam
    n: usize,
    trabs: Mutex<Vec<Arc<Trab>>>,
}
/// miniaturas da grade
static POOL: OnceLock<Arc<Pool>> = OnceLock::new();
/// versão grande de HEIC/RAW/TIFF (foto://): fila própria para não esperar atrás de centenas de miniaturas
static POOL_GRANDE: OnceLock<Arc<Pool>> = OnceLock::new();

fn agora_ms() -> u64 {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn novo_pool(n: usize, limite: usize) -> Arc<Pool> {
    let p = Arc::new(Pool { jobs: Mutex::new(Vec::new()), cv: Condvar::new(), limite, n, trabs: Mutex::new(Vec::new()) });
    for _ in 0..n {
        novo_trabalhador(&p);
    }
    vigia();
    p
}

fn novo_trabalhador(p: &Arc<Pool>) {
    let t = Arc::new(Trab { desde: AtomicU64::new(0), aposentado: AtomicBool::new(false) });
    p.trabs.lock().unwrap_or_else(|e| e.into_inner()).push(t.clone());
    let p = p.clone();
    std::thread::spawn(move || {
        shell::com_init();
        loop {
            let job = {
                let mut q = p.jobs.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if let Some(j) = q.pop() {
                        break j;
                    }
                    q = p.cv.wait(q).unwrap_or_else(|e| e.into_inner());
                }
            };
            t.desde.store(agora_ms(), Ordering::Relaxed);
            // um pânico num provedor de miniatura não pode matar o trabalhador para sempre
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(false)));
            t.desde.store(0, Ordering::Relaxed);
            if t.aposentado.load(Ordering::Relaxed) {
                break;
            }
        }
        p.trabs.lock().unwrap_or_else(|e| e.into_inner()).retain(|x| !Arc::ptr_eq(x, &t));
    });
}

/// GetImage em vídeo corrompido, codec de terceiros com defeito ou rede que caiu pode travar por
/// minutos. Com todos os trabalhadores presos, nenhuma miniatura saía. Um trabalhador há mais de
/// 30 s na mesma tarefa ganha um substituto (até o dobro do normal).
fn vigia() {
    static UMA_VEZ: std::sync::Once = std::sync::Once::new();
    UMA_VEZ.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(5));
            let agora = agora_ms();
            for p in [POOL.get(), POOL_GRANDE.get()].into_iter().flatten() {
                let trabs: Vec<Arc<Trab>> = p.trabs.lock().unwrap_or_else(|e| e.into_inner()).clone();
                let mut vivos = trabs.len();
                for t in trabs {
                    let desde = t.desde.load(Ordering::Relaxed);
                    if vivos < p.n * 2 && desde != 0 && agora - desde > 30_000 && !t.aposentado.swap(true, Ordering::Relaxed) {
                        novo_trabalhador(p);
                        vivos += 1;
                    }
                }
            }
        });
    });
}

fn pool() -> &'static Arc<Pool> {
    POOL.get_or_init(|| novo_pool(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(3, 8), 1500))
}
fn pool_grande() -> &'static Arc<Pool> {
    POOL_GRANDE.get_or_init(|| novo_pool(2, 24))
}
fn submit_to(p: &Arc<Pool>, job: Job) {
    let descartada = {
        let mut q = p.jobs.lock().unwrap_or_else(|e| e.into_inner());
        q.push(job);
        // rolar 50 mil itens enfileirava milhares de miniaturas que já tinham saído da tela
        (q.len() > p.limite).then(|| q.remove(0))
    };
    p.cv.notify_one();
    if let Some(j) = descartada {
        j(true);
    }
}

// ---------- protocolos thumb:// e foto:// ----------

fn respond(r: UriSchemeResponder, status: u16, mime: &str, body: Vec<u8>, extra: &[(&str, String)]) {
    // As URLs dos originais levam o mtime (&m=) e as das edições o ?v=: cache longo é seguro.
    // Erro não vai para o cache (um 404 passageiro ficaria preso por 1 h).
    let cache = if status >= 400 { "no-store" } else { "max-age=3600" };
    let mut b = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", cache);
    for (k, v) in extra {
        b = b.header(*k, v);
    }
    r.respond(b.body(body).unwrap());
}

/// "/r/<id>" → render editado; "/<id>" → original
fn target(req: &Request<Vec<u8>>) -> Option<(String, PathBuf, bool)> {
    let path = req.uri().path().trim_start_matches('/');
    if let Some(id) = path.strip_prefix("r/") {
        if !valid_id(id) {
            return None;
        }
        return Some((id.to_string(), render_of(id), true));
    }
    let id = path.to_string();
    let p = path_of(&id).ok()?;
    Some((id, p, false))
}

fn query(req: &Request<Vec<u8>>, key: &str) -> Option<String> {
    req.uri().query()?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// JPEG de `p` pelo Shell, guardado em `dir`.
fn cached_shell_jpeg(dir: &Path, key: &str, p: &Path, size: i32, q: u8) -> Option<Vec<u8>> {
    cached_shell_jpeg_mode(dir, key, p, size, q, false)
}

/// `fill`: a miniatura vai preencher um quadrado (grade). Garante que o LADO MENOR tenha `size`
/// e já corta o quadrado do meio — antes vinha "cabendo" no quadrado e a grade esticava o lado
/// menor (fotos 4:3 ficavam 1,3× ampliadas; capturas 16:9 quase 2×, por isso borradas).
fn cached_shell_jpeg_mode(dir: &Path, key: &str, p: &Path, size: i32, q: u8, fill: bool) -> Option<Vec<u8>> {
    // O cache vale pela existência do arquivo: grava por temporário + rename para um fechamento no
    // meio (ou duas tarefas com a mesma chave) não deixar um JPEG cortado para sempre.
    if fill {
        let file = dir.join(format!("{key}_{size}q_{}.jpg", mtime(p)));
        if let Ok(b) = fs::read(&file) {
            return Some(b);
        }
        let sizes = [256, 768, 1280, 1920, 2560];
        let mut i = sizes.iter().position(|&s| s as f64 >= size as f64 * 1.34).unwrap_or(sizes.len() - 1);
        let (mut w, mut h, mut rgb) = shell::thumbnail_rgb(&p.to_string_lossy(), sizes[i])?;
        // panorama/captura muito alongada: o lado menor ainda é pequeno, pede o próximo tamanho
        while (w.min(h) as i32) < size && i + 1 < sizes.len() && (w.max(h) as i32) >= sizes[i] - 1 {
            i += 1;
            match shell::thumbnail_rgb(&p.to_string_lossy(), sizes[i]) {
                Some(t) => (w, h, rgb) = t,
                None => break,
            }
        }
        let (w, h, rgb) = shell::crop_square(w, h, &rgb);
        let (w, h, rgb) = shell::shrink(w, h, rgb, size as u32);
        let jpg = shell::jpeg(w, h, &rgb, q)?;
        let _ = gravar_atomico(&file, &jpg, false);
        return Some(jpg);
    }
    let file = dir.join(format!("{key}_{size}_{}.jpg", mtime(p)));
    if let Ok(b) = fs::read(&file) {
        return Some(b);
    }
    // O cache de miniaturas do Windows guarda 256/768/1280/1920/2560 px; pedir um tamanho no meio
    // faz ele ampliar a de 256 (fica borrado). Pede o próximo tamanho guardado e reduz aqui.
    let shell_size = [256, 768, 1280, 1920, 2560].into_iter().find(|&s| s >= size).unwrap_or(2560);
    let (w, h, rgb) = shell::thumbnail_rgb(&p.to_string_lossy(), shell_size)?;
    let (w, h, rgb) = shell::shrink(w, h, rgb, size as u32);
    let jpg = shell::jpeg(w, h, &rgb, q)?;
    let _ = gravar_atomico(&file, &jpg, false);
    Some(jpg)
}

/// Na abertura (numa thread, um pouco depois): tira temporários largados por um fechamento no meio,
/// as versões antigas da mesma miniatura (o nome leva o mtime do original, então cada alteração
/// criava um arquivo novo e o antigo nunca saía) e, acima de `limite` bytes, os mais antigos.
fn limpar_cache(dir: &Path, limite: u64) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let velho = std::time::SystemTime::now() - Duration::from_secs(600);
    let mut arqs: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    // "chave_tamanho" → (mtime do original no nome, índice em `arqs`)
    let mut atual: HashMap<String, (u64, usize)> = HashMap::new();
    let mut apagar: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let quando = md.accessed().ok().into_iter().chain(md.modified().ok()).max().unwrap_or(std::time::UNIX_EPOCH);
        if scan::ext_of(&p) == "tmp" {
            if quando < velho {
                apagar.insert(p);
            }
            continue;
        }
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let i = arqs.len();
        arqs.push((p, md.len(), quando));
        if let Some((grupo, m)) = stem.rsplit_once('_') {
            let m: u64 = m.parse().unwrap_or(0);
            match atual.get(grupo) {
                Some(&(m0, _)) if m0 >= m => {
                    apagar.insert(arqs[i].0.clone());
                }
                Some(&(_, i0)) => {
                    apagar.insert(arqs[i0].0.clone());
                    atual.insert(grupo.to_string(), (m, i));
                }
                None => {
                    atual.insert(grupo.to_string(), (m, i));
                }
            }
        }
    }
    for p in &apagar {
        let _ = fs::remove_file(p);
    }
    let mut vivos: Vec<_> = arqs.into_iter().filter(|(p, ..)| !apagar.contains(p)).collect();
    let mut total: u64 = vivos.iter().map(|(_, n, _)| n).sum();
    if total <= limite {
        return;
    }
    // os usados há mais tempo saem primeiro, até ficar em 80% do limite
    vivos.sort_by_key(|(.., t)| *t);
    for (p, n, _) in vivos {
        if total <= limite / 10 * 8 {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            total -= n;
        }
    }
}

fn thumb_protocol(req: Request<Vec<u8>>, r: UriSchemeResponder) {
    let Some((id, p, edited)) = target(&req) else {
        return respond(r, 404, "text/plain", vec![], &[]);
    };
    let size = query(&req, "s").and_then(|s| s.parse::<i32>().ok()).unwrap_or(360).clamp(64, 1600);
    let fill = query(&req, "c").as_deref() == Some("1");
    // vídeo editado: a miniatura sai da capa (o Shell não abre o MP4 fragmentado do navegador)
    let p = if edited && scan::ext_of(&p) != "jpg" && poster_of(&id).exists() { poster_of(&id) } else { p };
    submit_to(
        pool(),
        Box::new(move |descartada| {
            if descartada {
                return respond(r, 503, "text/plain", vec![], &[]);
            }
            let key = if edited { format!("r{id}") } else { id };
            match cached_shell_jpeg_mode(&dirs().thumbs, &key, &p, size, 88, fill) {
                Some(b) => respond(r, 200, "image/jpeg", b, &[]),
                None => respond(r, 404, "text/plain", vec![], &[]),
            }
        }),
    );
}

/// o que o WebView2 abre direto; o resto vira JPEG pelo Shell
const NATIVE: &[&str] = &["jpg", "jpeg", "jpe", "jfif", "jfi", "jif", "png", "apng", "gif", "webp", "bmp", "dib", "ico", "avif", "mp4", "m4v", "mov", "webm"];

fn mime(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jpe" | "jfif" | "jfi" | "jif" => "image/jpeg",
        "png" | "apng" => "image/png",
        "ico" => "image/x-icon",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" | "dib" => "image/bmp",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

/// Bloco por resposta: o <video> pede "bytes=N-" e vai pedindo o resto.
const BLOCO: u64 = 4 * 1024 * 1024;
const BLOCO_MAX: u64 = 8 * 1024 * 1024;

/// Cabeçalho Range já conferido contra o tamanho do arquivo.
#[derive(Debug, PartialEq)]
enum Faixa {
    /// sem Range (ou Range que não dá para entender): manda o arquivo inteiro, 200
    Inteiro,
    /// bytes start..=end, 206
    Parte(u64, u64),
    /// fora do arquivo ou invertido: 416. Antes "500-100" estourava o u64 e derrubava o app.
    Fora,
}

fn faixa(cab: Option<&str>, len: u64) -> Faixa {
    let Some(spec) = cab.and_then(|s| s.trim().strip_prefix("bytes=")) else {
        return Faixa::Inteiro;
    };
    // várias faixas ("0-1,5-9"): atende só a primeira
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else {
        return Faixa::Inteiro;
    };
    let (a, b) = (a.trim(), b.trim());
    if a.is_empty() {
        // "-N": os N últimos bytes
        let Ok(n) = b.parse::<u64>() else {
            return Faixa::Inteiro;
        };
        if n == 0 || len == 0 {
            return Faixa::Fora;
        }
        let start = len - n.min(len);
        return Faixa::Parte(start, (len - 1).min(start.saturating_add(BLOCO_MAX - 1)));
    }
    let Ok(start) = a.parse::<u64>() else {
        return Faixa::Inteiro;
    };
    if start >= len {
        return Faixa::Fora;
    }
    let end = if b.is_empty() {
        start.saturating_add(BLOCO - 1)
    } else {
        match b.parse::<u64>() {
            Ok(e) if e >= start => e,
            Ok(_) => return Faixa::Fora,
            Err(_) => return Faixa::Inteiro,
        }
    };
    Faixa::Parte(start, end.min(start.saturating_add(BLOCO_MAX - 1)).min(len - 1))
}

fn foto_protocol(req: Request<Vec<u8>>, r: UriSchemeResponder) {
    let Some((id, p, _)) = target(&req) else {
        return respond(r, 404, "text/plain", vec![], &[]);
    };
    let ext = scan::ext_of(&p);
    if !NATIVE.contains(&ext.as_str()) {
        // HEIC, TIFF, RAW…: o navegador não abre, então vai a versão grande do Shell.
        return submit_to(
            pool_grande(),
            Box::new(move |descartada| {
                if descartada {
                    return respond(r, 503, "text/plain", vec![], &[]);
                }
                match cached_shell_jpeg(&dirs().full, &id, &p, 2560, 92) {
                    Some(b) => respond(r, 200, "image/jpeg", b, &[]),
                    None => respond(r, 404, "text/plain", vec![], &[]),
                }
            }),
        );
    }
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    std::thread::spawn(move || {
        let Ok(mut f) = fs::File::open(&p) else {
            return respond(r, 404, "text/plain", vec![], &[]);
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let m = mime(&ext);
        let fora = |r| respond(r, 416, "text/plain", vec![], &[("Content-Range", format!("bytes */{len}"))]);
        match faixa(range.as_deref(), len) {
            Faixa::Fora => fora(r),
            Faixa::Parte(start, end) => {
                let mut buf = Vec::with_capacity((end - start + 1) as usize);
                // lê o que existe de fato: se o arquivo encolheu, não inventa zeros
                if f.seek(SeekFrom::Start(start)).is_err() || Read::by_ref(&mut f).take(end - start + 1).read_to_end(&mut buf).is_err() || buf.is_empty() {
                    return fora(r);
                }
                let end = start + buf.len() as u64 - 1;
                respond(
                    r,
                    206,
                    m,
                    buf,
                    &[("Accept-Ranges", "bytes".into()), ("Content-Range", format!("bytes {start}-{end}/{len}"))],
                )
            }
            Faixa::Inteiro => {
                let mut buf = Vec::with_capacity(len as usize);
                if f.read_to_end(&mut buf).is_err() {
                    return respond(r, 500, "text/plain", vec![], &[]);
                }
                respond(r, 200, m, buf, &[("Accept-Ranges", "bytes".into())])
            }
        }
    });
}

// ---------- comandos ----------

/// o estado gravado é sempre um objeto; qualquer outra coisa (lixo, zeros de uma queda de energia) é corrupção
fn ler_estado(p: &Path) -> Option<Value> {
    serde_json::from_slice::<Value>(&fs::read(p).ok()?).ok().filter(|v| v.is_object())
}

fn carregar_estado() -> Value {
    let root = &dirs().root;
    let file = root.join("state.json");
    if let Some(v) = ler_estado(&file) {
        return v;
    }
    if !file.exists() {
        // primeira abertura
        return Value::Null;
    }
    // Corrompido. Antes virava "não existe" e o próximo save gravava o estado vazio por cima: sumiam
    // álbuns, favoritos, ocultos e edições. Agora o estragado fica guardado e o backup entra no lugar.
    let nome = format!("state.corrompido-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let _ = fs::rename(&file, root.join(&nome));
    let bak = root.join("state.bak.json");
    match ler_estado(&bak) {
        Some(v) => {
            log_err(format!("state.json inválido (guardado como {nome}); recuperado do state.bak.json"));
            let _ = fs::copy(&bak, &file);
            v
        }
        None => {
            log_err(format!("state.json inválido (guardado como {nome}) e sem backup válido"));
            Value::Null
        }
    }
}

#[tauri::command]
async fn load_state() -> Value {
    em_segundo_plano(carregar_estado).await.unwrap_or(Value::Null)
}

fn salvar_estado(state: Value) -> Result<(), String> {
    // Uma gravação por vez; cada uma com o seu temporário. Antes todas usavam "state.tmp" e,
    // quando duas se cruzavam ou o Windows segurava o arquivo, o rename falhava em silêncio
    // e as exclusões feitas depois se perdiam.
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _w = Gravando::new();
    let file = dirs().root.join("state.json");
    let bak = dirs().root.join("state.bak.json");
    let tmp = tmp_ao_lado(&file);
    let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    // sync_all antes do rename: sem ele uma queda de energia podia deixar o state.json do tamanho
    // certo, mas cheio de zeros
    (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()
    })()
    .map_err(|e| {
        let _ = fs::remove_file(&tmp);
        log_err(format!("gravar temporário: {e}"))
    })?;
    // o anterior (gravado por aqui, já com sync) vira o backup que o load_state usa se o principal estragar
    if file.exists() {
        let _ = fs::copy(&file, &bak);
    }
    let mut last = String::new();
    for i in 0..8 {
        match fs::rename(&tmp, &file) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(Duration::from_millis(60 * (i + 1)));
            }
        }
    }
    // último recurso: escreve direto por cima (se cortar no meio, o backup acima ainda vale)
    let r = fs::write(&file, &bytes).map_err(|e| log_err(format!("rename falhou ({last}) e escrita direta também: {e}")));
    let _ = fs::remove_file(&tmp);
    r
}

#[tauri::command]
async fn save_state(state: Value) -> Result<(), String> {
    em_segundo_plano(move || salvar_estado(state)).await?
}

fn log_err(msg: String) -> String {
    if let Some(d) = DIRS.get() {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(d.root.join("erros.log")) {
            let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        }
    }
    msg
}

#[tauri::command]
fn default_folders(app: AppHandle) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(p) = app.path().picture_dir() {
        out.push(p);
    }
    if let Ok(home) = app.path().home_dir() {
        for sub in ["OneDrive\\Imagens", "OneDrive\\Pictures", "OneDrive\\Fotos"] {
            out.push(home.join(sub));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.into_iter()
        .filter(|p| p.is_dir())
        .filter_map(|p| fs::canonicalize(&p).ok().map(|c| (p, c)))
        .filter(|(_, c)| seen.insert(c.clone()))
        .map(|(p, _)| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn cached_index() -> Vec<Item> {
    em_segundo_plano(|| {
        let items = scan::load_index(&dirs().root.join("index.json"));
        remember(&items);
        items
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn scan_library(app: AppHandle, folders: Vec<String>) -> Vec<Item> {
    tauri::async_runtime::spawn_blocking(move || {
        let items = scan::scan(&app, &folders, &dirs().root.join("index.json"));
        remember(&items);
        items
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().set_title("Escolha uma pasta de fotos").blocking_pick_folder().map(|p| p.to_string())
}

/// Manda para a Lixeira. Se algum arquivo não sair (aberto num player, por exemplo), o
/// IFileOperation aborta no meio: os anteriores já foram. Por isso confere um a um o que saiu,
/// limpa só esses e devolve erro dizendo quantos ficaram (o frontend então não esquece nenhum).
fn lixeira(ids: Vec<String>) -> Result<usize, String> {
    let ids: Vec<String> = ids.into_iter().filter(|id| valid_id(id)).collect();
    let list: Vec<(String, PathBuf)> = ids.iter().filter_map(|id| path_of(id).ok().map(|p| (id.clone(), p))).collect();
    let r = if list.is_empty() { Ok(()) } else { trash::delete_all(list.iter().map(|(_, p)| p)) };
    let ficaram: Vec<&String> = list.iter().filter(|(_, p)| p.exists()).map(|(id, _)| id).collect();
    let foram = list.len() - ficaram.len();
    let mut m = paths().write().unwrap_or_else(|e| e.into_inner());
    for id in ids.iter().filter(|id| !ficaram.contains(id)) {
        m.remove(id);
        remove_renders(id);
    }
    if ficaram.is_empty() {
        return Ok(foram);
    }
    let motivo = r.err().map(|e| e.to_string()).unwrap_or_default();
    Err(log_err(format!(
        "{foram} de {} foram para a Lixeira; {} não puderam ser apagados (abertos em outro programa?) {motivo}",
        list.len(),
        ficaram.len()
    )))
}

#[tauri::command]
async fn trash_files(ids: Vec<String>) -> Result<usize, String> {
    em_thread_propria(move || lixeira(ids)).await?
}

#[tauri::command]
fn reveal(id: String) -> Result<(), String> {
    let p = path_of(&id)?;
    // aspas: o Explorador separa os argumentos por vírgula, e "C:\a,b\c.jpg" abria a pasta errada
    std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", p.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_with_default(id: String) -> Result<(), String> {
    let p = path_of(&id)?;
    if assoc::padrao_e_fotos(&scan::ext_of(&p)) {
        // O padrão é o próprio Fotos: abrir pelo Explorador reabriria o Fotos (ciclo com
        // "Abrir no Player"). Mostra o "Abrir com" do Windows para escolher outro app.
        std::process::Command::new("rundll32.exe").raw_arg(format!("shell32.dll,OpenAs_RunDLL {}", p.display())).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    std::process::Command::new("explorer").arg(p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre uma pasta no Explorador. Só pasta que existe: o antigo open_path passava qualquer string ao
/// Explorador, que "abre" .exe, .bat, .lnk e shell: com a ação padrão (rodar programa pelo WebView).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.is_dir() {
        return Err("Pasta não encontrada".into());
    }
    std::process::Command::new("explorer").raw_arg(format!("\"{}\"", p.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Abre um link no navegador. Só https://, sem espaço, aspas nem caractere de controle.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let ok = url.len() < 2048 && url.starts_with("https://") && url.len() > 8 && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"');
    if !ok {
        return Err("Link inválido".into());
    }
    shell::open_url(&url).then_some(()).ok_or_else(|| "Não foi possível abrir o link".into())
}

#[tauri::command]
async fn save_render(id: String, data: String) -> Result<(), String> {
    check_id(&id)?;
    let g = Gravando::new();
    em_segundo_plano(move || {
        let _g = g;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.split(',').next_back().unwrap_or("")).map_err(|e| e.to_string())?;
        // grava primeiro e só depois tira as outras: antes apagava a edição anterior e, se a gravação
        // falhasse (disco cheio), as duas se perdiam
        gravar_atomico(&dirs().renders.join(format!("{id}.jpg")), &bytes, true).map_err(|e| log_err(format!("gravar foto editada: {e}")))?;
        remove_renders_except(&id, Some("jpg"));
        let _ = fs::remove_file(poster_of(&id));
        Ok(())
    })
    .await?
}

/// Vídeo editado, em binário direto (sem base64: um vídeo pode ter centenas de MB).
/// Cabeçalhos: x-id (id da foto/vídeo) e x-ext (mp4 ou webm).
/// `async`: roda fora da thread principal (gravar centenas de MB congelava a janela); síncrona por
/// dentro para não copiar o corpo do pedido.
#[tauri::command(async)]
fn save_render_raw(request: tauri::ipc::Request) -> Result<(), String> {
    let _g = Gravando::new();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("corpo vazio".into());
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let id = header("x-id");
    let ext = header("x-ext");
    if !valid_id(&id) || !["mp4", "webm"].contains(&ext.as_str()) {
        return Err("pedido inválido".into());
    }
    let capa = request.headers().get("x-capa").is_some();
    if capa {
        // a capa chega antes do vídeo, numa chamada própria
        return gravar_atomico(&poster_of(&id), bytes, true).map_err(|e| log_err(format!("gravar capa: {e}")));
    }
    // temporário + rename e só então tira as outras extensões: fechar no meio não deixa um MP4
    // cortado como edição nem apaga a edição anterior antes da nova existir
    gravar_atomico(&dirs().renders.join(format!("{id}.{ext}")), bytes, true).map_err(|e| log_err(format!("gravar vídeo editado: {e}")))?;
    remove_renders_except(&id, Some(&ext));
    Ok(())
}

#[tauri::command]
fn delete_render(id: String) {
    remove_renders(&id);
}

fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

/// items: [id, editado?]
#[tauri::command]
async fn export_items(app: AppHandle, items: Vec<(String, bool)>) -> Result<Option<usize>, String> {
    let Some(dest) = app.dialog().file().set_title("Exportar para…").blocking_pick_folder() else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    em_segundo_plano(move || {
        let (mut n, mut falhas) = (0, 0);
        for (id, edited) in items {
            // id desconhecido não interrompe a exportação no meio (antes o `?` parava tudo sem dizer quanto foi)
            let Ok(orig) = path_of(&id) else {
                falhas += 1;
                continue;
            };
            let stem = orig.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(id.clone());
            let (src, stem, ext) = if edited && valid_id(&id) && render_of(&id).exists() {
                let r = render_of(&id);
                let ext = scan::ext_of(&r);
                (r, format!("{stem} ({})", if ext == "jpg" { "editada" } else { "editado" }), ext)
            } else {
                (orig.clone(), stem, scan::ext_of(&orig))
            };
            match copiar_atomico(&src, &unique(&dest, &stem, &ext)) {
                Ok(()) => n += 1,
                Err(e) => {
                    falhas += 1;
                    log_err(format!("exportar {}: {e}", src.display()));
                }
            }
        }
        if falhas > 0 {
            log_err(format!("exportação: {n} copiados, {falhas} falharam"));
        }
        let _ = std::process::Command::new("explorer").arg(&dest).spawn();
        Some(n)
    })
    .await
}

#[tauri::command]
async fn set_wallpaper(id: String, edited: bool) -> Result<(), String> {
    let p = if edited && valid_id(&id) && render_of(&id).exists() { render_of(&id) } else { path_of(&id)? };
    let ext = scan::ext_of(&p);
    let file = if ["jpg", "jpeg", "png", "bmp"].contains(&ext.as_str()) {
        p
    } else {
        em_thread_propria(move || -> Result<PathBuf, String> {
            let jpg = cached_shell_jpeg(&dirs().full, &id, &p, 2560, 92).ok_or("Não foi possível converter a imagem")?;
            let f = dirs().root.join("papel-de-parede.jpg");
            gravar_atomico(&f, &jpg, false).map_err(|e| e.to_string())?;
            Ok(f)
        })
        .await??
    };
    shell::set_wallpaper(&file.to_string_lossy()).then_some(()).ok_or_else(|| "O Windows recusou o papel de parede".into())
}

/// Windows Hello: "ok", "not_configured" (PC sem Hello/PIN), ou recusa ("cancel", "busy", "policy", "error").
#[tauri::command]
async fn verify_user(app: AppHandle, message: String) -> String {
    let hwnd = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).unwrap_or(0);
    em_thread_propria(move || shell::verify(&message, hwnd).to_string()).await.unwrap_or_else(|_| "error".into())
}

// ---------- importar arrastando ----------

/// teto de segurança: soltar C:\ não pode copiar o disco inteiro para a biblioteca
const IMPORT_MAX_ARQS: usize = 10_000;
const IMPORT_MAX_BYTES: u64 = 50 * 1024 * 1024 * 1024;

fn canon(p: &Path) -> Option<PathBuf> {
    fs::canonicalize(p).ok().map(|c| PathBuf::from(c.to_string_lossy().to_lowercase()))
}

/// Pastas da biblioteca (as do state.json mais o destino): o que já está nelas não é importado de novo.
fn pastas_da_biblioteca(dest: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ler_estado(&dirs().root.join("state.json"))
        .and_then(|v| v.get("folders").and_then(|f| f.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|f| f.as_str())
        .filter_map(|f| canon(Path::new(f)))
        .collect();
    out.extend(canon(dest));
    out
}

/// Fotos e vídeos de `paths` (pastas são percorridas) que ainda não estão na biblioteca.
/// Antes, soltar a própria pasta Imagens duplicava tudo, e se a pasta solta continha o destino o
/// walk entrava em Importados\<hoje> e copiava de novo o que acabou de copiar.
fn arquivos_para_importar(paths: &[String], dest: &Path) -> Vec<(PathBuf, u64)> {
    let evitar = pastas_da_biblioteca(dest);
    let dentro = |c: &Path| evitar.iter().any(|b| c.starts_with(b));
    let mut out = Vec::new();
    for p in paths {
        let raiz = Path::new(p);
        let Some(c) = canon(raiz) else { continue };
        if dentro(&c) {
            continue;
        }
        let walker = walkdir::WalkDir::new(raiz).into_iter().filter_entry(|e| {
            // não desce em pastas da biblioteca que estejam dentro do que foi solto (ex.: soltar C:\)
            e.depth() == 0
                || !e.file_type().is_dir()
                || e.path().strip_prefix(raiz).map(|rel| !dentro(&c.join(rel.to_string_lossy().to_lowercase()))).unwrap_or(true)
        });
        for e in walker.flatten().filter(|e| e.file_type().is_file()) {
            let ext = scan::ext_of(e.path());
            if !scan::PHOTO_EXT.contains(&ext.as_str()) && !scan::VIDEO_EXT.contains(&ext.as_str()) {
                continue;
            }
            out.push((e.path().to_path_buf(), e.metadata().map(|m| m.len()).unwrap_or(0)));
        }
    }
    out
}

/// Quantos arquivos e bytes um import_paths copiaria (para o frontend pedir confirmação antes).
#[tauri::command]
async fn import_preview(paths: Vec<String>, dest: String) -> Result<(usize, u64), String> {
    em_segundo_plano(move || {
        let l = arquivos_para_importar(&paths, Path::new(&dest));
        (l.len(), l.iter().map(|(_, n)| n).sum())
    })
    .await
}

/// Copia arquivos/pastas arrastados para `<dest>\Importados\<data>`; devolve quantos entraram.
#[tauri::command]
async fn import_paths(paths: Vec<String>, dest: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lista = arquivos_para_importar(&paths, Path::new(&dest));
        let bytes: u64 = lista.iter().map(|(_, n)| n).sum();
        if lista.len() > IMPORT_MAX_ARQS || bytes > IMPORT_MAX_BYTES {
            return Err(format!(
                "São {} arquivos ({:.1} GB). Importe uma pasta menor.",
                lista.len(),
                bytes as f64 / 1024f64.powi(3)
            ));
        }
        if lista.is_empty() {
            return Ok(0);
        }
        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        let target = Path::new(&dest).join("Importados").join(day);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let mut n = 0;
        for (src, _) in lista {
            let ext = scan::ext_of(&src);
            let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if copiar_atomico(&src, &unique(&target, &stem, &ext)).is_ok() {
                n += 1;
            }
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- abrir um arquivo (Fotos como app padrão) ----------

static LAUNCH: Mutex<Option<String>> = Mutex::new(None);
/// o frontend já pediu o launch_file (daqui em diante ele escuta o "open-file")
static LAUNCH_LIDO: AtomicBool = AtomicBool::new(false);

fn media_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|a| {
        let p = Path::new(a);
        let e = scan::ext_of(p);
        p.is_file() && (scan::PHOTO_EXT.contains(&e.as_str()) || scan::VIDEO_EXT.contains(&e.as_str()))
    }).cloned()
}

/// arquivo com que o app foi aberto (só a primeira vez)
#[tauri::command]
fn launch_file() -> Option<String> {
    let mut l = LAUNCH.lock().unwrap_or_else(|e| e.into_inner());
    LAUNCH_LIDO.store(true, Ordering::SeqCst);
    l.take()
}

/// O arquivo e as fotos/vídeos da mesma pasta, em ordem de nome, como no visualizador do Windows.
#[tauri::command]
async fn open_file(path: String) -> Result<(Vec<Item>, usize), String> {
    em_thread_propria(move || {
        shell::com_init();
        let target = PathBuf::from(&path);
        let dir = target.parent().ok_or("Pasta inválida")?.to_path_buf();
        let cache: HashMap<String, Item> = scan::load_index(&dirs().root.join("index.json")).into_iter().map(|i| (i.path.to_lowercase(), i)).collect();
        let mut files: Vec<PathBuf> = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let e = scan::ext_of(p);
                p.is_file() && (scan::PHOTO_EXT.contains(&e.as_str()) || scan::VIDEO_EXT.contains(&e.as_str()))
            })
            .collect();
        files.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default());
        let mut items = Vec::with_capacity(files.len());
        let mut index = 0;
        for p in files {
            let Ok(md) = fs::metadata(&p) else { continue };
            let mtime = md.modified().map(scan::secs).unwrap_or(0);
            let key = p.to_string_lossy().to_lowercase();
            let alvo = key == target.to_string_lossy().to_lowercase();
            if alvo {
                index = items.len();
            }
            items.push(match cache.get(&key) {
                Some(c) if c.size == md.len() && c.mtime == mtime => c.clone(),
                // o arquivo aberto vai ser baixado de qualquer jeito; os vizinhos só online, não
                _ => scan::read_item(&p, md.len(), mtime, md.created().map(scan::secs).unwrap_or(mtime), !alvo && scan::so_na_nuvem(&md)),
            });
        }
        remember(&items);
        Ok((items, index))
    })
    .await?
}

#[tauri::command]
fn default_status() -> assoc::Status {
    assoc::status()
}

#[tauri::command]
async fn open_default_settings() {
    let _ = em_segundo_plano(assoc::register).await;
    assoc::open_settings();
}

fn main() {
    // pânico vai para o erros.log (sem console em release) e segue o tratamento padrão
    let padrao = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_err(format!("pânico: {info}"));
        padrao(info);
    }));
    let args: Vec<String> = std::env::args().collect();
    *LAUNCH.lock().unwrap() = media_arg(&args);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            if let Some(f) = media_arg(&argv) {
                let mut l = LAUNCH.lock().unwrap_or_else(|e| e.into_inner());
                if LAUNCH_LIDO.load(Ordering::SeqCst) {
                    let _ = app.emit("open-file", f);
                } else {
                    // a interface ainda não chegou ao listen('open-file'): o evento se perderia
                    *l = Some(f);
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("thumb", |_ctx, req, r| thumb_protocol(req, r))
        .register_asynchronous_uri_scheme_protocol("foto", |_ctx, req, r| foto_protocol(req, r))
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            // a 1ª versão guardava miniaturas borradas em "miniaturas"; a pasta nova é "mini"
            let _ = fs::remove_dir_all(root.join("miniaturas"));
            let d = Dirs { thumbs: root.join("mini"), full: root.join("grandes"), renders: root.join("edicoes"), root };
            for p in [&d.root, &d.thumbs, &d.full, &d.renders] {
                fs::create_dir_all(p)?;
            }
            let _ = DIRS.set(d);
            // mantém o registro de "app de fotos e vídeos" apontando para este .exe (só o instalado)
            std::thread::spawn(|| {
                let _ = assoc::register();
            });
            // limpeza do cache depois que a abertura assentou
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_secs(20));
                let d = dirs();
                limpar_cache(&d.thumbs, 500 * 1024 * 1024);
                limpar_cache(&d.full, 1024 * 1024 * 1024);
                // nas edições e na raiz só saem os temporários largados (limite "infinito")
                limpar_cache(&d.renders, u64::MAX);
                limpar_tmp(&d.root);
            });
            // Garante que a janela aparece mesmo se a interface demorar.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(2500));
                if let Some(w) = h.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            default_folders,
            cached_index,
            scan_library,
            pick_folder,
            trash_files,
            reveal,
            open_with_default,
            open_folder,
            open_url,
            save_render,
            save_render_raw,
            delete_render,
            export_items,
            set_wallpaper,
            verify_user,
            import_preview,
            import_paths,
            launch_file,
            open_file,
            default_status,
            open_default_settings
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Fotos")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                encerrar_agora();
            }
        });
}

/// temporários largados na raiz (state.*.tmp, index.*.tmp) por um fechamento no meio
fn limpar_tmp(dir: &Path) {
    let velho = std::time::SystemTime::now() - Duration::from_secs(600);
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let antigo = e.metadata().and_then(|m| m.modified()).map(|t| t < velho).unwrap_or(false);
        if antigo && scan::ext_of(&p) == "tmp" {
            let _ = fs::remove_file(p);
        }
    }
}

/// Encerra o processo na hora ao fechar o app. A saída normal do Windows (ExitProcess) espera os
/// provedores de miniatura do Shell que ainda estão trabalhando nas threads da fila e às vezes
/// travava por minutos: o processo ficava vivo e invisível, segurando a "instância única", e todo
/// duplo clique numa imagem era entregue a ele — nada abria. O estado já foi gravado antes
/// (a janela só fecha depois do flushSave) e o índice é gravado por rename atômico.
/// Antes de matar, espera (até 10 s) as gravações de dados do usuário em andamento (vídeo editado,
/// exportação, importação): matar no meio deixava arquivo cortado.
fn encerrar_agora() {
    use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
    let fim = Instant::now() + Duration::from_secs(10);
    while GRAVANDO.load(Ordering::SeqCst) > 0 && Instant::now() < fim {
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        let _ = TerminateProcess(GetCurrentProcess(), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::{faixa, valid_id, Faixa, BLOCO, BLOCO_MAX};

    #[test]
    fn range_normal() {
        assert_eq!(faixa(Some("bytes=0-99"), 1000), Faixa::Parte(0, 99));
        assert_eq!(faixa(Some("bytes=100-"), 1000), Faixa::Parte(100, 999));
        assert_eq!(faixa(Some("bytes=0-"), 100 * 1024 * 1024), Faixa::Parte(0, BLOCO - 1));
        assert_eq!(faixa(Some("bytes=0-999999999"), 100 * 1024 * 1024), Faixa::Parte(0, BLOCO_MAX - 1));
        assert_eq!(faixa(Some("bytes=5-5"), 10), Faixa::Parte(5, 5));
        assert_eq!(faixa(Some("bytes=9-50"), 10), Faixa::Parte(9, 9));
        // várias faixas: só a primeira
        assert_eq!(faixa(Some("bytes=0-1, 5-9"), 10), Faixa::Parte(0, 1));
    }

    #[test]
    fn range_sufixo() {
        assert_eq!(faixa(Some("bytes=-500"), 10_000), Faixa::Parte(9_500, 9_999));
        assert_eq!(faixa(Some("bytes=-500"), 100), Faixa::Parte(0, 99));
        assert_eq!(faixa(Some("bytes=-0"), 100), Faixa::Fora);
    }

    #[test]
    fn range_fora_do_arquivo() {
        // antes: estouro do u64 e pânico "capacity overflow" (derrubava o app)
        assert_eq!(faixa(Some("bytes=500-100"), 1000), Faixa::Fora);
        assert_eq!(faixa(Some("bytes=20000-"), 10_000), Faixa::Fora);
        assert_eq!(faixa(Some("bytes=0-"), 0), Faixa::Fora);
        assert_eq!(faixa(Some("bytes=-10"), 0), Faixa::Fora);
        assert_eq!(faixa(Some("bytes=10-"), 10), Faixa::Fora);
        assert_eq!(faixa(Some(&format!("bytes={}-", u64::MAX)), 10), Faixa::Fora);
        assert_eq!(faixa(Some(&format!("bytes=0-{}", u64::MAX)), 10), Faixa::Parte(0, 9));
    }

    #[test]
    fn range_ignorado() {
        assert_eq!(faixa(None, 10), Faixa::Inteiro);
        assert_eq!(faixa(Some("items=0-1"), 10), Faixa::Inteiro);
        assert_eq!(faixa(Some("bytes=abc"), 10), Faixa::Inteiro);
        assert_eq!(faixa(Some("bytes=a-1"), 10), Faixa::Inteiro);
        assert_eq!(faixa(Some("bytes=1-b"), 10), Faixa::Inteiro);
        assert_eq!(faixa(Some("bytes=-"), 10), Faixa::Inteiro);
    }

    #[test]
    fn ids() {
        assert!(valid_id("0123456789abcdef"));
        assert!(valid_id("0123456789ABCDEF"));
        assert!(!valid_id(""));
        assert!(!valid_id("0123456789abcde"));
        assert!(!valid_id("..\\..\\..\\Users\\x"));
        assert!(!valid_id("0123456789abcdeg"));
        assert!(!valid_id("0123456789abcdef0"));
    }
}
