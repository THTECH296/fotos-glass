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
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, RwLock},
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
    let mut m = paths().write().unwrap();
    for i in items {
        m.insert(i.id.clone(), PathBuf::from(&i.path));
    }
}
fn path_of(id: &str) -> Result<PathBuf, String> {
    paths().read().unwrap().get(id).cloned().ok_or_else(|| "Arquivo não encontrado".to_string())
}
fn render_of(id: &str) -> PathBuf {
    dirs().renders.join(format!("{id}.jpg"))
}

// ---------- fila de miniaturas (LIFO: o que acabou de aparecer na tela vem primeiro) ----------

type Job = Box<dyn FnOnce() + Send>;
struct Pool {
    jobs: Mutex<Vec<Job>>,
    cv: Condvar,
}
static POOL: OnceLock<Arc<Pool>> = OnceLock::new();

fn pool() -> &'static Arc<Pool> {
    POOL.get_or_init(|| {
        let p = Arc::new(Pool { jobs: Mutex::new(Vec::new()), cv: Condvar::new() });
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(3, 8);
        for _ in 0..n {
            let p = p.clone();
            std::thread::spawn(move || {
                shell::com_init();
                loop {
                    let job = {
                        let mut q = p.jobs.lock().unwrap();
                        loop {
                            if let Some(j) = q.pop() {
                                break j;
                            }
                            q = p.cv.wait(q).unwrap();
                        }
                    };
                    job();
                }
            });
        }
        p
    })
}
fn submit(job: Job) {
    let p = pool();
    p.jobs.lock().unwrap().push(job);
    p.cv.notify_one();
}

// ---------- protocolos thumb:// e foto:// ----------

fn respond(r: UriSchemeResponder, status: u16, mime: &str, body: Vec<u8>, extra: &[(&str, String)]) {
    let mut b = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "max-age=3600");
    for (k, v) in extra {
        b = b.header(*k, v);
    }
    r.respond(b.body(body).unwrap());
}

/// "/r/<id>" → render editado; "/<id>" → original
fn target(req: &Request<Vec<u8>>) -> Option<(String, PathBuf, bool)> {
    let path = req.uri().path().trim_start_matches('/');
    if let Some(id) = path.strip_prefix("r/") {
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
        let _ = fs::write(&file, &jpg);
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
    let _ = fs::write(&file, &jpg);
    Some(jpg)
}

fn thumb_protocol(req: Request<Vec<u8>>, r: UriSchemeResponder) {
    let Some((id, p, edited)) = target(&req) else {
        return respond(r, 404, "text/plain", vec![], &[]);
    };
    let size = query(&req, "s").and_then(|s| s.parse::<i32>().ok()).unwrap_or(360).clamp(64, 1600);
    let fill = query(&req, "c").as_deref() == Some("1");
    submit(Box::new(move || {
        let key = if edited { format!("r{id}") } else { id };
        match cached_shell_jpeg_mode(&dirs().thumbs, &key, &p, size, 88, fill) {
            Some(b) => respond(r, 200, "image/jpeg", b, &[]),
            None => respond(r, 404, "text/plain", vec![], &[]),
        }
    }));
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

fn foto_protocol(req: Request<Vec<u8>>, r: UriSchemeResponder) {
    let Some((id, p, _)) = target(&req) else {
        return respond(r, 404, "text/plain", vec![], &[]);
    };
    let ext = scan::ext_of(&p);
    if !NATIVE.contains(&ext.as_str()) {
        // HEIC, TIFF, RAW…: o navegador não abre, então vai a versão grande do Shell.
        return submit(Box::new(move || match cached_shell_jpeg(&dirs().full, &id, &p, 2560, 92) {
            Some(b) => respond(r, 200, "image/jpeg", b, &[]),
            None => respond(r, 404, "text/plain", vec![], &[]),
        }));
    }
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    std::thread::spawn(move || {
        let Ok(mut f) = fs::File::open(&p) else {
            return respond(r, 404, "text/plain", vec![], &[]);
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let m = mime(&ext);
        if let Some(range) = range.as_deref().and_then(|s| s.strip_prefix("bytes=")) {
            let (a, b) = range.split_once('-').unwrap_or((range, ""));
            let start: u64 = a.parse().unwrap_or(0).min(len.saturating_sub(1));
            let end: u64 = b.parse().unwrap_or(start + 4 * 1024 * 1024 - 1).min(start + 8 * 1024 * 1024 - 1).min(len.saturating_sub(1));
            let mut buf = vec![0u8; (end - start + 1) as usize];
            let _ = f.seek(SeekFrom::Start(start));
            let _ = f.read_exact(&mut buf);
            return respond(
                r,
                206,
                m,
                buf,
                &[("Accept-Ranges", "bytes".into()), ("Content-Range", format!("bytes {start}-{end}/{len}"))],
            );
        }
        let mut buf = Vec::with_capacity(len as usize);
        let _ = f.read_to_end(&mut buf);
        respond(r, 200, m, buf, &[("Accept-Ranges", "bytes".into())]);
    });
}

// ---------- comandos ----------

#[tauri::command]
fn load_state() -> Value {
    fs::read(dirs().root.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null)
}

#[tauri::command]
fn save_state(state: Value) -> Result<(), String> {
    // Uma gravação por vez; cada uma com o seu temporário. Antes todas usavam "state.tmp" e,
    // quando duas se cruzavam ou o Windows segurava o arquivo, o rename falhava em silêncio
    // e as exclusões feitas depois se perdiam.
    static LOCK: Mutex<()> = Mutex::new(());
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = dirs().root.join("state.json");
    let tmp = dirs().root.join(format!("state.{}.tmp", SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let bytes = serde_json::to_vec(&state).map_err(|e| e.to_string())?;
    fs::write(&tmp, &bytes).map_err(|e| log_err(format!("gravar temporário: {e}")))?;
    let mut last = String::new();
    for i in 0..8 {
        match fs::rename(&tmp, &file) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(60 * (i + 1)));
            }
        }
    }
    // último recurso: escreve direto por cima
    let r = fs::write(&file, &bytes).map_err(|e| log_err(format!("rename falhou ({last}) e escrita direta também: {e}")));
    let _ = fs::remove_file(&tmp);
    r
}

fn log_err(msg: String) -> String {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dirs().root.join("erros.log")) {
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
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
fn cached_index() -> Vec<Item> {
    let items = scan::load_index(&dirs().root.join("index.json"));
    remember(&items);
    items
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

#[tauri::command]
fn trash_files(ids: Vec<String>) -> Result<usize, String> {
    let list: Vec<PathBuf> = ids.iter().filter_map(|id| path_of(id).ok()).collect();
    trash::delete_all(&list).map_err(|e| e.to_string())?;
    let mut m = paths().write().unwrap();
    for id in &ids {
        m.remove(id);
        let _ = fs::remove_file(render_of(id));
    }
    Ok(list.len())
}

#[tauri::command]
fn reveal(id: String) -> Result<(), String> {
    let p = path_of(&id)?;
    std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_with_default(id: String) -> Result<(), String> {
    let p = path_of(&id)?;
    std::process::Command::new("explorer").arg(p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("explorer").arg(path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_render(id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.split(',').next_back().unwrap_or("")).map_err(|e| e.to_string())?;
    fs::write(render_of(&id), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_render(id: String) {
    let _ = fs::remove_file(render_of(&id));
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
    let mut n = 0;
    for (id, edited) in items {
        let orig = path_of(&id)?;
        let stem = orig.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(id.clone());
        let (src, stem, ext) = if edited && render_of(&id).exists() {
            (render_of(&id), format!("{stem} (editada)"), "jpg".to_string())
        } else {
            (orig.clone(), stem, scan::ext_of(&orig))
        };
        if fs::copy(&src, unique(&dest, &stem, &ext)).is_ok() {
            n += 1;
        }
    }
    let _ = std::process::Command::new("explorer").arg(&dest).spawn();
    Ok(Some(n))
}

#[tauri::command]
async fn set_wallpaper(id: String, edited: bool) -> Result<(), String> {
    let p = if edited && render_of(&id).exists() { render_of(&id) } else { path_of(&id)? };
    let ext = scan::ext_of(&p);
    let file = if ["jpg", "jpeg", "png", "bmp"].contains(&ext.as_str()) {
        p
    } else {
        let jpg = tauri::async_runtime::spawn_blocking(move || cached_shell_jpeg(&dirs().full, &id, &p, 2560, 92))
            .await
            .ok()
            .flatten()
            .ok_or("Não foi possível converter a imagem")?;
        let f = dirs().root.join("papel-de-parede.jpg");
        fs::write(&f, jpg).map_err(|e| e.to_string())?;
        f
    };
    shell::set_wallpaper(&file.to_string_lossy()).then_some(()).ok_or_else(|| "O Windows recusou o papel de parede".into())
}

#[tauri::command]
async fn verify_user(message: String) -> String {
    tauri::async_runtime::spawn_blocking(move || shell::verify(&message).to_string()).await.unwrap_or_else(|_| "unavailable".into())
}

/// Copia arquivos/pastas arrastados para `<dest>\Importados\<data>`; devolve quantos entraram.
#[tauri::command]
async fn import_paths(paths: Vec<String>, dest: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let day = chrono::Local::now().format("%Y-%m-%d").to_string();
        let target = Path::new(&dest).join("Importados").join(day);
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        let mut n = 0;
        for p in paths {
            for e in walkdir::WalkDir::new(&p).into_iter().flatten().filter(|e| e.file_type().is_file()) {
                let ext = scan::ext_of(e.path());
                if !scan::PHOTO_EXT.contains(&ext.as_str()) && !scan::VIDEO_EXT.contains(&ext.as_str()) {
                    continue;
                }
                let stem = e.path().file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if fs::copy(e.path(), unique(&target, &stem, &ext)).is_ok() {
                    n += 1;
                }
            }
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- abrir um arquivo (Fotos como app padrão) ----------

static LAUNCH: Mutex<Option<String>> = Mutex::new(None);

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
    LAUNCH.lock().unwrap().take()
}

/// O arquivo e as fotos/vídeos da mesma pasta, em ordem de nome, como no visualizador do Windows.
#[tauri::command]
async fn open_file(path: String) -> Result<(Vec<Item>, usize), String> {
    tauri::async_runtime::spawn_blocking(move || {
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
            if key == target.to_string_lossy().to_lowercase() {
                index = items.len();
            }
            items.push(match cache.get(&key) {
                Some(c) if c.size == md.len() && c.mtime == mtime => c.clone(),
                _ => scan::read_item(&p, md.len(), mtime, md.created().map(scan::secs).unwrap_or(mtime)),
            });
        }
        remember(&items);
        Ok((items, index))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn default_status() -> assoc::Status {
    assoc::status()
}

#[tauri::command]
fn open_default_settings() {
    let _ = assoc::register();
    assoc::open_settings();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    *LAUNCH.lock().unwrap() = media_arg(&args);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            if let Some(f) = media_arg(&argv) {
                let _ = app.emit("open-file", f);
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
            // mantém o registro de "app de fotos e vídeos" apontando para este .exe
            std::thread::spawn(|| {
                let _ = assoc::register();
            });
            // Garante que a janela aparece mesmo se a interface demorar.
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
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
            open_path,
            save_render,
            delete_render,
            export_items,
            set_wallpaper,
            verify_user,
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

/// Encerra o processo na hora ao fechar o app. A saída normal do Windows (ExitProcess) espera os
/// provedores de miniatura do Shell que ainda estão trabalhando nas threads da fila e às vezes
/// travava por minutos: o processo ficava vivo e invisível, segurando a "instância única", e todo
/// duplo clique numa imagem era entregue a ele — nada abria. O estado já foi gravado antes
/// (a janela só fecha depois do flushSave) e o índice é gravado por rename atômico.
fn encerrar_agora() {
    use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
    unsafe {
        let _ = TerminateProcess(GetCurrentProcess(), 0);
    }
}
