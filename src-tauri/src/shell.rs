// Tudo que usa o Shell do Windows: miniaturas (o mesmo cache do Explorador, então HEIC, RAW
// e vídeo funcionam se o Windows souber abrir), propriedades de vídeo, papel de parede e Windows Hello.

use std::ffi::c_void;
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ},
        Storage::EnhancedStorage::{PKEY_Media_DateEncoded, PKEY_Media_Duration, PKEY_Video_FrameHeight, PKEY_Video_FrameWidth},
        System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
        UI::{
            Shell::{IShellItem2, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_RESIZETOFIT, SIIGBF_THUMBNAILONLY},
            WindowsAndMessaging::{SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER},
        },
    },
};

thread_local! { static COM: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

pub fn com_init() {
    COM.with(|c| {
        if !c.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            c.set(true);
        }
    });
}

/// Miniatura em RGB (sem alfa; transparência vira branco). Cabe numa caixa `size`×`size`.
pub fn thumbnail_rgb(path: &str, size: i32) -> Option<(u32, u32, Vec<u8>)> {
    com_init();
    unsafe { image(path, size, SIIGBF_THUMBNAILONLY).or_else(|| image(path, size, SIIGBF_RESIZETOFIT)) }
}

unsafe fn image(path: &str, size: i32, flags: SIIGBF) -> Option<(u32, u32, Vec<u8>)> {
    let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
    let hbmp = factory.GetImage(SIZE { cx: size, cy: size }, flags).ok()?;
    let mut bm = BITMAP::default();
    GetObjectW(HGDIOBJ(hbmp.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void));
    let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
    if w <= 0 || h <= 0 {
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        return None;
    }
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(None);
    let read = GetDIBits(hdc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
    ReleaseDC(None, hdc);
    let _ = DeleteObject(HGDIOBJ(hbmp.0));
    if read == 0 {
        return None;
    }

    // BGRA (às vezes pré-multiplicado) → RGB sobre branco
    let has_alpha = buf.chunks(4).any(|p| p[3] != 0) && buf.chunks(4).any(|p| p[3] != 255);
    let premultiplied = has_alpha && buf.chunks(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in buf.chunks(4) {
        let a = p[3] as u32;
        for c in [p[2], p[1], p[0]] {
            let c = c as u32;
            let v = if !has_alpha {
                c
            } else if premultiplied {
                c + (255 - a)
            } else {
                (c * a + 255 * (255 - a)) / 255
            };
            rgb.push(v.min(255) as u8);
        }
    }
    Some((w as u32, h as u32, rgb))
}

/// Reduz para caber em `max`×`max` com média de área (nítido, sem serrilhado). Menor que isso, devolve igual.
pub fn shrink(w: u32, h: u32, rgb: Vec<u8>, max: u32) -> (u32, u32, Vec<u8>) {
    let k = max as f64 / w.max(h) as f64;
    if k >= 0.999 {
        return (w, h, rgb);
    }
    let (nw, nh) = (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1));
    let mut out = vec![0u8; (nw * nh * 3) as usize];
    let (fx, fy) = (w as f64 / nw as f64, h as f64 / nh as f64);
    for y in 0..nh {
        let y0 = (y as f64 * fy) as u32;
        let y1 = (((y + 1) as f64 * fy).ceil() as u32).min(h).max(y0 + 1);
        for x in 0..nw {
            let x0 = (x as f64 * fx) as u32;
            let x1 = (((x + 1) as f64 * fx).ceil() as u32).min(w).max(x0 + 1);
            let mut acc = [0u32; 3];
            for sy in y0..y1 {
                let row = (sy * w) as usize * 3;
                for sx in x0..x1 {
                    let i = row + sx as usize * 3;
                    acc[0] += rgb[i] as u32;
                    acc[1] += rgb[i + 1] as u32;
                    acc[2] += rgb[i + 2] as u32;
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((y * nw + x) * 3) as usize;
            for c in 0..3 {
                out[o + c] = ((acc[c] + n / 2) / n) as u8;
            }
        }
    }
    (nw, nh, out)
}

/// Quadrado do meio da imagem (para miniaturas que preenchem a grade).
pub fn crop_square(w: u32, h: u32, rgb: &[u8]) -> (u32, u32, Vec<u8>) {
    let side = w.min(h);
    let (x0, y0) = ((w - side) / 2, (h - side) / 2);
    let mut out = Vec::with_capacity((side * side * 3) as usize);
    for y in y0..y0 + side {
        let a = ((y * w + x0) * 3) as usize;
        out.extend_from_slice(&rgb[a..a + (side * 3) as usize]);
    }
    (side, side, out)
}

pub fn jpeg(w: u32, h: u32, rgb: &[u8], quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, quality);
    enc.encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).ok()?;
    Some(out)
}

/// (duração em segundos, data de gravação em unix, largura, altura)
pub fn video_props(path: &str) -> (Option<f64>, Option<i64>, u32, u32) {
    com_init();
    unsafe {
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem2>(&HSTRING::from(path), None) else {
            return (None, None, 0, 0);
        };
        let dur = item.GetUInt64(&PKEY_Media_Duration).ok().map(|d| d as f64 / 10_000_000.0);
        let enc = item.GetFileTime(&PKEY_Media_DateEncoded).ok().and_then(|ft| {
            let t = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
            (t > 116_444_736_000_000_000).then(|| ((t - 116_444_736_000_000_000) / 10_000_000) as i64)
        });
        let w = item.GetUInt32(&PKEY_Video_FrameWidth).unwrap_or(0);
        let h = item.GetUInt32(&PKEY_Video_FrameHeight).unwrap_or(0);
        (dur, enc, w, h)
    }
}

/// Como `video_props`, mas só com o que o Shell/provedor já tem guardado (GPS_FASTPROPERTIESONLY):
/// não abre o arquivo, então não baixa o que está só na nuvem do OneDrive. Para foto, a data é a
/// "Data da foto" (System.Photo.DateTaken) e as dimensões vêm de System.Image.
pub fn props_rapidas(path: &str, video: bool) -> (Option<f64>, Option<i64>, u32, u32) {
    use windows::Win32::{
        Storage::EnhancedStorage::{PKEY_Image_HorizontalSize, PKEY_Image_VerticalSize, PKEY_Photo_DateTaken},
        System::{
            Com::StructuredStorage::{PropVariantClear, PropVariantToFileTime, PropVariantToUInt32, PropVariantToUInt64, PROPVARIANT},
            Variant::PSTF_UTC,
        },
        UI::Shell::PropertiesSystem::{IPropertyStore, GPS_FASTPROPERTIESONLY},
    };
    com_init();
    unsafe {
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem2>(&HSTRING::from(path), None) else {
            return (None, None, 0, 0);
        };
        let Ok(store) = item.GetPropertyStore::<IPropertyStore>(GPS_FASTPROPERTIESONLY) else {
            return (None, None, 0, 0);
        };
        let ler = |k: &windows::Win32::Foundation::PROPERTYKEY, f: &dyn Fn(&PROPVARIANT) -> Option<u64>| {
            let mut v = store.GetValue(k).ok()?;
            let r = f(&v);
            let _ = PropVariantClear(&mut v);
            r
        };
        let num64 = |v: &PROPVARIANT| PropVariantToUInt64(v).ok();
        let num32 = |v: &PROPVARIANT| PropVariantToUInt32(v).ok().map(u64::from);
        let data = |v: &PROPVARIANT| {
            PropVariantToFileTime(v, PSTF_UTC).ok().map(|ft| ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64)
        };
        let unix = |t: u64| (t > 116_444_736_000_000_000).then(|| ((t - 116_444_736_000_000_000) / 10_000_000) as i64);
        if video {
            let dur = ler(&PKEY_Media_Duration, &num64).map(|d| d as f64 / 10_000_000.0);
            let enc = ler(&PKEY_Media_DateEncoded, &data).and_then(unix);
            let w = ler(&PKEY_Video_FrameWidth, &num32).unwrap_or(0) as u32;
            let h = ler(&PKEY_Video_FrameHeight, &num32).unwrap_or(0) as u32;
            (dur, enc, w, h)
        } else {
            let taken = ler(&PKEY_Photo_DateTaken, &data).and_then(unix);
            let w = ler(&PKEY_Image_HorizontalSize, &num32).unwrap_or(0) as u32;
            let h = ler(&PKEY_Image_VerticalSize, &num32).unwrap_or(0) as u32;
            (None, taken, w, h)
        }
    }
}

pub fn set_wallpaper(path: &str) -> bool {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            Some(PCWSTR(wide.as_ptr()).0 as *mut c_void),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
        .is_ok()
    }
}

/// Windows Hello: "ok" (verificado), "not_configured" (o PC não tem Hello/PIN: o app decide liberar),
/// ou recusa: "cancel", "busy", "policy", "error". Antes erro, política e ocupado viravam
/// "unavailable" e o frontend liberava os álbuns protegidos (falha aberta).
/// `hwnd`: janela dona do diálogo (0 = sem dona).
pub fn verify(message: &str, hwnd: isize) -> &'static str {
    use windows::Security::Credentials::UI::{UserConsentVerificationResult as R, UserConsentVerifier, UserConsentVerifierAvailability as A};
    use windows::Win32::{Foundation::HWND, System::WinRT::IUserConsentVerifierInterop};
    match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()) {
        Ok(A::Available) => {}
        Ok(A::DeviceNotPresent) | Ok(A::NotConfiguredForUser) => return "not_configured",
        Ok(A::DisabledByPolicy) => return "policy",
        Ok(A::DeviceBusy) => return "busy",
        _ => return "error",
    }
    // O tipo da operação (IAsyncOperation<UserConsentVerificationResult>) vem do crate windows-future;
    // em vez de depender dele, o tipo é inferido da versão sem janela, que não chega a ser chamada.
    fn pela_janela<T: windows::core::Interface>(
        _mesmo_tipo: fn(&HSTRING) -> windows::core::Result<T>,
        hwnd: isize,
        msg: &HSTRING,
    ) -> windows::core::Result<T> {
        let f = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        unsafe { f.RequestVerificationForWindowAsync(HWND(hwnd as *mut c_void), msg) }
    }
    let msg = HSTRING::from(message);
    // App Win32: com a janela dona o diálogo abre na frente do Fotos (sem ela pode abrir atrás ou falhar)
    let op = if hwnd != 0 {
        pela_janela(UserConsentVerifier::RequestVerificationAsync, hwnd, &msg).or_else(|_| UserConsentVerifier::RequestVerificationAsync(&msg))
    } else {
        UserConsentVerifier::RequestVerificationAsync(&msg)
    };
    match op.and_then(|op| op.get()) {
        Ok(R::Verified) => "ok",
        Ok(R::Canceled) | Ok(R::RetriesExhausted) => "cancel",
        Ok(R::DeviceBusy) => "busy",
        Ok(R::DisabledByPolicy) => "policy",
        Ok(R::DeviceNotPresent) | Ok(R::NotConfiguredForUser) => "not_configured",
        _ => "error",
    }
}

/// Abre um link https:// no navegador padrão (ShellExecute "open").
pub fn open_url(url: &str) -> bool {
    use windows::{
        core::w,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute devolve um "HINSTANCE" > 32 quando deu certo
    r.0 as isize > 32
}
