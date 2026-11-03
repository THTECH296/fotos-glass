// Indexação da biblioteca: percorre as pastas, lê EXIF/datas e guarda um índice em disco
// para a próxima abertura ser instantânea (só arquivos novos ou alterados são lidos de novo).

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// Tudo o que o Fotos do Windows abre (com as extensões de imagem HEIF/AVIF/WebP/JPEG XL/RAW da Store).
/// O que o navegador não decodifica sozinho passa pelo Shell do Windows (miniatura e versão grande).
pub const PHOTO_EXT: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "jfi", "jif", "png", "apng", "gif", "bmp", "dib", "rle", "tif",
    "tiff", "heic", "heif", "hif", "avif", "webp", "jxr", "wdp", "hdp", "jxl", "ico", "dds", "dng",
    "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef",
    "ptx", "srw", "x3f", "3fr", "fff", "iiq", "mef", "mos", "erf", "kdc", "dcr", "dcs", "drf",
    "k25", "mrw", "mdc", "raw", "rwz", "cap", "eip", "bay", "ari", "ori", "pxn",
];
pub const VIDEO_EXT: &[&str] = &[
    "mp4", "m4v", "mov", "wmv", "asf", "avi", "mkv", "webm", "3gp", "3g2", "mts", "m2ts",
    "mpg", "mpeg", "vob",
];
/// Vídeos que o WebView2 toca. Só esses são registrados como "abre com o Fotos": os outros
/// mostrariam "Abrir no Player", que voltaria a abrir o próprio Fotos (ciclo).
pub const VIDEO_PLAYABLE: &[&str] = &["mp4", "m4v", "mov", "webm"];

/// Arquivo "só online" do OneDrive (Arquivos sob Demanda) ou offline: ler o conteúdo dispara o download.
const NUVEM_ATTRS: u32 = 0x1000 /* OFFLINE */ | 0x4_0000 /* RECALL_ON_OPEN */ | 0x40_0000 /* RECALL_ON_DATA_ACCESS */;

pub fn so_na_nuvem(md: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & NUVEM_ATTRS != 0
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Item {
    pub id: String,
    pub path: String,
    pub name: String,
    pub dir: String,
    pub fmt: String,
    #[serde(default)]
    pub video: bool,
    /// Data/hora local sem fuso: "2024-03-05T14:22:10"
    pub date: String,
    #[serde(default)]
    pub w: u32,
    #[serde(default)]
    pub h: u32,
    pub size: u64,
    pub mtime: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fnum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focal: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f35: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ev: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dur: Option<f64>,
}

/// FNV-1a do caminho em minúsculas: id estável entre execuções.
pub fn id_for(path: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_string_lossy().to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn iso(d: NaiveDateTime) -> String {
    d.format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn load_index(file: &Path) -> Vec<Item> {
    fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn scan(app: &AppHandle, folders: &[String], index_file: &Path) -> Vec<Item> {
    // dois scans ao mesmo tempo (rescan + import + abrir arquivo) disputariam o index.json
    static UM_POR_VEZ: Mutex<()> = Mutex::new(());
    let _g = UM_POR_VEZ.lock().unwrap_or_else(|e| e.into_inner());
    let cache: HashMap<String, Item> = load_index(index_file).into_iter().map(|i| (i.path.clone(), i)).collect();

    // Lista de arquivos (sem repetir quando uma pasta está dentro de outra).
    let mut seen = HashSet::new();
    let mut files: Vec<(PathBuf, u64, i64, i64, bool)> = Vec::new();
    for folder in folders {
        let walker = walkdir::WalkDir::new(folder).follow_links(false).into_iter().filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            e.depth() == 0 || !(n.starts_with('.') || n.starts_with('$') || n == "node_modules" || n == "Thumbs")
        });
        for e in walker.flatten() {
            if !e.file_type().is_file() {
                continue;
            }
            let p = e.path();
            let ext = ext_of(p);
            if !PHOTO_EXT.contains(&ext.as_str()) && !VIDEO_EXT.contains(&ext.as_str()) {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            // vazio não é foto; ícones minúsculos saem pelo filtro de largura (< 48 px) mais abaixo
            if md.len() == 0 {
                continue;
            }
            let key = p.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let mtime = md.modified().map(secs).unwrap_or(0);
            let ctime = md.created().map(secs).unwrap_or(mtime);
            files.push((p.to_path_buf(), md.len(), mtime, ctime, so_na_nuvem(&md)));
        }
    }

    let total = files.len();
    let done = AtomicUsize::new(0);
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Item>> = Mutex::new(Vec::with_capacity(total));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    let _ = app.emit("scan-progress", (0usize, total));

    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                crate::shell::com_init();
                let mut local = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let (p, size, mtime, ctime, nuvem) = &files[i];
                    let key = p.to_string_lossy().to_string();
                    let item = match cache.get(&key) {
                        Some(c) if c.size == *size && c.mtime == *mtime => c.clone(),
                        _ => read_item(p, *size, *mtime, *ctime, *nuvem),
                    };
                    if item.video || (item.w == 0 || item.w >= 48) {
                        local.push(item);
                    }
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if d.is_multiple_of(150) {
                        let _ = app.emit("scan-progress", (d, total));
                    }
                }
                out.lock().unwrap().extend(local);
            });
        }
    });

    let mut items = out.into_inner().unwrap();
    items.sort_by(|a, b| a.date.cmp(&b.date).then(a.name.cmp(&b.name)));
    if let Ok(json) = serde_json::to_vec(&items) {
        let tmp = index_file.with_extension(format!("{}.tmp", std::process::id()));
        if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, index_file).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
    let _ = app.emit("scan-progress", (total, total));
    items
}

/// `nuvem`: arquivo só online do OneDrive; não lê o conteúdo (baixaria o arquivo), só o que o Shell já sabe.
pub fn read_item(p: &Path, size: u64, mtime: i64, ctime: i64, nuvem: bool) -> Item {
    // um arquivo malformado não pode derrubar o scan (os parsers de EXIF/tamanho já tiveram pânicos)
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_item_inner(p, size, mtime, ctime, nuvem))).unwrap_or_else(|_| {
        let mut it = base_item(p, size, mtime);
        it.date = iso(data_pelo_nome(&it.name).unwrap_or_else(|| fallback_date(mtime, ctime)));
        it
    })
}

/// Data de criação inválida (0 = 1601, comum em SMB/zip) não pode puxar a foto para 1970.
fn fallback_date(mtime: i64, ctime: i64) -> NaiveDateTime {
    local_naive([mtime, ctime].into_iter().filter(|&t| t > 0).min().unwrap_or(0))
}

fn read_item_inner(p: &Path, size: u64, mtime: i64, ctime: i64, nuvem: bool) -> Item {
    let mut it = base_item(p, size, mtime);
    let video = it.video;

    let mut date: Option<NaiveDateTime>;
    if video {
        // a data de gravação vem antes do nome: o Pixel põe a hora UTC no nome (PXL_...)
        let (dur, enc, w, h) = if nuvem { crate::shell::props_rapidas(&it.path, true) } else { crate::shell::video_props(&it.path) };
        it.dur = dur;
        it.w = w;
        it.h = h;
        date = enc.map(local_naive);
    } else if nuvem {
        let (_, taken, w, h) = crate::shell::props_rapidas(&it.path, false);
        it.w = w;
        it.h = h;
        date = taken.map(local_naive);
    } else {
        if let Ok(sz) = imagesize::size(p) {
            it.w = sz.width as u32;
            it.h = sz.height as u32;
        }
        date = read_exif(p, &mut it);
    }
    if date.is_none() {
        date = data_pelo_nome(&it.name);
    }
    it.date = iso(date.unwrap_or_else(|| fallback_date(mtime, ctime)));
    it
}

fn base_item(p: &Path, size: u64, mtime: i64) -> Item {
    let ext = ext_of(p);
    Item {
        id: id_for(p),
        path: p.to_string_lossy().to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        dir: p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
        fmt: match ext.as_str() {
            "jpg" | "jpeg" | "jpe" | "jfif" | "jfi" | "jif" => "JPEG".into(),
            "heic" | "heif" | "hif" => "HEIF".into(),
            "tif" | "tiff" => "TIFF".into(),
            "jxr" | "wdp" | "hdp" => "JPEG XR".into(),
            "dib" | "rle" => "BMP".into(),
            "apng" => "PNG".into(),
            e => e.to_uppercase(),
        },
        video: VIDEO_EXT.contains(&ext.as_str()),
        size,
        mtime,
        ..Default::default()
    }
}

pub fn local_naive(unix: i64) -> NaiveDateTime {
    DateTime::from_timestamp(unix, 0)
        .map(|d| d.with_timezone(&Local).naive_local())
        .unwrap_or_default()
}

// ---------- EXIF ----------

fn field(ex: &exif::Exif, t: exif::Tag) -> Option<&exif::Field> {
    ex.get_field(t, exif::In::PRIMARY)
}
fn ascii(ex: &exif::Exif, t: exif::Tag) -> Option<String> {
    match &field(ex, t)?.value {
        exif::Value::Ascii(v) if !v.is_empty() => {
            let s = String::from_utf8_lossy(&v[0]).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}
fn rat(ex: &exif::Exif, t: exif::Tag) -> Option<f64> {
    match &field(ex, t)?.value {
        exif::Value::Rational(v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
        exif::Value::SRational(v) if !v.is_empty() && v[0].denom != 0 => Some(v[0].to_f64()),
        _ => None,
    }
}
fn uint(ex: &exif::Exif, t: exif::Tag) -> Option<u32> {
    field(ex, t)?.value.get_uint(0)
}
fn dms(ex: &exif::Exif, t: exif::Tag, r: exif::Tag, neg: &str) -> Option<f64> {
    let v = match &field(ex, t)?.value {
        exif::Value::Rational(v) if v.len() >= 3 => v.iter().map(|x| if x.denom == 0 { 0.0 } else { x.to_f64() }).collect::<Vec<_>>(),
        _ => return None,
    };
    let mut d = v[0] + v[1] / 60.0 + v[2] / 3600.0;
    if ascii(ex, r).map(|s| s.eq_ignore_ascii_case(neg)).unwrap_or(false) {
        d = -d;
    }
    Some(d)
}

fn read_exif(p: &Path, it: &mut Item) -> Option<NaiveDateTime> {
    use exif::Tag;
    // TIFF e quase todo RAW (DNG, CR2, NEF, ARW…) são TIFF por dentro, e aí o kamadak-exif lê o arquivo
    // inteiro (25–150 MB, em até 8 threads). Os IFDs ficam no começo: lê só os primeiros 2 MB e, se o
    // parser reclamar de IFD cortado, tenta 16 MB. Mais que isso fica sem EXIF.
    let head = |n: u64| -> Option<Vec<u8>> {
        let mut b = Vec::new();
        File::open(p).ok()?.take(n).read_to_end(&mut b).ok()?;
        Some(b)
    };
    let first = head(2 * 1024 * 1024)?;
    let ex = if first.starts_with(b"II*\0") || first.starts_with(b"MM\0*") {
        let big = first.len() as u64 >= 2 * 1024 * 1024;
        match exif::Reader::new().read_raw(first) {
            Ok(ex) => ex,
            Err(_) if big => exif::Reader::new().read_raw(head(16 * 1024 * 1024)?).ok()?,
            Err(_) => return None,
        }
    } else {
        let f = File::open(p).ok()?;
        exif::Reader::new().read_from_container(&mut BufReader::new(f)).ok()?
    };

    it.make = ascii(&ex, Tag::Make);
    it.model = ascii(&ex, Tag::Model);
    it.lens = ascii(&ex, Tag::LensModel);
    it.iso = uint(&ex, Tag::PhotographicSensitivity);
    it.fnum = rat(&ex, Tag::FNumber);
    it.focal = rat(&ex, Tag::FocalLength);
    it.f35 = uint(&ex, Tag::FocalLengthIn35mmFilm);
    it.ev = rat(&ex, Tag::ExposureBiasValue);
    if let Some(exif::Value::Rational(v)) = field(&ex, Tag::ExposureTime).map(|f| &f.value) {
        if let Some(r) = v.first() {
            if r.num > 0 && r.denom > r.num {
                it.exp = Some(format!("1/{}", (r.denom as f64 / r.num as f64).round()));
            } else if r.denom > 0 {
                it.exp = Some(format!("{}", (r.to_f64() * 10.0).round() / 10.0));
            }
        }
    }
    if it.w == 0 {
        it.w = uint(&ex, Tag::PixelXDimension).unwrap_or(0);
        it.h = uint(&ex, Tag::PixelYDimension).unwrap_or(0);
    }
    if matches!(uint(&ex, Tag::Orientation), Some(5..=8)) && it.fmt != "HEIF" {
        std::mem::swap(&mut it.w, &mut it.h);
    }
    let lat = dms(&ex, Tag::GPSLatitude, Tag::GPSLatitudeRef, "S");
    let lon = dms(&ex, Tag::GPSLongitude, Tag::GPSLongitudeRef, "W");
    if let (Some(a), Some(b)) = (lat, lon) {
        if (a.abs() > 0.0001 || b.abs() > 0.0001) && a.abs() <= 90.0 && b.abs() <= 180.0 {
            it.lat = Some(a);
            it.lon = Some(b);
        }
    }
    let raw = ascii(&ex, Tag::DateTimeOriginal)
        .or_else(|| ascii(&ex, Tag::DateTimeDigitized))
        .or_else(|| ascii(&ex, Tag::DateTime))?;
    NaiveDateTime::parse_from_str(raw.get(..19)?, "%Y:%m:%d %H:%M:%S").ok()
}

// ---------- data pelo nome do arquivo (IMG_20240305_142210, WhatsApp Image 2024-03-05 at 14.22.10 ...) ----------

fn digits(b: &[u8], p: &mut usize, n: usize) -> Option<u32> {
    if *p + n > b.len() || !b[*p..*p + n].iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let v = std::str::from_utf8(&b[*p..*p + n]).ok()?.parse().ok()?;
    *p += n;
    Some(v)
}
fn sep(b: &[u8], p: &mut usize) {
    if *p < b.len() && matches!(b[*p], b'-' | b'_' | b'.' | b' ') {
        *p += 1;
    }
}

fn try_at(b: &[u8], i: usize) -> Option<NaiveDateTime> {
    let mut p = i;
    let y = digits(b, &mut p, 4)?;
    if !(1990..=2099).contains(&y) {
        return None;
    }
    sep(b, &mut p);
    let m = digits(b, &mut p, 2)?;
    sep(b, &mut p);
    let d = digits(b, &mut p, 2)?;
    let date = NaiveDate::from_ymd_opt(y as i32, m, d)?;
    // hora (opcional)
    let mut q = p;
    for _ in 0..4 {
        if q < b.len() && matches!(b[q], b' ' | b'_' | b'-' | b'T' | b'a' | b't') {
            q += 1;
        }
    }
    let time = (|| {
        let h = digits(b, &mut q, 2)?;
        sep(b, &mut q);
        let mi = digits(b, &mut q, 2)?;
        sep(b, &mut q);
        let s = digits(b, &mut q, 2).unwrap_or(0);
        date.and_hms_opt(h, mi, s)
    })();
    if time.is_none() && p < b.len() && b[p].is_ascii_digit() {
        return None;
    }
    Some(time.unwrap_or_else(|| date.and_hms_opt(12, 0, 0).unwrap()))
}

pub fn date_from_name(name: &str) -> Option<NaiveDateTime> {
    let b = name.as_bytes();
    (0..b.len()).filter(|&i| i == 0 || !b[i - 1].is_ascii_digit()).find_map(|i| try_at(b, i))
}

/// Como `date_from_name`, mas o Pixel (Google Camera) grava a hora UTC no nome: converte para local.
fn data_pelo_nome(name: &str) -> Option<NaiveDateTime> {
    let d = date_from_name(name)?;
    if name.starts_with("PXL_") {
        return Some(d.and_utc().with_timezone(&Local).naive_local());
    }
    Some(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(name: &str) -> Option<String> {
        date_from_name(name).map(iso)
    }

    #[test]
    fn datas_pelo_nome() {
        assert_eq!(d("IMG_20240305_142210.jpg").as_deref(), Some("2024-03-05T14:22:10"));
        assert_eq!(d("VID_20231231_235959.mp4").as_deref(), Some("2023-12-31T23:59:59"));
        assert_eq!(d("PXL_20240101_120000123.jpg").as_deref(), Some("2024-01-01T12:00:00"));
        assert_eq!(d("WhatsApp Image 2024-03-05 at 14.22.10.jpeg").as_deref(), Some("2024-03-05T14:22:10"));
        assert_eq!(d("Screenshot_2022-07-01-09-08-07.png").as_deref(), Some("2022-07-01T09:08:07"));
        assert_eq!(d("Captura de tela 2024-02-29 101500.png").as_deref(), Some("2024-02-29T10:15:00"));
        assert_eq!(d("signal-2023-05-06-171819.jpg").as_deref(), Some("2023-05-06T17:18:19"));
        // só a data: meio-dia
        assert_eq!(d("Foto 2023-08-15.jpg").as_deref(), Some("2023-08-15T12:00:00"));
    }

    #[test]
    fn nomes_sem_data() {
        for n in ["DSC_2019.jpg", "IMG_9999.jpg", "1700000000000.jpg", "Foto 2023.jpg", "IMG_20230229_101010.jpg", "IMG_20241301_101010.jpg", "x.jpg", ""] {
            assert_eq!(d(n), None, "{n}");
        }
    }

    #[test]
    fn pixel_vem_em_utc() {
        let utc = date_from_name("PXL_20240101_120000123.mp4").unwrap();
        let local = data_pelo_nome("PXL_20240101_120000123.mp4").unwrap();
        assert_eq!(local, utc.and_utc().with_timezone(&Local).naive_local());
        assert_eq!(data_pelo_nome("IMG_20240101_120000.jpg"), date_from_name("IMG_20240101_120000.jpg"));
    }

    #[test]
    fn data_de_criacao_zerada_nao_vira_1970() {
        let m = 1_700_000_000;
        assert_eq!(fallback_date(m, 0), local_naive(m));
        assert_eq!(fallback_date(m, m - 10), local_naive(m - 10));
        assert_eq!(fallback_date(0, m), local_naive(m));
    }
}
