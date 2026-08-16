# Contributing translations

Jade ships UI translations as plain JSON. This folder is the public place to improve them.

The app itself is closed source. Do not expect app source in this repository. Edit the JSON files here and open a pull request.

## Files

- `locales/en.json` is the English source of truth.
- `locales/<code>.json` is one language or joke voice pack.

Real languages: `sr`, `fr`, `pl`, `tr`, `zh`, `ptbr`, `es`, `vi`, `th`, `de`, `it`, `el`, `sv`.

Joke English voices (separate Settings dropdown): `pirate`, `olden`, `uwu`, `press`, `noir`, `butler`, `corp`, `ship`, `bard`.

## How to translate

1. Open the JSON file for your language.
2. Change **values only**, never keys.
3. Keep placeholders exactly as written: `{name}`, `{count}`, `{path}`, `{query}`, and any other `{word}`.
4. Leave filenames, folder paths, champion names, and game asset names as they are.
5. Leave these terms in English: `BIN`, `WAD`, `SKN`, `SKL`, `ANM`, `TEX`, `DDS`, `LMDB`, `GLTF`, `GLB`, `FBX`, `Jade`, `Quartz`, `League of Legends`, `Markdown`.
6. `skin` means a game cosmetic, not human skin.
7. Open a pull request against this repository.

To add a **new** language, copy `locales/en.json` to `locales/<code>.json`, translate the values, and mention the language name in the PR. Wiring it into the app happens in the private build.

## Glossary

- **Serbian** (`sr`): informal *ti*. Windows wording: `Datoteka`, `Fascikla`, `Postavke`, `Istraživač datoteka`, `adresa` (path), `ekstrakcija` / `ekstraktuj`. Viewer: `3D pregledač`. Champion: `heroj` / `heroji` (not `šampion`). Skin stays `skin`.
- **Polish** (`pl`): informal *ty*. Windows wording: `Plik`, `Folder`, `Ustawienia`, `Eksplorator plików`. Riot: `bohater`, `skórka`.
- **Turkish** (`tr`): informal *sen*. Windows wording: `Dosya`, `Klasör`, `Ayarlar`, `Dosya Gezgini`, `Ayıkla`. Viewer: `3B Görüntüleyici`. Riot: `şampiyon`, `kostüm`. Short button labels (`Kaydet`, `Aç`, `Kapat`).
- **Simplified Chinese** (`zh`): `你`. Windows wording: `文件`, `文件夹`, `设置`, `文件资源管理器`. Viewer: `3D 查看器`. Riot: `英雄`, `皮肤`. No Traditional forms.
- **French** (`fr`): informal *tu*. Windows wording: `Fichier`, `Dossier`, `Paramètres`, `Explorateur de fichiers`, `Enregistrer`. Viewer: `Visionneuse 3D`. Riot: `champion`, `skin`.
- **Brazilian Portuguese** (`ptbr`): informal *você*. Windows wording: `Arquivo`, `Pasta`, `Configurações`, `Explorador de Arquivos`, `Extrair`. Viewer: `Visualizador 3D`. Riot: `campeão`, `skin`.
