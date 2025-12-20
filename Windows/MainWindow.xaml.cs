using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;
using Jade.Services;
using ICSharpCode.AvalonEdit;
using ICSharpCode.AvalonEdit.Highlighting;
using ICSharpCode.AvalonEdit.Highlighting.Xshd;
using System.Xml;
using Jade.Ritobin;

namespace Jade.Windows;

public class EditorTab
{
    public string? FilePath { get; set; }
    public TextEditor Editor { get; set; } = null!;
    public bool IsModified { get; set; }
    public Jade.Editor.SearchHighlightRenderer? SearchRenderer { get; set; }
    public ICSharpCode.AvalonEdit.Folding.FoldingManager? FoldingManager { get; set; }
    public List<Jade.Editor.SyntaxError> Errors { get; set; } = new();
    public Jade.Editor.ErrorHighlightRenderer? ErrorHighlightRenderer { get; set; }
    public Jade.Editor.ErrorUnderlineRenderer? ErrorUnderlineRenderer { get; set; }
    public Jade.Editor.MinimapBackgroundRenderer? MinimapRenderer { get; set; }
    public System.Windows.Threading.DispatcherTimer? ValidationTimer { get; set; }
}

public partial class MainWindow : Window
{
    private readonly List<EditorTab> _tabs = new();
    private IconPanelDialog? _iconPanelDialog = null;
    private ParticlePanelDialog? _particlePanelDialog = null;
    private FindDialog? _findDialog = null;
    private ReplaceDialog? _replaceDialog = null;
    private double _zoomLevel = 100.0; // Default 100%
    private ToolTip? _minimapTooltip;
    private System.Windows.Media.Color _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 255, 215, 0);
    private PerformanceCounter? _ramCounter;
    private System.Windows.Threading.DispatcherTimer? _perfTimer;
    private List<string> _recentFiles = new List<string>();
    private const int MaxRecentFiles = 10;

    public MainWindow()
    {
        try
        {
            Logger.Info("Initializing MainWindow");
            
            // Auto-clear temp folder if enabled
            SettingsWindow.ClearTempFolderOnStartup();
            
            InitializeComponent();
            
            // Auto-download hashes if enabled (after InitializeComponent so StatusText is available)
            SettingsWindow.DownloadHashesOnStartup(status =>
            {
                Dispatcher.Invoke(() =>
                {
                    if (StatusText != null)
                    {
                        StatusText.Text = status;
                    }
                });
            });
            
            // Check if hash preloading is enabled
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");
            bool preloadHashes = false;
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("PreloadHashes="))
                {
                    preloadHashes = content.Contains("PreloadHashes=True");
                }
            }
            
            // Preload hash files if enabled
            if (preloadHashes)
            {
                var hashDir = Path.Combine(jadeDir, "hashes");
                if (Directory.Exists(hashDir))
                {
                    BinConverter.StartPreloading(hashDir);
                    Logger.Info("Started preloading hash files in background (setting enabled)");
                }
            }
            else
            {
                Logger.Info("Hash preloading disabled (setting disabled, will load per-file)");
            }
            
            // Load zoom level
            LoadZoomLevel();
            
            // Load and apply theme
            LoadTheme();
        
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Open, (s, e) => OnOpenFile(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Save, (s, e) => OnSaveFile(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.SaveAs, (s, e) => OnSaveFileAs(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Find, (s, e) => OnFind(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Replace, (s, e) => OnReplace(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Undo, (s, e) => OnUndo(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Redo, (s, e) => OnRedo(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Cut, (s, e) => OnCut(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Copy, (s, e) => OnCopy(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.Paste, (s, e) => OnPaste(s, e)));
            CommandBindings.Add(new CommandBinding(ApplicationCommands.SelectAll, (s, e) => OnSelectAll(s, e)));
            
            InputBindings.Add(new KeyBinding(ApplicationCommands.Open, Key.O, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Save, Key.S, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.SaveAs, Key.S, ModifierKeys.Control | ModifierKeys.Shift));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Find, Key.F, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Replace, Key.H, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Undo, Key.Z, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Redo, Key.Y, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Cut, Key.X, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Copy, Key.C, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.Paste, Key.V, ModifierKeys.Control));
            InputBindings.Add(new KeyBinding(ApplicationCommands.SelectAll, Key.A, ModifierKeys.Control));
            
            // Custom command for compare
            var compareCommand = new RoutedCommand();
            CommandBindings.Add(new CommandBinding(compareCommand, (s, e) => OnCompareFiles(s, e)));
            InputBindings.Add(new KeyBinding(compareCommand, Key.D, ModifierKeys.Control));

            SourceInitialized += OnSourceInitialized;
            StateChanged += OnWindowStateChanged;
            
            // Enable drag and drop
            AllowDrop = true;
            Drop += OnFileDrop;
            DragEnter += OnDragEnter;
            DragOver += OnDragOver;
            DragLeave += OnDragLeave;
            
            Loaded += (s, e) =>
            {
                Logger.Info("MainWindow loaded");
                
                // Initialize Tray Service
                TrayService.Initialize();

                // Check for minimized startup flag
                string[] args = Environment.GetCommandLineArgs();
                bool startMinimized = args.Contains("--minimized");
                bool hasFile = !string.IsNullOrEmpty(App.StartupFilePath);

                if (startMinimized && !hasFile)
                {
                    Logger.Info("Started minimized to tray (no file argument)");
                    this.Hide();
                    TrayService.SetVisible(true);
                }
                else if (hasFile)
                {
                    Logger.Info("Started with file, ensuring visibility");
                    this.Show();
                    this.Activate();
                    TrayService.SetVisible(false);
                }

                UpdateWelcomeScreenVisibility();
                UpdateZoomIndicator();
                
                // Apply margin on load since window starts maximized
                if (WindowState == WindowState.Maximized)
                {
                    // Only 1px at bottom for taskbar gap
                    RootGrid.Margin = new Thickness(0, 0, 0, 1);
                    if (MaximizeButton != null) MaximizeButton.Content = "\uE923";
                }
                else
                {
                     if (MaximizeButton != null) MaximizeButton.Content = "\uE922";
                }
                
                // Initialize status bar state
                UpdateErrorCount();
                UpdateCaretPosition();
                UpdateLineCount();
                
                // Check if a file was passed as command-line argument (from "Open with")
                if (!string.IsNullOrEmpty(App.StartupFilePath) && System.IO.File.Exists(App.StartupFilePath))
                {
                    _ = OpenFileFromPathAsync(App.StartupFilePath);
                }
            };
            
            Logger.Info("MainWindow initialized successfully");
            
            InitializePerformanceMonitoring();
            LoadRecentFiles();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to initialize MainWindow", ex);
            MessageBox.Show($"Failed to initialize: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private EditorTab? GetCurrentTab()
    {
        if (EditorTabControl.SelectedIndex >= 0 && EditorTabControl.SelectedIndex < _tabs.Count)
            return _tabs[EditorTabControl.SelectedIndex];
        return null;
    }

    public TextEditor? GetCurrentEditor()
    {
        return GetCurrentTab()?.Editor;
    }

    private string GetCurrentThemeName()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            return line.Substring(6).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return "Default";
    }

    private string GetCurrentBracketThemeName()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                
                // If override is NOT checked, use current UI theme
                if (!content.Contains("OverrideBracketTheme=True"))
                {
                    return GetCurrentThemeName();
                }

                if (content.Contains("BracketTheme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.Trim().StartsWith("BracketTheme="))
                        {
                            return line.Substring(13).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return GetCurrentThemeName();
    }

    private Color GetLineNumberColorForTheme(string theme)
    {
        return theme switch
        {
            "DarkBlue" => Color.FromRgb(100, 140, 180),      // Soft blue-gray
            "DarkRed" => Color.FromRgb(180, 100, 120),       // Soft red-gray
            "LightPink" => Color.FromRgb(120, 80, 110),      // Dark purple-gray for contrast
            "PastelBlue" => Color.FromRgb(80, 120, 160),     // Medium blue for contrast
            "ForestGreen" => Color.FromRgb(100, 150, 120),   // Soft green-gray
            "AMOLED" => Color.FromRgb(100, 100, 100),        // Medium gray on black
            "Void" => Color.FromRgb(140, 120, 180),          // Soft purple-gray
            "VioletSorrow" => Color.FromRgb(130, 100, 185),  // Deep sorrowful violet
            "OrangeBurnout" => Color.FromRgb(180, 100, 50),  // Warm orange-gray
            "PurpleGrief" => Color.FromRgb(160, 140, 170),   // Sorrowful violet-gray
            _ => Color.FromRgb(128, 128, 128)                // Default gray
        };
    }

    private void UpdateWelcomeScreenVisibility()
    {
        if (_tabs.Count == 0)
        {
            WelcomeScreen.Visibility = Visibility.Visible;
            EditorTabControl.Visibility = Visibility.Collapsed;
        }
        else
        {
            WelcomeScreen.Visibility = Visibility.Collapsed;
            EditorTabControl.Visibility = Visibility.Visible;
        }
    }

    private void CreateNewTab(string? filePath = null, string? content = null)
    {
        // Get current theme colors
        var editorBg = GetCurrentEditorBackground();
        var editorFg = GetCurrentEditorForeground();
        var tabBg = GetCurrentTabBackground();
        var currentTheme = GetCurrentThemeName();
        var bracketTheme = GetCurrentBracketThemeName();
        
        var tab = new EditorTab
        {
            FilePath = filePath,
            IsModified = false
        };

        var editor = new TextEditor
        {
            Background = editorBg,
            Foreground = editorFg,
            FontFamily = new FontFamily("Consolas"),
            FontSize = GetFontSizeFromZoom(),
            ShowLineNumbers = true,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(10),
            WordWrap = false,
            Document = new ICSharpCode.AvalonEdit.Document.TextDocument(content ?? ""),
            SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(bracketTheme)
        };
        
        // 1. Limit Undo Stack to reduce memory usage on large files
        editor.Document.UndoStack.SizeLimit = 256;

        // Set line number colors based on theme
        var lineNumberColor = GetLineNumberColorForTheme(currentTheme);
        editor.LineNumbersForeground = new SolidColorBrush(lineNumberColor);

        // Add bracket colorizer
        editor.TextArea.TextView.LineTransformers.Add(new Jade.Editor.BracketColorizer(bracketTheme));

        // Add bracket matching highlighter
        var bracketHighlighter = new Jade.Editor.BracketHighlightRenderer(editor.TextArea.TextView, bracketTheme);
        editor.TextArea.TextView.BackgroundRenderers.Add(bracketHighlighter);
        
        // Add bracket scope line renderer (vertical lines connecting brackets)
        var scopeLineRenderer = new Jade.Editor.BracketScopeLineRenderer(editor.TextArea.TextView, bracketTheme);
        editor.TextArea.TextView.BackgroundRenderers.Add(scopeLineRenderer);
        
        // Add minimap background (subtle different color on right edge)
        var minimapBackground = new Jade.Editor.MinimapBackgroundRenderer(editor.TextArea.TextView);
        
        // Apply theme color immediately
        if (currentTheme == "LightPink" || currentTheme == "PastelBlue")
        {
             minimapBackground.SetBackgroundColor(System.Windows.Media.Color.FromArgb(20, 0, 0, 0));
        }
        else
        {
             // Dark themes: subtle white tint
             minimapBackground.SetBackgroundColor(System.Windows.Media.Color.FromArgb(15, 255, 255, 255));
        }
        
        editor.TextArea.TextView.BackgroundRenderers.Insert(0, minimapBackground); // Insert first so it's behind other renderers
        
        // Add search result highlighter (minimap bar)
        var searchRenderer = new Jade.Editor.SearchHighlightRenderer(editor.TextArea.TextView);
        searchRenderer.SetHighlightColor(_currentSearchHighlightColor);
        editor.TextArea.TextView.BackgroundRenderers.Add(searchRenderer);
        
        // Add error renderers
        var errorHighlightRenderer = new Jade.Editor.ErrorHighlightRenderer(editor.TextArea.TextView);
        editor.TextArea.TextView.BackgroundRenderers.Add(errorHighlightRenderer);
        
        var errorUnderlineRenderer = new Jade.Editor.ErrorUnderlineRenderer(editor.TextArea.TextView);
        editor.TextArea.TextView.BackgroundRenderers.Add(errorUnderlineRenderer);
        
        // Update bracket highlighting and scope lines when caret moves
        editor.TextArea.Caret.PositionChanged += (s, e) =>
        {
            var (opening, closing) = Jade.Editor.BracketMatcher.FindMatchingBracket(
                editor.Document, 
                editor.CaretOffset);
            
            bracketHighlighter.OpeningBracketOffset = opening;
            bracketHighlighter.ClosingBracketOffset = closing;
            
            scopeLineRenderer.OpeningBracketOffset = opening;
            scopeLineRenderer.ClosingBracketOffset = closing;
            
            // REMOVED: Full redraw on every caret move causes severe lag on large files
            // The bracket renderers already invalidate their own visual layer
            // editor.TextArea.TextView.Redraw();
            
            UpdateCaretPosition();
        };

        // Add Ctrl+Scroll zoom support
        editor.PreviewMouseWheel += OnEditorMouseWheel;
        
        // Add custom Undo/Redo handling to preserve scroll position
        editor.PreviewKeyDown += OnEditorPreviewKeyDown;
        
        // Configure tooltips for immediate display
        System.Windows.Controls.ToolTipService.SetInitialShowDelay(editor.TextArea.TextView, 0);
        System.Windows.Controls.ToolTipService.SetShowDuration(editor.TextArea.TextView, 60000);
        System.Windows.Controls.ToolTipService.SetBetweenShowDelay(editor.TextArea.TextView, 0);
        
        // Add minimap interaction (cursor, tooltips, scrolling)
        editor.TextArea.TextView.MouseMove += (s, e) =>
        {
            var textView = editor.TextArea.TextView;
            var pos = e.GetPosition(textView);
            var renderSize = textView.RenderSize;
            
            // Reset cursor and tooltip when leaving the text area
            // Check if mouse is in the minimap area (right 20 pixels)
            if (pos.X >= renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth)
            {
                textView.Cursor = System.Windows.Input.Cursors.Hand;
                
                // Tooltip logic
                var totalLines = editor.Document.LineCount;
                if (totalLines > 0)
                {
                    var lineRatio = pos.Y / renderSize.Height;
                    var lineData = (int)(lineRatio * totalLines) + 1;
                    lineData = Math.Max(1, Math.Min(lineData, totalLines));
                    
                    // Calculate tooltip text
                    string newTooltip;
                    var errorMsg = tab.ErrorHighlightRenderer?.GetErrorNearLine(lineData, totalLines, renderSize.Height);
                    
                    if (!string.IsNullOrEmpty(errorMsg))
                    {
                         newTooltip = $"Line {lineData}: {errorMsg}";
                    }
                    else if (tab.SearchRenderer?.HasMarkerNearLine(lineData, totalLines, renderSize.Height) == true)
                    {
                         newTooltip = $"Line {lineData}: Search Result";
                    }
                    else
                    {
                         newTooltip = $"Jump to Line {lineData}";
                    }
                    
                    // Use manual tooltip control
                    if (_minimapTooltip == null)
                    {
                        _minimapTooltip = new ToolTip 
                        { 
                            StaysOpen = true,
                            IsHitTestVisible = false,
                            Padding = new Thickness(5)
                        };
                        
                        // Apply current theme if available (simple check)
                        if (Background is SolidColorBrush bg)
                        {
                            _minimapTooltip.Background = bg;
                            _minimapTooltip.BorderBrush = new SolidColorBrush(Colors.Gray);
                            _minimapTooltip.BorderThickness = new Thickness(1);
                        }
                    }
                    
                    _minimapTooltip.Content = newTooltip;
                    _minimapTooltip.PlacementTarget = textView;
                    
                    // Fixed placement: Left of the minimap strip vertically aligned with mouse
                    double minimapEdgeX = renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth;
                    // Define a target rectangle at the minimap edge at the current Y position
                    _minimapTooltip.PlacementRectangle = new Rect(minimapEdgeX, pos.Y, 0, 0);
                    
                    _minimapTooltip.Placement = System.Windows.Controls.Primitives.PlacementMode.Left;
                    _minimapTooltip.HorizontalOffset = -5; // Add a small gap between tooltip and minimap
                    _minimapTooltip.VerticalOffset = 0;
                    _minimapTooltip.IsOpen = true;
                }
            }
            else
            {
                textView.Cursor = System.Windows.Input.Cursors.IBeam;
                if (_minimapTooltip != null) _minimapTooltip.IsOpen = false;
            }
        };
        
        // Reset cursor and tooltip when leaving the text area
        editor.TextArea.TextView.MouseLeave += (s, e) =>
        {
            editor.TextArea.TextView.Cursor = System.Windows.Input.Cursors.IBeam;
            if (_minimapTooltip != null) _minimapTooltip.IsOpen = false;
        };
        
        // Add minimap click support - click on right edge to jump to that line
        editor.TextArea.TextView.MouseLeftButtonDown += (s, e) =>
        {
            var textView = editor.TextArea.TextView;
            var pos = e.GetPosition(textView);
            var renderSize = textView.RenderSize;
            
            // Check if click is in the minimap area (right 20 pixels)
            if (pos.X >= renderSize.Width - Jade.Editor.MinimapBackgroundRenderer.MinimapWidth)
            {
                var totalLines = editor.Document.LineCount;
                if (totalLines > 0)
                {
                    // Calculate which line was clicked based on Y position
                    var lineRatio = pos.Y / renderSize.Height;
                    var targetLine = (int)(lineRatio * totalLines) + 1;
                    targetLine = Math.Max(1, Math.Min(targetLine, totalLines));
                    
                    // Jump to that line - SCROLL ONLY, DO NOT MOVE CARET
                    editor.ScrollToLine(targetLine);
                    
                    // Prevent editor from handling the click (which would move caret/selection)
                    e.Handled = true;
                }
            }
        };
        
        // Install folding manager for code folding
        var foldingManager = ICSharpCode.AvalonEdit.Folding.FoldingManager.Install(editor.TextArea);
        var foldingStrategy = new Jade.Editor.BinFileFoldingStrategy();
        
        // Set initial folding colors based on current theme
        ApplyFoldingColorsToEditor(editor, currentTheme);
        
        // Initial folding update
        if (!string.IsNullOrEmpty(content))
        {
            foldingStrategy.UpdateFoldings(foldingManager, editor.Document);
        }

        tab.Editor = editor;
        tab.SearchRenderer = searchRenderer;
        tab.FoldingManager = foldingManager;
        tab.ErrorHighlightRenderer = errorHighlightRenderer;
        tab.ErrorHighlightRenderer = errorHighlightRenderer;
        tab.ErrorUnderlineRenderer = errorUnderlineRenderer;
        tab.MinimapRenderer = minimapBackground;
        
        // Create validation timer with 500ms debounce
        var validationTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(500)
        };
        validationTimer.Tick += (s, e) =>
        {
            validationTimer.Stop();
            ValidateCurrentTab(tab);
        };
        tab.ValidationTimer = validationTimer;

        // Create folding timer for debounced updates (1.5s delay)
        var foldingTimer = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(1.5)
        };
        foldingTimer.Tick += (s, e) =>
        {
            foldingTimer.Stop();
            foldingStrategy.UpdateFoldings(foldingManager, editor.Document);
        };
        
        editor.TextArea.SelectionChanged += (s, e) => UpdateCaretPosition();
        editor.TextChanged += (s, e) => 
        { 
            tab.IsModified = true; 
            UpdateLineCount();
            
            // Restart validation timer (500ms debounce)
            validationTimer.Stop();
            validationTimer.Start();
            
            // Restart folding timer (1.5s debounce) - Significant performance improvement
            foldingTimer.Stop();
            foldingTimer.Start();
        };

        _tabs.Add(tab);

        var tabItem = new TabItem
        {
            Header = filePath != null ? Path.GetFileName(filePath) : "Untitled",
            Content = editor,
            Background = tabBg
        };

        EditorTabControl.Items.Add(tabItem);
        EditorTabControl.SelectedIndex = EditorTabControl.Items.Count - 1;
        
        UpdateWelcomeScreenVisibility();
        UpdateLineCount();
        UpdateCaretPosition();
        ValidateCurrentTab(tab);
    }
    
    private void UpdateTabEditorColors(TabItem tab, SolidColorBrush editorBg, SolidColorBrush textColor)
    {
        if (tab.Content is TextEditor editor)
        {
            editor.Background = editorBg;
            editor.Foreground = textColor;
            
            // Reload syntax highlighting for current theme (BracketTheme covers both syntax and brackets)
            var bracketTheme = GetCurrentBracketThemeName();
            editor.SyntaxHighlighting = ThemeSyntaxHighlighting.GetHighlightingForTheme(bracketTheme);
            
            // Update line number colors
            var currentTheme = GetCurrentThemeName();
            var lineNumberColor = GetLineNumberColorForTheme(currentTheme);
            editor.LineNumbersForeground = new SolidColorBrush(lineNumberColor);

            // Update bracket renderers and colorizers with new theme
            
            // 1. Update Background Renderers
            var renderers = editor.TextArea.TextView.BackgroundRenderers;
            for (int i = renderers.Count - 1; i >= 0; i--)
            {
                if (renderers[i] is Jade.Editor.BracketHighlightRenderer || 
                    renderers[i] is Jade.Editor.BracketScopeLineRenderer)
                {
                    renderers.RemoveAt(i);
                }
            }
            
            var bracketHighlighter = new Jade.Editor.BracketHighlightRenderer(editor.TextArea.TextView, bracketTheme);
            editor.TextArea.TextView.BackgroundRenderers.Add(bracketHighlighter);
            
            var scopeLineRenderer = new Jade.Editor.BracketScopeLineRenderer(editor.TextArea.TextView, bracketTheme);
            editor.TextArea.TextView.BackgroundRenderers.Add(scopeLineRenderer);

            // 2. Update Line Transformers (Bracket Colors)
            var transformers = editor.TextArea.TextView.LineTransformers;
            for (int i = transformers.Count - 1; i >= 0; i--)
            {
                if (transformers[i] is Jade.Editor.BracketColorizer)
                {
                    transformers.RemoveAt(i);
                }
            }
            editor.TextArea.TextView.LineTransformers.Add(new Jade.Editor.BracketColorizer(bracketTheme));
            
            // Force redraw
            editor.TextArea.TextView.Redraw();
        }
    }
    
    private void ValidateCurrentTab(EditorTab tab)
    {
        try
        {
            if (tab.Editor == null) return;
            
            // Run validation
            var errors = Jade.Editor.BinSyntaxValidator.Validate(tab.Editor.Text);
            tab.Errors = errors;
            
            // Update renderers
            tab.ErrorHighlightRenderer?.UpdateErrors(errors);
            tab.ErrorUnderlineRenderer?.UpdateErrors(errors);
            
            // Update status bar
            UpdateErrorCount();
            
            Logger.Info($"Validated tab: {errors.Count} error(s) found");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to validate tab", ex);
        }
    }
    
    private void UpdateErrorCount()
    {
        try
        {
            var tab = GetCurrentTab();
            if (tab == null)
            {
                if (ErrorCountText != null)
                {
                    ErrorCountText.Text = "No file loaded";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Gray);
                }
                return;
            }
            
            if (ErrorCountText != null)
            {
                if (tab.Errors.Count == 0)
                {
                    ErrorCountText.Text = "No errors";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Green);
                }
                else
                {
                    ErrorCountText.Text = $"{tab.Errors.Count} error(s)";
                    ErrorCountText.Foreground = new SolidColorBrush(Colors.Red);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update error count", ex);
        }
    }
    
    private SolidColorBrush GetCurrentEditorBackground()
    {
        var theme = GetCurrentTheme();
        if (theme == "DarkBlue")
            return new SolidColorBrush(Color.FromRgb(20, 30, 45));
        else if (theme == "DarkRed")
            return new SolidColorBrush(Color.FromRgb(45, 20, 25));
        else if (theme == "LightPink")
            return new SolidColorBrush(Color.FromRgb(210, 165, 190));
        else if (theme == "PastelBlue")
            return new SolidColorBrush(Color.FromRgb(210, 240, 255));
        else if (theme == "ForestGreen")
            return new SolidColorBrush(Color.FromRgb(25, 45, 30));
        else if (theme == "AMOLED")
            return new SolidColorBrush(Color.FromRgb(0, 0, 0));
        else if (theme == "Void")
            return new SolidColorBrush(Color.FromRgb(15, 10, 30));
        else if (theme == "VioletSorrow")
            return new SolidColorBrush(Color.FromRgb(22, 12, 42));
        else if (theme == "OrangeBurnout")
            return new SolidColorBrush(Color.FromRgb(42, 20, 8));
        else if (theme == "PurpleGrief")
            return new SolidColorBrush(Color.FromRgb(30, 20, 35));
        return new SolidColorBrush(Color.FromRgb(30, 30, 30));
    }
    
    private SolidColorBrush GetCurrentEditorForeground()
    {
        var theme = GetCurrentTheme();
        if (theme == "DarkBlue")
            return new SolidColorBrush(Color.FromRgb(220, 230, 240));
        else if (theme == "DarkRed")
            return new SolidColorBrush(Color.FromRgb(240, 220, 225));
        else if (theme == "LightPink")
            return new SolidColorBrush(Color.FromRgb(40, 20, 35));
        else if (theme == "PastelBlue")
            return new SolidColorBrush(Color.FromRgb(60, 40, 80));
        else if (theme == "ForestGreen")
            return new SolidColorBrush(Color.FromRgb(200, 230, 210));
        else if (theme == "AMOLED")
            return new SolidColorBrush(Color.FromRgb(180, 180, 180));
        else if (theme == "Void")
            return new SolidColorBrush(Color.FromRgb(180, 170, 220));
        else if (theme == "VioletSorrow")
            return new SolidColorBrush(Color.FromRgb(185, 170, 215));
        else if (theme == "OrangeBurnout")
            return new SolidColorBrush(Color.FromRgb(255, 228, 209));
        else if (theme == "PurpleGrief")
            return new SolidColorBrush(Color.FromRgb(220, 200, 230));
        return new SolidColorBrush(Color.FromRgb(212, 212, 212));
    }
    
    private SolidColorBrush GetCurrentTabBackground()
    {
        var theme = GetCurrentTheme();
        if (theme == "DarkBlue")
            return new SolidColorBrush(Color.FromRgb(25, 35, 50));
        else if (theme == "DarkRed")
            return new SolidColorBrush(Color.FromRgb(50, 25, 30));
        else if (theme == "LightPink")
            return new SolidColorBrush(Color.FromRgb(180, 130, 160));
        else if (theme == "PastelBlue")
            return new SolidColorBrush(Color.FromRgb(235, 225, 255));
        else if (theme == "ForestGreen")
            return new SolidColorBrush(Color.FromRgb(30, 50, 35));
        else if (theme == "AMOLED")
            return new SolidColorBrush(Color.FromRgb(10, 10, 10));
        else if (theme == "Void")
            return new SolidColorBrush(Color.FromRgb(26, 15, 46));
        else if (theme == "VioletSorrow")
            return new SolidColorBrush(Color.FromRgb(32, 20, 58));
        else if (theme == "OrangeBurnout")
            return new SolidColorBrush(Color.FromRgb(50, 25, 10));
        else if (theme == "PurpleGrief")
            return new SolidColorBrush(Color.FromRgb(35, 25, 40));
        return new SolidColorBrush(Color.FromRgb(37, 37, 38));
    }
    
    private string GetCurrentTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            return line.Substring(6).Trim();
                        }
                    }
                }
            }
        }
        catch { }
        
        return "Default";
    }
    

    


    private async void OnOpenFile(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening file dialog");
            var dialog = new OpenFileDialog
            {
                Filter = "BIN Files (*.bin)|*.bin|Python Files (*.py)|*.py|Text Files (*.txt)|*.txt|All Files (*.*)|*.*",
                Title = "Open File"
            };

            if (dialog.ShowDialog() == true)
            {
                Logger.Info($"User selected file: {dialog.FileName}");
                StatusText.Text = "Loading...";
                
                var content = await LoadFileContentAsync(dialog.FileName);
                
                Logger.Info($"Setting text in editor, length: {content.Length}");
                StatusText.Text = "Rendering...";
                
                // Give UI time to update
                await System.Threading.Tasks.Task.Delay(10);
                
                CreateNewTab(dialog.FileName, content);
                
                FileTypeText.Text = Path.GetExtension(dialog.FileName).ToUpper();
                StatusText.Text = "File loaded";
                
                AddToRecentFiles(dialog.FileName);
                Logger.Info("File loaded successfully");
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error in OnOpenFile", ex);
            MessageBox.Show($"Error loading file: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
    }

    /// <summary>
    /// Opens a file from an external path (e.g., command-line argument or drag-drop).
    /// </summary>
    public async Task OpenFileFromPathAsync(string filePath)
    {
        try
        {
            Logger.Info($"Opening file from path: {filePath}");
            StatusText.Text = "Loading...";
            
            var content = await LoadFileContentAsync(filePath);
            
            StatusText.Text = "Rendering...";
            await System.Threading.Tasks.Task.Delay(10);
            
            CreateNewTab(filePath, content);
            
            FileTypeText.Text = Path.GetExtension(filePath).ToUpper();
            StatusText.Text = "File loaded";
            
            AddToRecentFiles(filePath);
            Logger.Info($"File loaded from path: {filePath}");
        }
        catch (Exception ex)
        {
            Logger.Error($"Error opening file from path: {filePath}", ex);
            MessageBox.Show($"Error loading file: {ex.Message}", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
    }

    private async void OnSaveFile(object sender, RoutedEventArgs e)
    {
        var tab = GetCurrentTab();
        if (tab == null) return;

        if (string.IsNullOrEmpty(tab.FilePath))
        {
            OnSaveFileAs(sender, e);
            return;
        }

        await SaveFileContent(tab, tab.FilePath);
    }

    private async void OnSaveFileAs(object sender, RoutedEventArgs e)
    {
        var tab = GetCurrentTab();
        if (tab == null) return;

        var dialog = new SaveFileDialog
        {
            Filter = "Text Files (*.txt;*.py)|*.txt;*.py|BIN Files (*.bin)|*.bin|All Files (*.*)|*.*",
            Title = "Save File As"
        };

        if (dialog.ShowDialog() == true)
        {
            await SaveFileContent(tab, dialog.FileName);
            AddToRecentFiles(dialog.FileName);
        }
    }
    
    private void LoadRecentFiles()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");

            if (File.Exists(prefsFile))
            {
                var lines = File.ReadAllLines(prefsFile);
                var recentLine = lines.FirstOrDefault(l => l.StartsWith("RecentFiles="));
                if (recentLine != null)
                {
                    var paths = recentLine.Substring("RecentFiles=".Length).Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                    _recentFiles.Clear();
                    foreach (var path in paths)
                    {
                        if (File.Exists(path))
                        {
                            _recentFiles.Add(path);
                        }
                    }
                }
            }
            UpdateRecentFilesMenu();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load recent files", ex);
        }
    }

    private void SaveRecentFiles()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");

            var lines = File.Exists(prefsFile) ? File.ReadAllLines(prefsFile).ToList() : new List<string>();
            var recentValue = string.Join(",", _recentFiles);

            bool found = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (lines[i].StartsWith("RecentFiles="))
                {
                    lines[i] = $"RecentFiles={recentValue}";
                    found = true;
                    break;
                }
            }

            if (!found) lines.Add($"RecentFiles={recentValue}");

            File.WriteAllLines(prefsFile, lines);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save recent files", ex);
        }
    }

    private void AddToRecentFiles(string path)
    {
        try
        {
            _recentFiles.Remove(path);
            _recentFiles.Insert(0, path);

            while (_recentFiles.Count > MaxRecentFiles)
            {
                _recentFiles.RemoveAt(_recentFiles.Count - 1);
            }

            SaveRecentFiles();
            UpdateRecentFilesMenu();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to add recent file", ex);
        }
    }

    private void UpdateRecentFilesMenu()
    {
        if (RecentFilesMenu == null) return;

        RecentFilesMenu.Items.Clear();

        if (_recentFiles.Count == 0)
        {
            var noItems = new MenuItem { Header = "No Recent Files", IsEnabled = false };
            RecentFilesMenu.Items.Add(noItems);
            return;
        }

        foreach (var path in _recentFiles)
        {
            var item = new MenuItem
            {
                Header = Path.GetFileName(path),
                ToolTip = path
            };
            item.Click += (s, e) => { _ = OpenFileFromPathAsync(path); };
            RecentFilesMenu.Items.Add(item);
        }

        RecentFilesMenu.Items.Add(new Separator());
        var clearItem = new MenuItem { Header = "Clear Recent Files" };
        clearItem.Click += (s, e) =>
        {
            _recentFiles.Clear();
            SaveRecentFiles();
            UpdateRecentFilesMenu();
        };
        RecentFilesMenu.Items.Add(clearItem);
    }
    
    private async Task SaveFileContent(EditorTab tab, string filePath)
    {
        try
        {
            StatusText.Text = "Saving...";
            var content = tab.Editor.Text;
            
            // Create temp folder for backup
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var tempDir = Path.Combine(jadeDir, "temp");
            Directory.CreateDirectory(tempDir);
            
            // Save temp text backup
            var tempFile = Path.Combine(tempDir, Path.GetFileNameWithoutExtension(filePath) + "_backup.txt");
            File.WriteAllText(tempFile, content);
            Logger.Info($"Created temp backup: {tempFile}");
            
            // Check if this is a .bin file that needs conversion
            if (Path.GetExtension(filePath).Equals(".bin", StringComparison.OrdinalIgnoreCase))
            {
                // Convert text back to binary
                var hashDir = Path.Combine(jadeDir, "hashes");
                var binaryData = BinConverter.ConvertTextToBin(content, out var error, hashDir);
                
                if (binaryData == null)
                {
                    // Conversion failed - show error
                    Logger.Error($"Failed to convert text to binary: {error}", null);
                    var result = MessageBox.Show(
                        $"Failed to convert text to binary format:\n\n{error}\n\nA text backup has been saved to:\n{tempFile}\n\nWould you like to save as text file (.py) instead?",
                        "Conversion Error",
                        MessageBoxButton.YesNo,
                        MessageBoxImage.Warning);
                    
                    if (result == MessageBoxResult.Yes)
                    {
                        // Save as .py instead
                        var pyPath = Path.ChangeExtension(filePath, ".py");
                        File.WriteAllText(pyPath, content);
                        tab.FilePath = pyPath;
                        tab.IsModified = false;
                        
                        if (EditorTabControl.SelectedItem is TabItem tabItem)
                        {
                            tabItem.Header = Path.GetFileName(pyPath);
                        }
                        
                        StatusText.Text = $"Saved as text file: {Path.GetFileName(pyPath)}";
                        Logger.Info($"Saved as text: {pyPath}");
                    }
                    else
                    {
                        StatusText.Text = "Save cancelled";
                    }
                    return;
                }
                
                // Write binary data
                File.WriteAllBytes(filePath, binaryData);
                Logger.Info($"Converted and saved binary file: {filePath}");
            }
            else
            {
                // Regular text file - just save
                File.WriteAllText(filePath, content);
                Logger.Info($"Saved text file: {filePath}");
            }
            
            tab.FilePath = filePath;
            tab.IsModified = false;
            
            if (EditorTabControl.SelectedItem is TabItem tabItem2)
            {
                tabItem2.Header = Path.GetFileName(filePath);
            }
            
            StatusText.Text = "File saved successfully";
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save file", ex);
            MessageBox.Show($"Error saving file: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error saving file";
        }
    }

    private void PerformUndo(TextEditor editor)
    {
        if (editor != null && editor.CanUndo)
        {
            // Ensure editor has focus FIRST so keyboard shortcuts work
            if (!editor.IsFocused)
            {
                editor.Focus();
            }
            
            // Save scroll position
            var verticalOffset = editor.VerticalOffset;
            var horizontalOffset = editor.HorizontalOffset;
            
            // Perform undo
            editor.Undo();
            
            // Restore scroll position using Input priority to ensure it happens after all internal updates
            Dispatcher.InvokeAsync(() =>
            {
                if (editor != null)
                {
                    editor.ScrollToVerticalOffset(verticalOffset);
                    editor.ScrollToHorizontalOffset(horizontalOffset);
                }
            }, System.Windows.Threading.DispatcherPriority.Input);
        }
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (ShouldMinimizeToTray())
        {
            e.Cancel = true;
            this.Hide();
            TrayService.SetVisible(true);
            Logger.Info("Window minimized to tray instead of closing");
        }
        else
        {
            TrayService.Cleanup();
            base.OnClosing(e);
        }
    }

    private bool ShouldMinimizeToTray()
    {
        try
        {
            string appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            if (File.Exists(prefsFile))
            {
                string content = File.ReadAllText(prefsFile);
                return content.Contains("MinimizeToTray=True");
            }
        }
        catch { }
        return false;
    }

    private void OnExit(object sender, RoutedEventArgs e)
    {
        TrayService.Cleanup();
        Application.Current.Shutdown();
    }

    private void OnUndo(object sender, RoutedEventArgs e)
    {
        PerformUndo(GetCurrentEditor());
    }

    private void PerformRedo(TextEditor editor)
    {
        if (editor != null && editor.CanRedo)
        {
            // Ensure editor has focus FIRST so keyboard shortcuts work
            if (!editor.IsFocused)
            {
                editor.Focus();
            }
            
            // Save scroll position
            var verticalOffset = editor.VerticalOffset;
            var horizontalOffset = editor.HorizontalOffset;
            
            // Perform redo
            editor.Redo();
            
            // Restore scroll position
            Dispatcher.InvokeAsync(() =>
            {
                if (editor != null)
                {
                    editor.ScrollToVerticalOffset(verticalOffset);
                    editor.ScrollToHorizontalOffset(horizontalOffset);
                }
            }, System.Windows.Threading.DispatcherPriority.Input);
        }
    }

    private void OnRedo(object sender, RoutedEventArgs e)
    {
        PerformRedo(GetCurrentEditor());
    }

    private void OnEditorPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is TextEditor editor)
        {
            if (e.Key == Key.Z && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                PerformUndo(editor);
            }
            else if (e.Key == Key.Y && (Keyboard.Modifiers & ModifierKeys.Control) == ModifierKeys.Control)
            {
                e.Handled = true;
                PerformRedo(editor);
            }
        }
    }

    private void OnCut(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null && !string.IsNullOrEmpty(editor.SelectedText))
        {
            editor.Cut();
        }
    }

    private void OnCopy(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null && !string.IsNullOrEmpty(editor.SelectedText))
        {
            editor.Copy();
        }
    }

    private void OnPaste(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null)
        {
            editor.Paste();
        }
    }

    private void OnSelectAll(object sender, RoutedEventArgs e)
    {
        var editor = GetCurrentEditor();
        if (editor != null)
        {
            editor.SelectAll();
        }
    }

    private void OnFind(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_findDialog != null && _findDialog.IsVisible)
            {
                _findDialog.Close();
                _findDialog = null;
                FindButton.IsChecked = false;
                return;
            }

            var editor = GetCurrentEditor();
            if (editor == null)
            {
                MessageBox.Show("No file is currently open.", "Find", MessageBoxButton.OK, MessageBoxImage.Information);
                FindButton.IsChecked = false;
                return;
            }
            
            // Close replace dialog if open
            if (_replaceDialog != null && _replaceDialog.IsVisible)
            {
                _replaceDialog.Close();
            }
            
            Logger.Info("Opening find dialog");
            _findDialog = new FindDialog(editor)
            {
                Owner = this
            };
            _findDialog.Closed += (s, args) => 
            {
                _findDialog = null;
                FindButton.IsChecked = false;
            };
            _findDialog.Show();
            FindButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            FindButton.IsChecked = false;
            Logger.Error("Failed to open find dialog", ex);
            MessageBox.Show($"Failed to open find dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnReplace(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_replaceDialog != null && _replaceDialog.IsVisible)
            {
                _replaceDialog.Close();
                _replaceDialog = null;
                ReplaceButton.IsChecked = false;
                return;
            }

            var editor = GetCurrentEditor();
            if (editor == null)
            {
                MessageBox.Show("No file is currently open.", "Replace", MessageBoxButton.OK, MessageBoxImage.Information);
                ReplaceButton.IsChecked = false;
                return;
            }
            
            // Close find dialog if open
            if (_findDialog != null && _findDialog.IsVisible)
            {
                _findDialog.Close();
            }
            
            Logger.Info("Opening replace dialog");
            _replaceDialog = new ReplaceDialog(editor)
            {
                Owner = this
            };
            _replaceDialog.Closed += (s, args) => 
            {
                _replaceDialog = null;
                ReplaceButton.IsChecked = false;
            };
            _replaceDialog.Show();
            ReplaceButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            ReplaceButton.IsChecked = false;
            Logger.Error("Failed to open replace dialog", ex);
            MessageBox.Show($"Failed to open replace dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnOpenLog(object sender, RoutedEventArgs e)
    {
        try
        {
            var logPath = Logger.GetLogPath();
            if (File.Exists(logPath))
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = logPath,
                    UseShellExecute = true
                });
            }
            else
            {
                MessageBox.Show($"Log file not found at:\n{logPath}", "Log File", 
                    MessageBoxButton.OK, MessageBoxImage.Information);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Failed to open log file: {ex.Message}", "Error", 
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnThemes(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening themes window");
            var themesWindow = new ThemesWindow
            {
                Owner = this
            };
            themesWindow.ShowDialog();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open themes", ex);
            MessageBox.Show($"Failed to open themes: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnSettings(object sender, RoutedEventArgs e)
    {
        try
        {
            Logger.Info("Opening settings window");
            var settingsWindow = new SettingsWindow
            {
                Owner = this
            };
            settingsWindow.ShowDialog();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open settings", ex);
            MessageBox.Show($"Failed to open settings: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnCompareFiles(object sender, RoutedEventArgs e)
    {
        try
        {
            if (_tabs.Count < 2)
            {
                MessageBox.Show("You need at least 2 open files to compare.", "Compare Files",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }
            
            Logger.Info("Opening compare dialog");
            var compareDialog = new CompareDialog(_tabs);
            compareDialog.Show();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to open compare dialog", ex);
            MessageBox.Show($"Failed to open compare dialog: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnEditorSelectionChanged(object sender, RoutedEventArgs e)
    {
        UpdateCaretPosition();
    }
    
    private void OnEditorTextChanged(object sender, TextChangedEventArgs e)
    {
        UpdateLineCount();
    }
    
    private void UpdateCaretPosition()
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null)
            {
                if (CaretPosition != null) CaretPosition.Text = "Ln 1, Col 1";
                return;
            }

            var line = editor.TextArea.Caret.Line;
            var column = editor.TextArea.Caret.Column;
            
            if (CaretPosition != null) CaretPosition.Text = $"Ln {line}, Col {column}";
        }
        catch
        {
            if (CaretPosition != null) CaretPosition.Text = "Ln 1, Col 1";
        }
    }
    
    private void UpdateLineCount()
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null)
            {
                LineCount.Text = "0 lines";
                return;
            }

            // Calculate line count manually since editor.LineCount can return -1
            var lineCount = string.IsNullOrEmpty(editor.Text) ? 0 : editor.Text.Split('\n').Length;
            LineCount.Text = $"{lineCount:N0} lines";
        }
        catch
        {
            LineCount.Text = "0 lines";
        }
    }
    
    public void UpdateSearchHighlights(string searchText, bool matchCase, bool wholeWord)
    {
        try
        {
            var editor = GetCurrentEditor();
            if (editor == null) return;
            
            // Find the tab for this editor
            var tab = _tabs.FirstOrDefault(t => t.Editor == editor);
            if (tab?.SearchRenderer == null) return;
            
            var offsets = new List<int>();
            
            if (!string.IsNullOrEmpty(searchText))
            {
                var text = editor.Text;
                var comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
                int index = 0;
                
                while ((index = text.IndexOf(searchText, index, comparison)) != -1)
                {
                    bool isMatch = true;
                    if (wholeWord)
                    {
                        // Check word boundaries
                        if (index > 0)
                        {
                            char before = text[index - 1];
                            if (char.IsLetterOrDigit(before) || before == '_') isMatch = false;
                        }
                        
                        if (isMatch && index + searchText.Length < text.Length)
                        {
                            char after = text[index + searchText.Length];
                            if (char.IsLetterOrDigit(after) || after == '_') isMatch = false;
                        }
                    }
                    
                    if (isMatch)
                    {
                        offsets.Add(index);
                    }
                    
                    index++;
                }
            }
            
            tab.SearchRenderer.SearchLength = string.IsNullOrEmpty(searchText) ? 0 : searchText.Length;
            tab.SearchRenderer.SearchOffsets = offsets;
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update search highlights", ex);
        }
    }


    // Custom Title Bar Handlers
    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            MaximizeWindow(sender, e);
        }
        else
        {
            DragMove();
        }
    }

    private void MinimizeWindow(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeWindow(object sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        if (MaximizeButton != null)
        {
            MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        }
    }

    private void CloseWindow(object sender, RoutedEventArgs e)
    {
        Close();
    }
    
    // Fix maximize to respect taskbar
    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public uint Size;
        public RECT Monitor;
        public RECT WorkArea;
        public uint Flags;
    }
    
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var handle = new WindowInteropHelper(this).Handle;
        var source = HwndSource.FromHwnd(handle);
        source?.AddHook(WndProc);
    }
    
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_GETMINMAXINFO = 0x0024;
        
        if (msg == WM_GETMINMAXINFO)
        {
            var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
            var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            
            if (monitor != IntPtr.Zero)
            {
                var monitorInfo = new MONITORINFO { Size = (uint)Marshal.SizeOf(typeof(MONITORINFO)) };
                if (GetMonitorInfo(monitor, ref monitorInfo))
                {
                    // Use work area to respect taskbar and prevent clipping
                    var workArea = monitorInfo.WorkArea;
                    var monitorArea = monitorInfo.Monitor;
                    
                    mmi.ptMaxPosition.X = workArea.Left - monitorArea.Left;
                    mmi.ptMaxPosition.Y = workArea.Top - monitorArea.Top;
                    mmi.ptMaxSize.X = workArea.Right - workArea.Left;
                    // Leave 1 pixel gap at bottom for hidden taskbar access
                    mmi.ptMaxSize.Y = workArea.Bottom - workArea.Top - 1;
                }
            }
            
            Marshal.StructureToPtr(mmi, lParam, true);
            handled = true;
        }
        
        return IntPtr.Zero;
    }
    
    private void OnWindowStateChanged(object? sender, EventArgs e)
    {
        // Adjust margin when maximized for taskbar access
        if (WindowState == WindowState.Maximized)
        {
            // Only 1px at bottom for taskbar gap
            RootGrid.Margin = new Thickness(0, 0, 0, 1);
        }
        else
        {
            RootGrid.Margin = new Thickness(0);
        }
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }
    
    [StructLayout(LayoutKind.Sequential)]
    public struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    private void OnCloseTab(object sender, RoutedEventArgs e)
    {
        if (sender is Button button && button.Tag is TabItem tabItem)
        {
            var index = EditorTabControl.Items.IndexOf(tabItem);
            if (index >= 0 && index < _tabs.Count)
            {
                var tab = _tabs[index];
                
                // Aggressive memory cleanup
                if (tab.Editor != null)
                {
                    // Clear all editor content
                    tab.Editor.Text = string.Empty;
                    tab.Editor.Document.Text = string.Empty;
                    
                    // Clear undo/redo stacks
                    tab.Editor.Document.UndoStack.ClearAll();
                    
                    // Remove event handlers to break references
                    tab.Editor.TextChanged -= null;
                    
                    // Clear any syntax highlighting
                    tab.Editor.SyntaxHighlighting = null;
                }
                
                // Clear TabItem content
                if (tabItem.Content is Grid grid)
                {
                    grid.Children.Clear();
                }
                tabItem.Content = null;
                
                // Remove from collections
                _tabs.RemoveAt(index);
                EditorTabControl.Items.Remove(tabItem);
                
                // Null out the tab reference
                tab.Editor = null!;
                tab.FilePath = null;
                
                // Aggressive garbage collection with heap compaction
                GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                GC.WaitForPendingFinalizers();
                GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
                
                UpdateWelcomeScreenVisibility();
                
                Logger.Info($"Closed tab and freed memory aggressively");
            }
        }
    }

    private void OnTabSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        var tab = GetCurrentTab();
        
        // Update general status items
        UpdateErrorCount();
        UpdateCaretPosition();
        UpdateLineCount();
        
        if (tab != null)
        {
            if (!string.IsNullOrEmpty(tab.FilePath))
            {
                FileTypeText.Text = Path.GetExtension(tab.FilePath).ToUpper();
            }
            else
            {
                FileTypeText.Text = "";
            }
        }
        else
        {
            if (FileTypeText != null) FileTypeText.Text = "";
        }
    }

    private async Task<string> LoadFileContentAsync(string filePath)
    {
        return await Task.Run(() =>
        {
            try
            {
                var extension = Path.GetExtension(filePath).ToLower();
                
                if (extension == ".bin")
                {
                    return ConvertBinToText(filePath);
                }
                
                return File.ReadAllText(filePath);
            }
            catch (Exception ex)
            {
                Logger.Error($"Failed to load file: {filePath}", ex);
                return $"# Error loading file: {ex.Message}";
            }
        });
    }

    private string ConvertBinToText(string binPath)
    {
        try
        {
            var pyPath = Path.ChangeExtension(binPath, ".py");
            if (File.Exists(pyPath))
            {
                Logger.Info($"Found existing .py file: {pyPath}");
                return File.ReadAllText(pyPath);
            }
            
            Logger.Info($"Converting BIN to text: {binPath}");
            
            var jadeDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RitoShark", "Jade");
            var hashDir = Path.Combine(jadeDir, "hashes");
            
            // Check if preload is enabled
            var settingsFile = Path.Combine(jadeDir, "preferences.txt");
            bool keepHashesLoaded = false; // Default to unload after use
            
            if (File.Exists(settingsFile))
            {
                var content = File.ReadAllText(settingsFile);
                if (content.Contains("PreloadHashes="))
                {
                    keepHashesLoaded = content.Contains("PreloadHashes=True");
                }
            }
            
            return BinConverter.ConvertBinToText(binPath, hashDir, keepHashesLoaded);
        }
        catch (Exception ex)
        {
            Logger.Error("ConvertBinToText failed", ex);
            return $"#PROP_text\n\n# Error loading BIN file: {ex.Message}\n# File: {binPath}\n# Check log at: {Logger.GetLogPath()}";
        }
    }

    public void LoadTheme()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            string theme = "Default";
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("Theme="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("Theme="))
                        {
                            theme = line.Substring(6).Trim();
                            break;
                        }
                    }
                }
            }
            
            Logger.Info($"Loading theme: {theme}");
            ApplyTheme(theme);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load theme", ex);
        }
    }
    
    public void ApplyTheme(string theme)
    {
        try
        {
            // Initialize textColor default
            var textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(212, 212, 212));

            if (theme == "DarkBlue")
            {
                // Dark Blue theme - pleasant blue colors
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(15, 25, 40));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 30, 45));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 35, 50));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 35, 50));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 30, 45));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 45, 65));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 90, 158));
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 35, 50));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 65, 90)); // Much brighter blue
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 50, 70));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 230, 240));
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 40, 55));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 90, 130));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 120, 170));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "DarkRed")
            {
                // Dark Red theme - pleasant red colors
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 15, 20));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 20, 25));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 30));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 30));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 20, 25));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(65, 30, 40));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(158, 0, 40));
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 30));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(90, 45, 55)); // Much brighter red
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(70, 35, 45));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(240, 220, 225));
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(55, 25, 35));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(130, 60, 80));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(170, 80, 110));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "LightPink")
            {
                // Light Pink theme - darker and more pink
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(200, 150, 180));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 165, 190));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 130, 160));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 130, 160));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 165, 190));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(170, 110, 150));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(199, 21, 133)); // Medium violet red
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 130, 160));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(230, 150, 190)); // Brighter pink
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(190, 140, 170));
                textColor = System.Windows.Media.Brushes.Black;
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 180, 200));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 120, 160));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(150, 90, 130));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "PastelBlue")
            {
                // Primo theme - gem-inspired with pink, purple, and cyan tones
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(230, 245, 255)); // Very light blue-white
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(210, 240, 255)); // Light cyan-blue
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 240, 250)); // Soft pink-white
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(245, 235, 255)); // Light lavender
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(245, 235, 255)); // Light lavender
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 200, 240)); // Bright pink hover
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 200, 255)); // Bright cyan-blue
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(235, 225, 255)); // Light purple
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(160, 230, 255)); // Cyan selected
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 220, 245)); // Pink hover
                textColor = System.Windows.Media.Brushes.Black;
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - gem-inspired with purple and cyan
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(235, 240, 250));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(150, 180, 230));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(100, 160, 255));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "ForestGreen")
            {
                // Forest Green theme - pleasant green colors
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 35, 25));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 45, 30));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 50, 35));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 50, 35));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 45, 30));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 70, 50));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(34, 139, 34)); // Forest green
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 50, 35));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 85, 60)); // Brighter green
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 65, 45));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(200, 230, 210));
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 55, 40));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(70, 120, 85));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(90, 150, 110));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "AMOLED")
            {
                // AMOLED theme - pure black with minimal color differences
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0)); // Pure black
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0)); // Pure black
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(10, 10, 10)); // Almost black
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(10, 10, 10)); // Almost black
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0, 0, 0)); // Pure black
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 25, 25)); // Very dark gray
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 20, 20)); // Very dark gray
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(10, 10, 10)); // Almost black
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 30, 30)); // Dark gray
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 20, 20)); // Very dark gray
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 180, 180)); // Light gray text
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - minimal contrast
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(15, 15, 15));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 40, 40));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 60, 60));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "Void")
            {
                // Void theme - deep blues and dark purples
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(10, 5, 20)); // Very dark purple
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(15, 10, 30)); // Dark purple
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 15, 40)); // Deep purple
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 15, 40)); // Deep purple
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(15, 10, 30)); // Dark purple
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 25, 60)); // Brighter purple
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 15, 80)); // Deep blue-purple
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(20, 15, 40)); // Deep purple
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(40, 30, 70)); // Brighter purple
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 20, 55)); // Medium purple
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(180, 170, 220)); // Light purple-gray
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - purple tinted
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 20, 45));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 50, 100));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 70, 130));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "VioletSorrow")
            {
                // Violet Sorrow theme - deep melancholic indigo with sorrowful violet accents
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(18, 10, 35)); // Very deep indigo
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 12, 42)); // Deep sorrowful indigo
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(28, 18, 52)); // Dark indigo
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(28, 18, 52)); // Dark indigo
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(22, 12, 42)); // Deep sorrowful indigo
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(55, 35, 95)); // Melancholic violet
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(65, 30, 120)); // Deep sorrowful violet
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(32, 20, 58)); // Dark indigo
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(75, 50, 115)); // Prominent violet
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 28, 75)); // Medium sorrowful violet
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(185, 170, 215)); // Muted violet-gray
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - deep sorrowful violet
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(28, 18, 52));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(70, 45, 110));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(95, 65, 145));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "OrangeBurnout")
            {
                // Orange Burnout theme - deep brown-orange backgrounds with vibrant burnt orange accents
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 15, 5)); // Very dark brown-orange
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(42, 20, 8)); // Deep brown-orange
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 10)); // Dark brown-orange
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 10)); // Dark brown-orange
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(42, 20, 8)); // Deep brown-orange
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(85, 35, 10)); // Burnt orange hover
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(204, 85, 0)); // Burnt orange
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 25, 10)); // Dark brown-orange
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(110, 45, 15)); // Brighter brown-orange
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(70, 30, 10)); // Medium brown-orange
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(255, 228, 209)); // Warm peach-white
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - intense burnt orange
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(55, 30, 15));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(150, 65, 0));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(190, 85, 0));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else if (theme == "PurpleGrief")
            {
                // Purple Grief theme - dark sorrowful violet palette
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 15, 30));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 20, 35));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 25, 40));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 25, 40));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 20, 35));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 40, 70));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(70, 40, 80));
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(35, 25, 40));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 50, 90));
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(55, 35, 65));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(220, 200, 230));
                
                this.Background = bgColor;
                
                if (TitleBar != null) TitleBar.Background = titleBarBg;
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                if (StatusBarBorder != null) StatusBarBorder.Background = statusBarBg;
                if (WelcomeScreen != null) WelcomeScreen.Background = editorBg;
                
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }

                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(25, 15, 30));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(60, 40, 70));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 50, 90));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            else
            {
                // Default Dark theme - current colors
                var bgColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 30, 30));
                var editorBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 30, 30));
                var titleBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(37, 37, 38));
                var menuBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(37, 37, 38));
                var menuItemBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(30, 30, 30));
                var menuItemHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(45, 45, 48));
                var statusBarBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(80, 80, 80)); // Gray status bar
                var tabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(37, 37, 38));
                var selectedTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(62, 62, 66)); // Much lighter gray
                var hoverTabBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(50, 50, 52));
                textColor = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(212, 212, 212));
                
                this.Background = bgColor;
                
                // Update title bar
                if (TitleBar != null)
                {
                    TitleBar.Background = titleBarBg;
                }
                
                // Update menu bar and menu items
                if (MenuBar != null)
                {
                    MenuBar.Background = menuBarBg;
                    UpdateMenuItemStyles(menuItemBg, menuItemHoverBg, textColor);
                }
                
                // Update status bar
                if (StatusBarBorder != null)
                {
                    StatusBarBorder.Background = statusBarBg;
                }
                
                // Update welcome screen
                if (WelcomeScreen != null)
                {
                    WelcomeScreen.Background = editorBg;
                }
                
                // Update tab control and tab styles
                if (EditorTabControl != null)
                {
                    EditorTabControl.Background = bgColor;
                    UpdateTabItemStyles(tabBg, selectedTabBg, hoverTabBg, textColor);
                    
                    // Update all existing editor tabs
                    foreach (TabItem tab in EditorTabControl.Items)
                    {
                        tab.Background = tabBg;
                        UpdateTabEditorColors(tab, editorBg, textColor);
                    }
                }
                
                // Update scrollbar colors - default dark theme
                var scrollTrackBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(62, 62, 66));
                var scrollThumbBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(104, 104, 104));
                var scrollThumbHoverBg = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(158, 158, 158));
                UpdateScrollBarStyles(scrollTrackBg, scrollThumbBg, scrollThumbHoverBg);
            }
            
            // Update folding marker colors
            UpdateFoldingColors(theme);
            
            // Update minimap colors
            System.Windows.Media.Color minimapBg;
            if (theme == "LightPink" || theme == "PastelBlue")
            {
                // Light themes: subtle dark tint
                minimapBg = System.Windows.Media.Color.FromArgb(20, 0, 0, 0);
            }
            else
            {
                // Dark themes: subtle white tint
                minimapBg = System.Windows.Media.Color.FromArgb(15, 255, 255, 255);
            }
            
            foreach (var tab in _tabs)
            {
                tab.MinimapRenderer?.SetBackgroundColor(minimapBg);
            }
            
            // Stylize minimap tooltip
            if (_minimapTooltip == null)
            {
                _minimapTooltip = new ToolTip 
                { 
                    StaysOpen = true,
                    IsHitTestVisible = false,
                    Padding = new Thickness(5)
                };
            }
            
            // Apply specific theme colors
            System.Windows.Media.Color tooltipBgColor;
            System.Windows.Media.Color tooltipFgColor;
            System.Windows.Media.Color tooltipBorderColor = System.Windows.Media.Colors.Gray;
            switch (theme)
            {
                case "DarkBlue":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(30, 45, 65);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(220, 230, 240);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(60, 80, 100);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 100, 200, 255); // Cyan-Blue
                    break;
                case "DarkRed":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(45, 25, 30);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(220, 180, 180);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(100, 60, 70);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 255, 100, 100); // Red
                    break;
                case "ForestGreen":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(35, 45, 35);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(180, 200, 180);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(60, 80, 60);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 100, 255, 100); // Green
                    break;
                case "AMOLED":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(10, 10, 10);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(180, 180, 180);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(40, 40, 40);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 220, 220, 220); // Silver
                    break;
                case "Void":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(15, 10, 30);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(180, 170, 220);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(60, 40, 100);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 180, 100, 255); // Purple
                    break;
                case "LightPink":
                    // More saturated pink (was 255, 230, 235)
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(255, 215, 225); 
                    tooltipFgColor = System.Windows.Media.Colors.Black;
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(200, 140, 160);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 255, 0, 128); // Hot Pink
                    break;
                case "PastelBlue":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(230, 240, 255);
                    tooltipFgColor = System.Windows.Media.Colors.Black;
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(150, 170, 200);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 0, 150, 255); // Deep Sky Blue
                    break;
                case "PurpleGrief":
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(35, 25, 45);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(220, 200, 230);
                    tooltipBorderColor = System.Windows.Media.Color.FromRgb(80, 50, 100);
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(80, 190, 159, 225); // Lavender-ish
                    break;
                default: // Default / Dark
                    tooltipBgColor = System.Windows.Media.Color.FromRgb(30, 30, 30);
                    tooltipFgColor = System.Windows.Media.Color.FromRgb(212, 212, 212);
                    tooltipBorderColor = System.Windows.Media.Colors.Gray;
                    _currentSearchHighlightColor = System.Windows.Media.Color.FromArgb(60, 255, 215, 0); // Gold/Yellow
                    break;
            }
            
            // Apply tooltip styles
            _minimapTooltip.Background = new SolidColorBrush(tooltipBgColor);
            _minimapTooltip.Foreground = new SolidColorBrush(tooltipFgColor);
            _minimapTooltip.BorderBrush = new SolidColorBrush(tooltipBorderColor);
            _minimapTooltip.BorderThickness = new Thickness(1);
            
            // Apply search highlight color to matching tabs
            foreach (var tab in _tabs)
            {
                 tab.SearchRenderer?.SetHighlightColor(_currentSearchHighlightColor);
            }
            
            // Update toolbar buttons
            UpdateToolbarButtons(textColor);
            
            Logger.Info($"Applied theme: {theme}");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to apply theme", ex);
        }
    }
    
    private void UpdateFoldingColors(string theme)
    {
        try
        {
            // Update folding colors for all open tabs
            foreach (var tab in _tabs)
            {
                if (tab.FoldingManager != null && tab.Editor != null)
                {
                    ApplyFoldingColorsToEditor(tab.Editor, theme);
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update folding colors", ex);
        }
    }
    
    private void ApplyFoldingColorsToEditor(TextEditor editor, string theme)
    {
        System.Windows.Media.Color markerColor, markerBgColor, selectedMarkerColor, selectedMarkerBgColor;
        
        if (theme == "DarkBlue")
        {
            markerColor = System.Windows.Media.Color.FromRgb(100, 140, 180);
            markerBgColor = System.Windows.Media.Color.FromRgb(25, 35, 50);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(140, 180, 220);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(35, 50, 70);
        }
        else if (theme == "DarkRed")
        {
            markerColor = System.Windows.Media.Color.FromRgb(180, 100, 120);
            markerBgColor = System.Windows.Media.Color.FromRgb(50, 25, 30);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(220, 140, 160);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(70, 35, 45);
        }
        else if (theme == "LightPink")
        {
            markerColor = System.Windows.Media.Color.FromRgb(120, 60, 100);
            markerBgColor = System.Windows.Media.Color.FromRgb(210, 165, 190);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(100, 40, 80);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(190, 145, 170);
        }
        else if (theme == "PastelBlue")
        {
            markerColor = System.Windows.Media.Color.FromRgb(60, 100, 140);
            markerBgColor = System.Windows.Media.Color.FromRgb(210, 240, 255);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(40, 80, 120);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(190, 220, 235);
        }
        else if (theme == "ForestGreen")
        {
            markerColor = System.Windows.Media.Color.FromRgb(100, 180, 140);
            markerBgColor = System.Windows.Media.Color.FromRgb(25, 45, 30);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(140, 220, 180);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(35, 60, 45);
        }
        else if (theme == "AMOLED")
        {
            markerColor = System.Windows.Media.Color.FromRgb(120, 120, 120);
            markerBgColor = System.Windows.Media.Color.FromRgb(0, 0, 0);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(180, 180, 180);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(20, 20, 20);
        }
        else if (theme == "Void")
        {
            markerColor = System.Windows.Media.Color.FromRgb(140, 120, 180);
            markerBgColor = System.Windows.Media.Color.FromRgb(15, 10, 30);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(180, 160, 220);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(25, 20, 50);
        }
        else if (theme == "VioletSorrow")
        {
            markerColor = System.Windows.Media.Color.FromRgb(150, 130, 190);
            markerBgColor = System.Windows.Media.Color.FromRgb(22, 12, 42);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(190, 170, 230);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(32, 22, 62);
        }
        else if (theme == "OrangeBurnout")
        {
            markerColor = System.Windows.Media.Color.FromRgb(180, 100, 50);
            markerBgColor = System.Windows.Media.Color.FromRgb(42, 20, 8);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(220, 140, 80);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(65, 35, 15);
        }
        else if (theme == "PurpleGrief")
        {
            markerColor = System.Windows.Media.Color.FromRgb(160, 140, 170);
            markerBgColor = System.Windows.Media.Color.FromRgb(30, 20, 35);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(200, 180, 210);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(50, 35, 60);
        }
        else // Default
        {
            markerColor = System.Windows.Media.Color.FromRgb(150, 150, 150);
            markerBgColor = System.Windows.Media.Color.FromRgb(30, 30, 30);
            selectedMarkerColor = System.Windows.Media.Color.FromRgb(200, 200, 200);
            selectedMarkerBgColor = System.Windows.Media.Color.FromRgb(50, 50, 50);
        }
        
        // Find the FoldingMargin in the TextArea's left margins
        foreach (var margin in editor.TextArea.LeftMargins)
        {
            if (margin is ICSharpCode.AvalonEdit.Folding.FoldingMargin foldingMargin)
            {
                foldingMargin.FoldingMarkerBrush = new System.Windows.Media.SolidColorBrush(markerColor);
                foldingMargin.FoldingMarkerBackgroundBrush = new System.Windows.Media.SolidColorBrush(markerBgColor);
                foldingMargin.SelectedFoldingMarkerBrush = new System.Windows.Media.SolidColorBrush(selectedMarkerColor);
                foldingMargin.SelectedFoldingMarkerBackgroundBrush = new System.Windows.Media.SolidColorBrush(selectedMarkerBgColor);
                break;
            }
        }
    }
    
    private void UpdateMenuItemStyles(SolidColorBrush menuItemBg, SolidColorBrush menuItemHoverBg, SolidColorBrush textColor)
    {
        try
        {
            // Create new MenuItem style
            var menuItemStyle = new Style(typeof(MenuItem));
            menuItemStyle.Setters.Add(new Setter(MenuItem.ForegroundProperty, textColor));
            menuItemStyle.Setters.Add(new Setter(MenuItem.BackgroundProperty, menuItemBg));
            menuItemStyle.Setters.Add(new Setter(MenuItem.PaddingProperty, new Thickness(8, 4, 8, 4)));
            menuItemStyle.Setters.Add(new Setter(MenuItem.BorderThicknessProperty, new Thickness(0, 0, 0, 0)));
            
            // Create control template
            var template = new ControlTemplate(typeof(MenuItem));
            
            // Create the template content using FrameworkElementFactory
            var borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.Name = "Border";
            borderFactory.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            borderFactory.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            borderFactory.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            
            var gridFactory = new FrameworkElementFactory(typeof(Grid));
            
            var col1 = new FrameworkElementFactory(typeof(ColumnDefinition));
            col1.SetValue(ColumnDefinition.WidthProperty, new GridLength(1, GridUnitType.Star));
            var col2 = new FrameworkElementFactory(typeof(ColumnDefinition));
            col2.SetValue(ColumnDefinition.WidthProperty, GridLength.Auto);
            gridFactory.AppendChild(col1);
            gridFactory.AppendChild(col2);
            
            var contentPresenter = new FrameworkElementFactory(typeof(ContentPresenter));
            contentPresenter.SetValue(Grid.ColumnProperty, 0);
            contentPresenter.SetValue(ContentPresenter.ContentSourceProperty, "Header");
            contentPresenter.SetBinding(ContentPresenter.MarginProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            contentPresenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            
            var textBlock = new FrameworkElementFactory(typeof(TextBlock));
            textBlock.SetValue(Grid.ColumnProperty, 1);
            textBlock.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("InputGestureText") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            textBlock.SetValue(TextBlock.MarginProperty, new Thickness(12, 0, 8, 0));
            textBlock.SetValue(TextBlock.ForegroundProperty, new SolidColorBrush(Color.FromRgb(128, 128, 128)));
            textBlock.SetValue(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center);
            
            var popup = new FrameworkElementFactory(typeof(System.Windows.Controls.Primitives.Popup));
            popup.Name = "PART_Popup";
            popup.SetValue(System.Windows.Controls.Primitives.Popup.PlacementProperty, System.Windows.Controls.Primitives.PlacementMode.Bottom);
            popup.SetBinding(System.Windows.Controls.Primitives.Popup.IsOpenProperty, new System.Windows.Data.Binding("IsSubmenuOpen") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            popup.SetValue(System.Windows.Controls.Primitives.Popup.AllowsTransparencyProperty, true);
            popup.SetValue(System.Windows.Controls.Primitives.Popup.FocusableProperty, false);
            
            var popupBorder = new FrameworkElementFactory(typeof(Border));
            popupBorder.SetValue(Border.BackgroundProperty, menuItemBg);
            popupBorder.SetValue(Border.BorderBrushProperty, new SolidColorBrush(Color.FromRgb(62, 62, 66)));
            popupBorder.SetValue(Border.BorderThicknessProperty, new Thickness(1));
            popupBorder.SetValue(Border.PaddingProperty, new Thickness(2));
            popupBorder.SetValue(Border.MinWidthProperty, 180.0);
            
            var itemsPresenter = new FrameworkElementFactory(typeof(ItemsPresenter));
            popupBorder.AppendChild(itemsPresenter);
            popup.AppendChild(popupBorder);
            
            gridFactory.AppendChild(contentPresenter);
            gridFactory.AppendChild(textBlock);
            gridFactory.AppendChild(popup);
            
            borderFactory.AppendChild(gridFactory);
            template.VisualTree = borderFactory;
            
            // Add triggers
            var highlightTrigger = new Trigger { Property = MenuItem.IsHighlightedProperty, Value = true };
            highlightTrigger.Setters.Add(new Setter(MenuItem.BackgroundProperty, menuItemHoverBg, "Border"));
            template.Triggers.Add(highlightTrigger);
            
            var disabledTrigger = new Trigger { Property = MenuItem.IsEnabledProperty, Value = false };
            disabledTrigger.Setters.Add(new Setter(MenuItem.ForegroundProperty, new SolidColorBrush(Color.FromRgb(101, 101, 101))));
            template.Triggers.Add(disabledTrigger);
            
            menuItemStyle.Setters.Add(new Setter(MenuItem.TemplateProperty, template));
            
            // Apply the style to the window resources
            this.Resources[typeof(MenuItem)] = menuItemStyle;
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update menu item styles", ex);
        }
    }
    
    private void UpdateTabItemStyles(SolidColorBrush tabBg, SolidColorBrush selectedTabBg, SolidColorBrush hoverTabBg, SolidColorBrush textColor)
    {
        try
        {
            // Create new TabItem style
            var tabItemStyle = new Style(typeof(TabItem));
            tabItemStyle.Setters.Add(new Setter(TabItem.BackgroundProperty, tabBg));
            tabItemStyle.Setters.Add(new Setter(TabItem.ForegroundProperty, textColor));
            tabItemStyle.Setters.Add(new Setter(TabItem.BorderThicknessProperty, new Thickness(0, 0, 0, 0)));
            tabItemStyle.Setters.Add(new Setter(TabItem.PaddingProperty, new Thickness(12, 6, 12, 6)));
            tabItemStyle.Setters.Add(new Setter(TabItem.FontSizeProperty, 13.0));
            
            // Create control template
            var template = new ControlTemplate(typeof(TabItem));
            
            var borderFactory = new FrameworkElementFactory(typeof(Border));
            borderFactory.Name = "Border";
            borderFactory.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            borderFactory.SetValue(Border.BorderThicknessProperty, new Thickness(0, 0, 0, 0));
            borderFactory.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            
            var stackPanelFactory = new FrameworkElementFactory(typeof(StackPanel));
            stackPanelFactory.SetValue(StackPanel.OrientationProperty, Orientation.Horizontal);
            
            var textBlockFactory = new FrameworkElementFactory(typeof(TextBlock));
            textBlockFactory.SetBinding(TextBlock.TextProperty, new System.Windows.Data.Binding("Header") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            textBlockFactory.SetBinding(TextBlock.ForegroundProperty, new System.Windows.Data.Binding("Foreground") { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            textBlockFactory.SetValue(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center);
            
            var buttonFactory = new FrameworkElementFactory(typeof(Button));
            buttonFactory.SetValue(Button.ContentProperty, "✕");
            buttonFactory.SetValue(Button.MarginProperty, new Thickness(8, 0, 0, 0));
            buttonFactory.SetValue(Button.BackgroundProperty, Brushes.Transparent);
            buttonFactory.SetValue(Button.ForegroundProperty, new SolidColorBrush(Color.FromRgb(204, 204, 204)));
            buttonFactory.SetValue(Button.BorderThicknessProperty, new Thickness(0, 0, 0, 0));
            buttonFactory.SetValue(Button.PaddingProperty, new Thickness(4, 0, 4, 0));
            buttonFactory.SetValue(Button.FontSizeProperty, 12.0);
            buttonFactory.AddHandler(Button.ClickEvent, new RoutedEventHandler(OnCloseTab));
            buttonFactory.SetBinding(Button.TagProperty, new System.Windows.Data.Binding() { RelativeSource = new System.Windows.Data.RelativeSource(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
            
            stackPanelFactory.AppendChild(textBlockFactory);
            stackPanelFactory.AppendChild(buttonFactory);
            borderFactory.AppendChild(stackPanelFactory);
            template.VisualTree = borderFactory;
            
            // Add triggers - order matters! More specific triggers should come last
            // Hover trigger (only when NOT selected)
            var hoverTrigger = new MultiTrigger();
            hoverTrigger.Conditions.Add(new Condition(TabItem.IsMouseOverProperty, true));
            hoverTrigger.Conditions.Add(new Condition(TabItem.IsSelectedProperty, false));
            hoverTrigger.Setters.Add(new Setter(TabItem.BackgroundProperty, hoverTabBg, "Border"));
            template.Triggers.Add(hoverTrigger);
            
            // Selected trigger (should override hover)
            var selectedTrigger = new Trigger { Property = TabItem.IsSelectedProperty, Value = true };
            selectedTrigger.Setters.Add(new Setter(TabItem.BackgroundProperty, selectedTabBg, "Border"));
            template.Triggers.Add(selectedTrigger);
            
            tabItemStyle.Setters.Add(new Setter(TabItem.TemplateProperty, template));
            
            // Apply the style to TabControl resources
            if (EditorTabControl.Resources.Contains(typeof(TabItem)))
            {
                EditorTabControl.Resources.Remove(typeof(TabItem));
            }
            EditorTabControl.Resources.Add(typeof(TabItem), tabItemStyle);
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update tab item styles", ex);
        }
    }
    
    private void UpdateScrollBarStyles(SolidColorBrush trackBg, SolidColorBrush thumbBg, SolidColorBrush thumbHoverBg)
    {
        try
        {
            // Update the dynamic resource brushes that the scrollbar styles reference
            this.Resources["ScrollBarTrackBrush"] = trackBg;
            this.Resources["ScrollBarThumbBrush"] = thumbBg;
            this.Resources["ScrollBarThumbHoverBrush"] = thumbHoverBg;
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update scrollbar styles", ex);
        }
    }
    
    private void UpdateToolbarButtons(SolidColorBrush foreground)
    {
        try
        {
            var buttons = new List<Control>
            {
                IconButton, ParticleButton, FindButton, ReplaceButton,
                ThemesButton, SettingsButton, AboutButton, 
                MaximizeButton, MinimizeButton, CloseButton
            };
            
            foreach (var btn in buttons)
            {
                if (btn != null)
                {
                    btn.Foreground = foreground;
                }
            }
            
            // Update TitleText if it exists (it's in the XAML with x:Name="TitleText")
            // We need to access it. Since it's in the visual tree and named, we can try to access it if generated or find it.
            // But wait, x:Name="TitleText" means it should be a field.
            if (TitleText != null)
            {
                TitleText.Foreground = foreground;
            }
            
            // Helper to update textblocks in buttons if they are not using direct content string
            // But here Content is string/unicode, so Foreground property inherits to ContentPresenter.
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to update toolbar button colors", ex);
        }
    }

    private void OnIconButtonClick(object sender, RoutedEventArgs e)
    {
        try
        {
            // If dialog exists and is open, close it
            if (_iconPanelDialog != null && _iconPanelDialog.IsVisible)
            {
                _iconPanelDialog.Close();
                _iconPanelDialog = null;
                Logger.Info("Closed icon panel dialog");
                if (IconButton != null) IconButton.IsChecked = false;
                return;
            }
            
            // Close particle panel if open
            if (_particlePanelDialog != null && _particlePanelDialog.IsVisible)
            {
                _particlePanelDialog.Close();
            }

            // Create and show new dialog
            Logger.Info("Opening icon panel dialog");
            _iconPanelDialog = new IconPanelDialog(IconButton, this)
            {
                Owner = this
            };
            _iconPanelDialog.Closed += (s, args) => 
            {
                _iconPanelDialog = null;
                if (IconButton != null) IconButton.IsChecked = false;
            };
            _iconPanelDialog.Show();
            if (IconButton != null) IconButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            if (IconButton != null) IconButton.IsChecked = false;
            Logger.Error("Failed to toggle icon panel dialog", ex);
            MessageBox.Show($"Failed to open panel: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void OnParticleButtonClick(object sender, RoutedEventArgs e)
    {
        try
        {
            // If dialog exists and is open, close it
            if (_particlePanelDialog != null && _particlePanelDialog.IsVisible)
            {
                _particlePanelDialog.Close();
                _particlePanelDialog = null;
                Logger.Info("Closed particle panel dialog");
                if (ParticleButton != null) ParticleButton.IsChecked = false;
                return;
            }
            
            // Close icon panel if open
            if (_iconPanelDialog != null && _iconPanelDialog.IsVisible)
            {
                _iconPanelDialog.Close();
            }

            // Create and show new dialog
            Logger.Info("Opening particle panel dialog");
            _particlePanelDialog = new ParticlePanelDialog(ParticleButton, this)
            {
                Owner = this
            };
            _particlePanelDialog.Closed += (s, args) => 
            {
                _particlePanelDialog = null;
                if (ParticleButton != null) ParticleButton.IsChecked = false;
            };
            _particlePanelDialog.Show();
            if (ParticleButton != null) ParticleButton.IsChecked = true;
        }
        catch (Exception ex)
        {
            if (ParticleButton != null) ParticleButton.IsChecked = false;
            Logger.Error("Failed to toggle particle panel dialog", ex);
            MessageBox.Show($"Failed to open panel: {ex.Message}", "Error",
                MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
    
    private void OnAbout(object sender, RoutedEventArgs e)
    {
        var aboutWindow = new AboutWindow
        {
            Owner = this
        };
        aboutWindow.ShowDialog();
    }
    
    // Zoom functionality
    private void LoadZoomLevel()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var prefsFile = Path.Combine(appDataPath, "RitoShark", "Jade", "preferences.txt");
            
            if (File.Exists(prefsFile))
            {
                var content = File.ReadAllText(prefsFile);
                if (content.Contains("ZoomLevel="))
                {
                    var lines = content.Split('\n');
                    foreach (var line in lines)
                    {
                        if (line.StartsWith("ZoomLevel="))
                        {
                            var zoomStr = line.Substring(10).Trim();
                            if (double.TryParse(zoomStr, out double zoom))
                            {
                                _zoomLevel = Math.Clamp(zoom, 50.0, 300.0);
                                Logger.Info($"Loaded zoom level: {_zoomLevel}%");
                            }
                            break;
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load zoom level", ex);
        }
    }
    
    private void SaveZoomLevel()
    {
        try
        {
            var appDataPath = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var jadeDir = Path.Combine(appDataPath, "RitoShark", "Jade");
            var prefsFile = Path.Combine(jadeDir, "preferences.txt");
            
            Directory.CreateDirectory(jadeDir);
            
            var lines = new List<string>();
            if (File.Exists(prefsFile))
            {
                var existingLines = File.ReadAllLines(prefsFile);
                foreach (var line in existingLines)
                {
                    if (!line.StartsWith("ZoomLevel="))
                    {
                        lines.Add(line);
                    }
                }
            }
            
            lines.Add($"ZoomLevel={_zoomLevel}");
            File.WriteAllLines(prefsFile, lines);
            
            Logger.Info($"Saved zoom level: {_zoomLevel}%");
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to save zoom level", ex);
        }
    }
    
    private double GetFontSizeFromZoom()
    {
        // Base font size is 14 at 100% zoom
        return 14.0 * (_zoomLevel / 100.0);
    }
    
    private void ApplyZoomToAllEditors()
    {
        var fontSize = GetFontSizeFromZoom();
        foreach (var tab in _tabs)
        {
            if (tab.Editor != null)
            {
                tab.Editor.FontSize = fontSize;
            }
        }
        UpdateZoomIndicator();
    }
    
    private void UpdateZoomIndicator()
    {
        if (ZoomLevel != null)
        {
            ZoomLevel.Text = $"{_zoomLevel:F0}%";
        }
    }
    
    private void OnEditorMouseWheel(object sender, MouseWheelEventArgs e)
    {
        if (sender is not TextEditor editor)
            return;
        
        // Zoom when Ctrl is pressed
        if (Keyboard.Modifiers == ModifierKeys.Control)
        {
            e.Handled = true;
            
            // Zoom in/out based on wheel direction
            if (e.Delta > 0)
            {
                // Zoom in
                _zoomLevel = Math.Min(_zoomLevel + 10, 300.0);
            }
            else
            {
                // Zoom out
                _zoomLevel = Math.Max(_zoomLevel - 10, 50.0);
            }
            
            ApplyZoomToAllEditors();
            SaveZoomLevel();
            
            Logger.Info($"Zoom level changed to: {_zoomLevel}%");
        }
        // Horizontal scroll when Shift is pressed
        else if (Keyboard.Modifiers == ModifierKeys.Shift)
        {
            e.Handled = true;
            
            var scrollViewer = FindScrollViewer(editor);
            if (scrollViewer != null)
            {
                // Scroll horizontally based on wheel direction
                double scrollAmount = 48.0; // Pixels to scroll
                
                if (e.Delta > 0)
                {
                    // Scroll left
                    scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset - scrollAmount);
                }
                else
                {
                    // Scroll right
                    scrollViewer.ScrollToHorizontalOffset(scrollViewer.HorizontalOffset + scrollAmount);
                }
            }
        }
    }
    
    private ScrollViewer? FindScrollViewer(DependencyObject element)
    {
        if (element is ScrollViewer scrollViewer)
            return scrollViewer;
        
        int childCount = VisualTreeHelper.GetChildrenCount(element);
        for (int i = 0; i < childCount; i++)
        {
            var child = VisualTreeHelper.GetChild(element, i);
            var result = FindScrollViewer(child);
            if (result != null)
                return result;
        }
        
        return null;
    }
    
    // Drag and Drop functionality
    private void OnDragEnter(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            DropOverlay.Visibility = Visibility.Visible;
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }
    
    private void OnDragOver(object sender, DragEventArgs e)
    {
        if (e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.Copy;
            DropOverlay.Visibility = Visibility.Visible;
        }
        else
        {
            e.Effects = DragDropEffects.None;
        }
        e.Handled = true;
    }
    
    private void OnDragLeave(object sender, DragEventArgs e)
    {
        DropOverlay.Visibility = Visibility.Collapsed;
        e.Handled = true;
    }
    
    private async void OnFileDrop(object sender, DragEventArgs e)
    {
        // Hide the drop overlay
        DropOverlay.Visibility = Visibility.Collapsed;
        
        try
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                string[] files = (string[])e.Data.GetData(DataFormats.FileDrop);
                
                if (files != null && files.Length > 0)
                {
                    Logger.Info($"Files dropped: {files.Length}");
                    
                    foreach (var filePath in files)
                    {
                        // Check if file exists
                        if (!File.Exists(filePath))
                        {
                            Logger.Info($"Dropped file does not exist: {filePath}");
                            continue;
                        }
                        
                        // Check file extension
                        var extension = Path.GetExtension(filePath).ToLower();
                        if (extension != ".bin" && extension != ".py" && extension != ".txt")
                        {
                            Logger.Info($"Unsupported file type: {extension}");
                            MessageBox.Show($"Unsupported file type: {extension}\n\nSupported types: .bin, .py, .txt", 
                                "Unsupported File", MessageBoxButton.OK, MessageBoxImage.Warning);
                            continue;
                        }
                        
                        Logger.Info($"Loading dropped file: {filePath}");
                        StatusText.Text = "Loading...";
                        
                        var content = await LoadFileContentAsync(filePath);
                        
                        StatusText.Text = "Rendering...";
                        await Task.Delay(10);
                        
                        CreateNewTab(filePath, content);
                        
                        FileTypeText.Text = extension.ToUpper();
                        StatusText.Text = $"Loaded: {Path.GetFileName(filePath)}";
                        
                        AddToRecentFiles(filePath);
                        Logger.Info($"File loaded successfully: {Path.GetFileName(filePath)}");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Error handling dropped files", ex);
            MessageBox.Show($"Error loading dropped file: {ex.Message}\n\nCheck log at: {Logger.GetLogPath()}", 
                "Error", MessageBoxButton.OK, MessageBoxImage.Error);
            StatusText.Text = "Error loading file";
        }
        
        e.Handled = true;
    }
    private void InitializePerformanceMonitoring()
    {
        try
        {
            var processName = Process.GetCurrentProcess().ProcessName;
            // Use "Working Set - Private" to match Task Manager's "Memory" column
            _ramCounter = new PerformanceCounter("Process", "Working Set - Private", processName);
            
            _perfTimer = new System.Windows.Threading.DispatcherTimer();
            _perfTimer.Interval = TimeSpan.FromSeconds(1);
            _perfTimer.Tick += OnPerfTimerTick;
            _perfTimer.Start();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to initialize performance monitoring", ex);
            if (RamUsageText != null) RamUsageText.Text = "RAM: N/A";
        }
    }

    private void OnPerfTimerTick(object? sender, EventArgs e)
    {
        try
        {
            if (_ramCounter != null)
            {
                var bytes = _ramCounter.NextValue();
                var mb = bytes / 1024.0 / 1024.0;
                if (RamUsageText != null)
                {
                    RamUsageText.Text = $"{mb:F1} MB";
                }
            }
        }
        catch 
        {
            // Ignore temporary counter errors
        }
    }
}
