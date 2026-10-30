// Indexação da biblioteca: percorre as pastas, lê EXIF/datas e guarda um índice em disco
// para a próxima abertura ser instantânea (só arquivos novos ou alterados são lidos de novo).

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

pub const PHOTO_EXT: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff", "avif", "jxl", "dng", "cr2",
    "cr3", "nef", "arw", "raf", "orf", "rw2",
];
pub const VIDEO_EXT: &[&str] = &["mp4", "mov", "m4v", "avi", "mkv", "wmv", "webm", "3gp", "mts", "m2ts"];

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
    let cache: HashMap<String, Item> = load_index(index_file).into_iter().map(|i| (i.path.clone(), i)).collect();

    // Lista de arquivos (sem repetir quando uma pasta está dentro de outra).
    let mut seen = HashSet::new();
    let mut files: Vec<(PathBuf, u64, i64, i64)> = Vec::new();
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
            if md.len() < 4096 {
                continue;
            }
            let key = p.to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let mtime = md.modified().map(secs).unwrap_or(0);
            let ctime = md.created().map(secs).unwrap_or(mtime);
            files.push((p.to_path_buf(), md.len(), mtime, ctime));
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
                    let (p, size, mtime, ctime) = &files[i];
                    let key = p.to_string_lossy().to_string();
                    let item = match cache.get(&key) {
                        Some(c) if c.size == *size && c.mtime == *mtime => c.clone(),
                        _ => read_item(p, *size, *mtime, *ctime),
                    };
                    if item.video || (item.w == 0 || item.w >= 48) {
                        local.push(item);
                    }
                    let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if d % 150 == 0 {
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
        let tmp = index_file.with_extension("tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, index_file);
        }
    }
    let _ = app.emit("scan-progress", (total, total));
    items
}

pub fn read_item(p: &Path, size: u64, mtime: i64, ctime: i64) -> Item {
    let ext = ext_of(p);
    let video = VIDEO_EXT.contains(&ext.as_str());
    let mut it = Item {
        id: id_for(p),
        path: p.to_string_lossy().to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        dir: p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
        fmt: match ext.as_str() {
            "jpg" | "jpeg" => "JPEG".into(),
            "heic" | "heif" => "HEIF".into(),
            "tif" | "tiff" => "TIFF".into(),
            e => e.to_uppercase(),
        },
        video,
        size,
        mtime,
        ..Default::default()
    };

    let mut date: Option<NaiveDateTime> = None;
    if !video {
        if let Ok(sz) = imagesize::size(p) {
            it.w = sz.width as u32;
            it.h = sz.height as u32;
        }
        date = read_exif(p, &mut it);
    }
    if date.is_none() {
        date = date_from_name(&it.name);
    }
    if video {
        let (dur, enc, w, h) = crate::shell::video_props(&it.path);
        it.dur = dur;
        it.w = w;
        it.h = h;
        if date.is_none() {
            date = enc.map(|t| local_naive(t));
        }
    }
    let fallback = local_naive(mtime.min(ctime).max(0));
    it.date = iso(date.unwrap_or(fallback));
    it
}

pub fn local_naive(unix: i64) -> NaiveDateTime {
    DateTime::from_timestamp(unix, 0)
        .map(|d| d.with_timezone(&Local).naive_local())
        .unwrap_or_default()
}

// ---------- EXIF ----------

fn field<'a>(ex: &'a exif::Exif, t: exif::Tag) -> Option<&'a exif::Field> {
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
    let f = File::open(p).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut BufReader::new(f)).ok()?;

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
