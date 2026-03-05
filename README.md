# Jade

[![Rust](https://img.shields.io/badge/Rust-1.70+-orange?style=for-the-badge&logo=rust)](https://www.rust-lang.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7.0-646CFF?style=for-the-badge&logo=vite)](https://vitejs.dev/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8D8?style=for-the-badge&logo=tauri)](https://tauri.app/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE.md)

> **Warning:** this is still in development, expect issues and report them please. [open an issue](https://github.com/LeagueToolkit/Jade-League-Bin-Editor/issues/new) or [dm me on discord](http://discordapp.com/users/464506365402939402)

bin file editor for league of legends modding. rebuilt from scratch in rust + tauri so its actually fast now i guess

## Features

- two converter engines — jade custom (native rust) and ltk, you can switch between them in settings
- monaco editor with syntax highlighting for the bin text format
- hash file management with auto-download from communitydragon
- texture preview with hover popups so you can actually see what youre looking at
- particle editor for uh tweaking particle systems visually
- quartz integration — detects when external tools modify your open files
- theme customization with built-in and custom themes
- custom app icon (click it in the about dialog)
- linked bin file importing
- tab-based editing with drag and drop support
- window state and preferences persistence
- launch on windows startup toggle
- minimize to system tray on close
- `.bin` file association (double-click to open in jade)
- single-instance mode so it doesnt open a million windows i guess

## Download

grab the latest release from the [releases page](https://github.com/LeagueToolkit/Jade-League-Bin-Editor/releases). just run the installer and youre good

## Building from source

you need [Node.js](https://nodejs.org/) (v18+) and [Rust](https://rustup.rs/) (stable)

```bash
git clone https://github.com/LeagueToolkit/Jade-League-Bin-Editor.git
cd Jade-League-Bin-Editor

npm install

# dev mode
npm run tauri dev

# release build
npm run tauri build
```

the built installer ends up in `src-tauri/target/release/bundle/nsis/`

## Project Structure

```
├── src/                    # react frontend
│   ├── App.tsx             # main app component (its big)
│   ├── components/         # ui components
│   └── lib/                # utilities, parsers, theme stuff
├── src-tauri/              # rust backend
│   └── src/
│       ├── core/           # bin parser, hash table, jade converter engine
│       ├── bin_commands.rs  # file conversion commands
│       ├── hash_commands.rs # hash management
│       ├── app_commands.rs  # preferences, window state, icon management
│       └── extra_commands.rs # autostart, file association, updater
```

## Keyboard Shortcuts

### File
- **Ctrl+O** — open file (welcome screen) / toggle general editing panel (when file is open)
- **Ctrl+S** — save
- **Ctrl+Shift+S** — save as

### Edit
- **Ctrl+Z** — undo
- **Ctrl+Y** — redo
- **Ctrl+F** — find
- **Ctrl+H** — replace
- **Ctrl+D** — compare files

### Tools
- **Ctrl+P** — toggle particle editing panel
- **Ctrl+Shift+P** — open particle editor dialog

### Navigation
- **Ctrl+W** — close current tab
- **Ctrl+Tab** — next tab
- **Ctrl+Shift+Tab** — previous tab
- **Escape** — close all panels/dialogs

## Configuration

hash files are stored in `%APPDATA%\LeagueToolkit\Requirements\Hashes` and can be downloaded automatically through settings. you can also preload them on startup if you want i guess

## Issues

if something breaks:
- [open a github issue](https://github.com/LeagueToolkit/Jade-League-Bin-Editor/issues/new)
- [dm me on discord](http://discordapp.com/users/464506365402939402)

## License

see [LICENSE.md](LICENSE.md)
