// Registro do Fotos no Windows como app de fotos e vídeos (só no usuário atual, sem administrador).
// O Windows 10/11 não deixa um app se tornar padrão sozinho: registramos as "capacidades" para o Fotos
// aparecer em Configurações > Aplicativos padrão e no "Abrir com", e o usuário confirma lá.

use crate::scan::{PHOTO_EXT, VIDEO_EXT, VIDEO_PLAYABLE};
use serde::Serialize;
use winreg::{enums::*, RegKey};

/// Nome no "Abrir com" e em Aplicativos padrão. Diferente de "Fotos" porque o Fotos da Microsoft usa
/// esse nome e o Windows junta os dois na lista.
pub const APP: &str = "Fotos Glass";
const PROG_PHOTO: &str = "Fotos.Imagem";
const PROG_VIDEO: &str = "Fotos.Video";
const CAPS: &str = r"Software\Fotos\Capabilities";

/// O exe que está rodando é o instalado (%LOCALAPPDATA%\Fotos\fotos.exe)? Builds de teste e cópias
/// soltas não podem se registrar: o registro passaria a apontar para elas (já apontou para fotos-build).
pub fn instalado() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    let (Ok(exe), Some(local)) = (std::env::current_exe(), std::env::var_os("LOCALAPPDATA")) else {
        return false;
    };
    let esperado = std::path::Path::new(&local).join("Fotos").join("fotos.exe");
    exe.to_string_lossy().to_lowercase() == esperado.to_string_lossy().to_lowercase()
}

pub fn register() -> std::io::Result<()> {
    if !instalado() {
        return Ok(());
    }
    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy();
    let open = format!("\"{exe}\" \"%1\"");
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = hkcu.create_subkey(r"Software\Classes")?.0;

    for (prog, name, icon) in [(PROG_PHOTO, "Imagem (Fotos Glass)", 0), (PROG_VIDEO, "Vídeo (Fotos Glass)", 0)] {
        let (k, _) = classes.create_subkey(prog)?;
        k.set_value("", &name)?;
        k.set_value("FriendlyTypeName", &name)?;
        k.create_subkey("DefaultIcon")?.0.set_value("", &format!("\"{exe}\",{icon}"))?;
        let (cmd, _) = k.create_subkey(r"shell\open\command")?;
        cmd.set_value("", &open)?;
        k.create_subkey(r"shell\open")?.0.set_value("FriendlyAppName", &APP)?;
    }

    // "Abrir com" e o nome bonito na lista
    let (app, _) = classes.create_subkey(r"Applications\fotos.exe")?;
    app.set_value("FriendlyAppName", &APP)?;
    app.create_subkey(r"shell\open\command")?.0.set_value("", &open)?;
    let (types, _) = app.create_subkey("SupportedTypes")?;

    let (caps, _) = hkcu.create_subkey(CAPS)?;
    caps.set_value("ApplicationName", &APP)?;
    caps.set_value("ApplicationDescription", &"Suas fotos e vídeos, no estilo do iPhone.")?;
    caps.set_value("ApplicationIcon", &format!("\"{exe}\",0"))?;
    let (fa, _) = caps.create_subkey("FileAssociations")?;

    for (exts, prog) in [(PHOTO_EXT, PROG_PHOTO), (VIDEO_PLAYABLE, PROG_VIDEO)] {
        for e in exts {
            let ext = format!(".{e}");
            fa.set_value(&ext, &prog)?;
            types.set_value(&ext, &"")?;
            classes.create_subkey(format!(r"{ext}\OpenWithProgids"))?.0.set_value(prog, &"")?;
        }
    }
    // Vídeos que o WebView2 não toca (MKV, AVI, WMV…) saem do registro: o Fotos só mostraria
    // "Abrir no Player", que abriria o Fotos de novo. As versões até a 1.1.3 registravam todos.
    for e in VIDEO_EXT.iter().filter(|e| !VIDEO_PLAYABLE.contains(e)) {
        let ext = format!(".{e}");
        let _ = fa.delete_value(&ext);
        let _ = types.delete_value(&ext);
        if let Ok(k) = classes.open_subkey_with_flags(format!(r"{ext}\OpenWithProgids"), KEY_ALL_ACCESS) {
            let _ = k.delete_value(PROG_VIDEO);
        }
    }
    let (reg, _) = hkcu.create_subkey(r"Software\RegisteredApplications")?;
    let _ = reg.delete_value("Fotos"); // nome da 1ª versão
    reg.set_value(APP, &CAPS)?;
    notify();
    Ok(())
}

fn notify() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
}

#[derive(Serialize)]
pub struct Status {
    photos: bool,
    videos: bool,
}

/// O Fotos é o padrão hoje? (olha a escolha do usuário para .jpg e .mp4)
pub fn status() -> Status {
    Status { photos: user_choice(".jpg") == PROG_PHOTO, videos: user_choice(".mp4") == PROG_VIDEO }
}

fn user_choice(ext: &str) -> String {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{ext}\UserChoice"))
        .and_then(|k| k.get_value::<String, _>("ProgId"))
        .unwrap_or_default()
}

/// O app padrão desta extensão é o próprio Fotos? ("Abrir com o App Padrão" o reabriria.)
pub fn padrao_e_fotos(ext: &str) -> bool {
    let p = user_choice(&format!(".{ext}")).to_lowercase();
    p == PROG_PHOTO.to_lowercase() || p == PROG_VIDEO.to_lowercase() || p.ends_with("fotos.exe")
}

/// Abre Configurações > Aplicativos padrão já na página do Fotos.
pub fn open_settings() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd")
        .args(["/c", "start", "", &format!("ms-settings:defaultapps?registeredAppUser={APP}")])
        .creation_flags(0x0800_0000)
        .spawn();
}
