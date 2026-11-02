# Instala o Fotos no AppData\Local de verdade e testa a abertura de imagens.
#
# Programas abertos de dentro do app do Claude (pacote MSIX) têm o AppData\Local virtualizado:
# o que eles gravam vai para Packages\Claude_...\LocalCache\Local, que o resto do Windows não vê.
# Este script roda por uma tarefa do Agendador, fora do pacote, e:
#   1. fecha o Fotos
#   2. instala a versão nova (os dados do usuário em br.com.fotos.app não são tocados)
#   3. manda para a Lixeira só a cópia virtual da INSTALAÇÃO (não os dados)
#   4. testa: abrir uma imagem com o app fechado, fechar, e abrir outra logo em seguida
param([string]$Instalador, [string]$Imagem1, [string]$Imagem2)

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'instalar-fora.log'
"inicio $(Get-Date)" | Out-File $log -Encoding utf8
function L($m) { "$(Get-Date -Format HH:mm:ss) $m" | Out-File $log -Append -Encoding utf8 }

$local = "$env:USERPROFILE\AppData\Local"
$exe = "$local\Fotos\fotos.exe"
$pacote = Get-ChildItem "$local\Packages" -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue | Select-Object -First 1
$virtual = if ($pacote) { "$($pacote.FullName)\LocalCache\Local" } else { $null }
L "versão real antes: $((Get-Item $exe -ErrorAction SilentlyContinue).VersionInfo.ProductVersion)"
L "state.json real: $((Get-Item "$local\br.com.fotos.app\state.json" -ErrorAction SilentlyContinue).LastWriteTime)"

# 1
Get-Process fotos -ErrorAction SilentlyContinue | ForEach-Object { L "fechando fotos $($_.Id) respondendo=$($_.Responding)"; $_ | Stop-Process -Force }
Start-Sleep 2

# 2
$p = Start-Process $Instalador -ArgumentList '/S' -Wait -PassThru
L "instalador saiu com $($p.ExitCode); versão real agora: $((Get-Item $exe).VersionInfo.ProductVersion)"

# 3
Add-Type -AssemblyName Microsoft.VisualBasic
if ($virtual -and (Test-Path "$virtual\Fotos")) {
    try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("$virtual\Fotos", 'OnlyErrorDialogs', 'SendToRecycleBin'); L "lixeira: instalação virtual" }
    catch { L "falhou lixeira: $($_.Exception.Message)" }
}

# 4
function Janela([int]$seg) {
    for ($i = 1; $i -le $seg * 2; $i++) {
        Start-Sleep -Milliseconds 500
        $w = Get-Process fotos -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Fotos' -or $_.MainWindowTitle -like '*—*' }
        if ($w) { return $i / 2 }
    }
    return -1
}
function Saida([int]$seg) {
    for ($i = 1; $i -le $seg * 2; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process fotos -ErrorAction SilentlyContinue)) { return $i / 2 }
    }
    return -1
}
Start-Process $exe -ArgumentList "`"$Imagem1`""
L "teste 1 (app fechado, abrir imagem): janela em $(Janela 20) s"
Start-Sleep 3
Get-Process fotos | ForEach-Object { $_.CloseMainWindow() | Out-Null }
L "fechar: processo saiu em $(Saida 20) s (-1 = continuou vivo)"
Start-Process $exe -ArgumentList "`"$Imagem2`""
L "teste 2 (logo depois de fechar, abrir outra imagem): janela em $(Janela 20) s"
L "processos: $((Get-Process fotos -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) resp=$($_.Responding) '$($_.MainWindowTitle)'" }) -join ' | ')"
L "fim"
