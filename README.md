# Fotos Glass

O app Fotos do iPhone (iOS 26/27, Liquid Glass) para Windows.

> Projeto independente e sem fins lucrativos. Não tem relação com a Apple. "iPhone", "iOS" e "Apple Music" são marcas da Apple Inc.

## Baixar e instalar

1. Abra a página de [**Releases**](https://github.com/THTECH296/fotos-glass/releases/latest).
2. Baixe **`Fotos-Glass-Setup-x64.exe`**.
3. Abra o arquivo. Ele instala só para o seu usuário, sem pedir senha de administrador.

Requisitos: Windows 10 ou 11, 64 bits. O WebView2 já vem no Windows 11; no Windows 10, o instalador baixa se faltar.

Para desinstalar: **Configurações → Aplicativos → Aplicativos instalados → Fotos → Desinstalar**.

## O que ele faz

- **Biblioteca** em Anos, Meses e Todas, com zoom da grade (Ctrl + / Ctrl −) e seleção arrastando.
- **Coleções**: Dias Recentes, Memórias (apresentação com trilha), Viagens, Em Destaque, Fixados, Álbuns, Tipos de Mídia e Utilidades (Duplicados, Ocultos, Apagados Recentemente).
- **Visualizador** com zoom nítido até 8× o tamanho real, tira de miniaturas, informações da câmera (EXIF) e mapa.
- **Editor não destrutivo**: Ajustar (14 ferramentas), filtros do iOS e Cortar/Girar/Endireitar. O arquivo original nunca é alterado.
- **HEIC, RAW e vídeo**: as miniaturas vêm do próprio cache do Windows.
- **Mapa** das fotos com localização e **busca** por mês, ano, lugar, câmera e álbum.
- **Ocultos e Apagados** protegidos pelo Windows Hello.
- Pode ser o **app padrão** para fotos e vídeos (aparece como "Fotos Glass" no "Abrir com").

## Como saber se o instalador é seguro

- **O código é aberto.** Tudo o que o app faz está neste repositório.
- **Quem compila é o GitHub, não uma pessoa.** O instalador de cada versão é gerado pelo [GitHub Actions](https://github.com/THTECH296/fotos-glass/actions) direto deste código ([`.github/workflows/release.yml`](.github/workflows/release.yml)). Ninguém sobe um .exe feito à mão.
- **Atestado de origem.** Cada instalador tem um atestado assinado pelo GitHub dizendo de qual commit ele saiu. Para conferir, com o [GitHub CLI](https://cli.github.com) instalado:

  ```
  gh attestation verify Fotos-Glass-Setup-x64.exe --repo THTECH296/fotos-glass
  ```

- **SHA-256.** O arquivo `SHA256SUMS.txt` de cada Release traz o código de conferência. No PowerShell:

  ```
  Get-FileHash .\Fotos-Glass-Setup-x64.exe -Algorithm SHA256
  ```

  O resultado tem que ser igual ao do `SHA256SUMS.txt`.

### "O Windows protegeu o computador"

O instalador ainda não tem assinatura digital paga (certificado de código). Por isso o SmartScreen pode avisar que o app é de um "editor desconhecido". Se você baixou da página de Releases deste repositório e conferiu o SHA-256 ou o atestado, clique em **Mais informações → Executar assim mesmo**.

## Privacidade

Seus arquivos não saem do seu computador. Os dados do app (índice, favoritos, playlists e ajustes) ficam em `%LOCALAPPDATA%\br.com.fotos.app`. O app só usa a internet para:

- **Mapas**: as imagens do mapa vêm do OpenStreetMap.
- **Nomes de lugares**: as coordenadas das fotos com localização são enviadas ao Nominatim (OpenStreetMap) para mostrar o nome da cidade. Dá para desligar em Ajustes.

## Compilar a partir do código

Precisa de [Node.js](https://nodejs.org) 20+ e [Rust](https://rustup.rs).

```
npm ci
npx tauri build
```

O instalador fica em `src-tauri/target/release/bundle/nsis/`.

## Licença

[MIT](LICENSE). Componentes de terceiros: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
